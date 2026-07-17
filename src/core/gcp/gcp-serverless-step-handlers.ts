import { execFile } from 'child_process';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { Octokit } from '@octokit/rest';
import type {
  StepHandler,
  StepHandlerContext,
  StepHandlerResult,
} from '../../provisioning/step-handler-registry.js';
import type { ProvisioningPlan } from '../../provisioning/graph.types.js';
import {
  gcpRequest,
  GcpHttpError,
  checkBillingEnabled,
  enableProjectService,
  getGcpProjectNumber,
  getIamPolicy,
  linkBillingAccount,
  setIamPolicy,
} from './gcp-api-client.js';
import { getStoredGcpProjectId } from './gcp-credentials.js';
import { HttpGitHubApiClient } from '../../providers/github.js';
import { HttpCloudflareApiClient } from '../../providers/cloudflare.js';
import { resolveDeployContractFromInputs } from '../../studio/deploy-contract.js';

const execFileAsync = promisify(execFile);

function makeLog(stepKey: string, projectId: string): (msg: string) => void {
  return (msg) => console.log(`[gcp-serverless:${stepKey}] project="${projectId}" | ${msg}`);
}

function requireGcpProjectId(context: StepHandlerContext): string {
  const fromVault = getStoredGcpProjectId(context.credentialService, context.projectId)?.trim();
  const fromUpstream = context.upstreamArtifacts['gcp_project_id']?.trim();
  const projectId = fromVault || fromUpstream;
  if (!projectId) {
    throw new Error('No GCP project id found. Complete firebase:create-gcp-project first.');
  }
  return projectId;
}

function resourceSlug(context: StepHandlerContext): string {
  const project = context.projectManager.getProject(context.projectId).project;
  return (project.slug || context.projectId).trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

function regionForContext(context: StepHandlerContext): string {
  return (
    context.userInputs?.['region']?.trim() ||
    context.upstreamArtifacts['gcp_region']?.trim() ||
    'us-central1'
  );
}

function githubDeployInputsForContext(context: StepHandlerContext): Record<string, string> | undefined {
  const plan = context.projectManager.loadPlan(context.projectId) as ProvisioningPlan | null;
  return plan?.nodeStates.get('github:deploy-workflows')?.userInputs ?? context.userInputs;
}

function normalizeBillingAccountName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return trimmed.startsWith('billingAccounts/')
    ? trimmed
    : `billingAccounts/${trimmed}`;
}

function readGitHubToken(context: StepHandlerContext): string | undefined {
  return context.credentialService.retrieveOrgCredential('github_pat')?.trim();
}

function parseGitHubRepoUrl(url: string): { owner: string; repo: string } | null {
  const cleaned = url.trim().replace(/\.git$/i, '');
  const match = cleaned.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\/|$)/i);
  if (!match) return null;
  return { owner: match[1]!, repo: match[2]! };
}

function requireGithubRepoTarget(context: StepHandlerContext): { owner: string; repo: string } {
  const repoUrl = context.upstreamArtifacts['github_repo_url']?.trim();
  if (!repoUrl) {
    throw new Error('Missing github_repo_url. Complete github:create-repository and github:deploy-workflows first.');
  }
  const parsed = parseGitHubRepoUrl(repoUrl);
  if (!parsed) {
    throw new Error(`Invalid github_repo_url "${repoUrl}".`);
  }
  return parsed;
}

function parseArtifactRegistryRepoName(artifactRegistryRepo: string): string {
  const parts = artifactRegistryRepo.trim().split('/');
  if (parts.length < 3) {
    throw new Error(
      `Invalid artifact_registry_repo "${artifactRegistryRepo}". Expected "<region>-docker.pkg.dev/<project>/<repo>".`,
    );
  }
  return parts[2]!;
}

async function listWorkflowFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<string[]> {
  try {
    const workflows = await octokit.repos.getContent({ owner, repo, path: '.github/workflows' });
    return Array.isArray(workflows.data) ? workflows.data.map((entry) => entry.name) : [];
  } catch {
    return [];
  }
}

async function readWorkflowFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  workflowFile: string,
): Promise<string | null> {
  try {
    const response = await octokit.repos.getContent({ owner, repo, path: `.github/workflows/${workflowFile}` });
    if (Array.isArray(response.data)) return null;
    const fileData = response.data as { type?: string; encoding?: string; content?: string };
    if (fileData.type !== 'file') return null;
    const encoding = fileData.encoding;
    const rawContent = fileData.content ?? '';
    return encoding === 'base64'
      ? Buffer.from(rawContent, 'base64').toString('utf8')
      : rawContent;
  } catch {
    return null;
  }
}

async function upsertRepoVariable(
  octokit: Octokit,
  owner: string,
  repo: string,
  name: string,
  value: string,
): Promise<void> {
  try {
    await octokit.request('PATCH /repos/{owner}/{repo}/actions/variables/{name}', {
      owner,
      repo,
      name,
      value,
    });
  } catch (err) {
    if ((err as { status?: number })?.status !== 404) throw err;
    await octokit.request('POST /repos/{owner}/{repo}/actions/variables', {
      owner,
      repo,
      name,
      value,
    });
  }
}

async function ensureWorkloadIdentityPool(
  token: string,
  projectNumber: string,
  poolId: string,
): Promise<void> {
  const poolPath = `/v1/projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}`;
  try {
    await gcpRequest('GET', 'iam.googleapis.com', poolPath, token);
    return;
  } catch (err) {
    if (!(err instanceof GcpHttpError) || err.statusCode !== 404) throw err;
  }

  await gcpRequest(
    'POST',
    'iam.googleapis.com',
    `/v1/projects/${projectNumber}/locations/global/workloadIdentityPools?workloadIdentityPoolId=${encodeURIComponent(poolId)}`,
    token,
    JSON.stringify({
      displayName: 'Studio GitHub Deploy Pool',
      description: 'Workload identity pool for Studio-managed GitHub Actions deployments.',
    }),
  );
}

async function ensureWorkloadIdentityProvider(
  token: string,
  projectNumber: string,
  poolId: string,
  providerId: string,
  owner: string,
  repo: string,
): Promise<string> {
  const providerPath = `/v1/projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}/providers/${providerId}`;
  const providerResource = `projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}/providers/${providerId}`;
  try {
    await gcpRequest('GET', 'iam.googleapis.com', providerPath, token);
    return providerResource;
  } catch (err) {
    if (!(err instanceof GcpHttpError) || err.statusCode !== 404) throw err;
  }

  const providerDisplayName = `Studio GHA ${owner}/${repo}`.slice(0, 32).trimEnd();
  await gcpRequest(
    'POST',
    'iam.googleapis.com',
    `/v1/projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}/providers?workloadIdentityPoolProviderId=${encodeURIComponent(providerId)}`,
    token,
    JSON.stringify({
      displayName: providerDisplayName,
      description: 'OIDC trust provider for GitHub Actions.',
      attributeMapping: {
        'google.subject': 'assertion.sub',
        'attribute.actor': 'assertion.actor',
        'attribute.ref': 'assertion.ref',
        'attribute.repository': 'assertion.repository',
        'attribute.repository_owner': 'assertion.repository_owner',
      },
      attributeCondition: `assertion.repository=="${owner}/${repo}"`,
      oidc: { issuerUri: 'https://token.actions.githubusercontent.com' },
    }),
  );
  return providerResource;
}

async function ensureServiceAccountImpersonationBinding(
  token: string,
  targetServiceAccountEmail: string,
  principalMember: string,
): Promise<void> {
  const encodedEmail = encodeURIComponent(targetServiceAccountEmail);
  const policyRes = await gcpRequest(
    'POST',
    'iam.googleapis.com',
    `/v1/projects/-/serviceAccounts/${encodedEmail}:getIamPolicy`,
    token,
    JSON.stringify({}),
  );
  const parsed = JSON.parse(policyRes.body) as { bindings?: Array<{ role: string; members: string[] }>; etag?: string };
  const bindings = (parsed.bindings ?? []).map((binding) => ({ role: binding.role, members: [...binding.members] }));
  const role = 'roles/iam.workloadIdentityUser';
  const existing = bindings.find((binding) => binding.role === role);
  if (existing) {
    if (!existing.members.includes(principalMember)) existing.members.push(principalMember);
  } else {
    bindings.push({ role, members: [principalMember] });
  }

  await gcpRequest(
    'POST',
    'iam.googleapis.com',
    `/v1/projects/-/serviceAccounts/${encodedEmail}:setIamPolicy`,
    token,
    JSON.stringify({ policy: { bindings, etag: parsed.etag } }),
  );
}

async function ensureCloudBuildSourceBucket(
  token: string,
  projectId: string,
  region: string,
): Promise<string> {
  const bucket = `${projectId}_cloudbuild`;
  const bucketPath = `/storage/v1/b/${encodeURIComponent(bucket)}`;
  try {
    await gcpRequest('GET', 'storage.googleapis.com', bucketPath, token);
    return bucket;
  } catch (err) {
    if (!(err instanceof GcpHttpError) || err.statusCode !== 404) throw err;
  }

  try {
    await gcpRequest(
      'POST',
      'storage.googleapis.com',
      `/storage/v1/b?project=${encodeURIComponent(projectId)}`,
      token,
      JSON.stringify({
        name: bucket,
        location: region.toUpperCase(),
        iamConfiguration: { uniformBucketLevelAccess: { enabled: true } },
      }),
    );
    return bucket;
  } catch (err) {
    if (err instanceof GcpHttpError && err.statusCode === 403) {
      throw new Error(
        `Cloud Build source bucket "${bucket}" is missing and could not be created automatically. ` +
        `Grant storage.buckets.create on project "${projectId}" to the signed-in Google user, or create the bucket manually, then retry.`,
      );
    }
    throw err;
  }
}

async function gcpExists(args: string[], log: (msg: string) => void): Promise<boolean> {
  try {
    await runCommand('gcloud', args, process.cwd(), log);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  log: (msg: string) => void,
): Promise<string> {
  log(`→ ${command} ${args.join(' ')}`);
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd,
    env: process.env,
    maxBuffer: 1024 * 1024 * 10,
  });
  if (stderr.trim()) {
    log(`stderr: ${stderr.trim()}`);
  }
  return stdout.trim();
}

async function smokeCheck(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = https.get(url, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 200 && status < 400) {
        resolve();
        return;
      }
      reject(new Error(`Smoke check failed for ${url} with status ${status}`));
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error(`Smoke check timed out for ${url}`)));
  });
}

/** Get the live URL of a deployed Cloud Run service. */
async function getCloudRunServiceUrl(
  service: string,
  region: string,
  projectId: string,
  log: (msg: string) => void,
): Promise<string> {
  const url = await runCommand(
    'gcloud',
    ['run', 'services', 'describe', service, '--region', region, '--project', projectId, '--platform', 'managed', '--format=value(status.url)'],
    process.cwd(),
    log,
  );
  return url.trim();
}

/**
 * Serverless delivery steps require explicit execution.
 * - sync: return null → sync does not auto-mark these complete.
 * - validate: return reconciled=false unless a real validateFn is provided.
 */
function simpleHandler(
  stepKey: string,
  requiredAuth: string | undefined,
  createFn: (context: StepHandlerContext) => Promise<StepHandlerResult>,
  validateFn?: (context: StepHandlerContext) => Promise<StepHandlerResult>,
  deleteFn?: (context: StepHandlerContext) => Promise<StepHandlerResult>,
): StepHandler {
  return {
    stepKey,
    requiredAuth,
    create: createFn,
    validate:
      validateFn ??
      (async () => ({
        reconciled: false,
        message: 'Requires explicit deployment execution.',
      })),
    sync: async (context) => (validateFn ? validateFn(context) : null),
    delete: deleteFn ?? (async () => ({ reconciled: true })),
  };
}

// ---------------------------------------------------------------------------
// GCP core setup steps
// ---------------------------------------------------------------------------

const resolveProjectContextHandler = simpleHandler(
  'gcp:resolve-project-context',
  'gcp',
  async (context) => {
    const gcpProjectId = requireGcpProjectId(context);
    const region = regionForContext(context);
    return {
      reconciled: true,
      resourcesProduced: { gcp_project_id: gcpProjectId, gcp_region: region },
      message: 'Resolved project context.',
    };
  },
  async (context) => {
    const gcpProjectId = getStoredGcpProjectId(context.credentialService, context.projectId)?.trim()
      || context.upstreamArtifacts['gcp_project_id']?.trim();
    if (!gcpProjectId) {
      return { reconciled: false, message: 'GCP project ID not stored. Complete firebase:create-gcp-project first.' };
    }
    return {
      reconciled: true,
      resourcesProduced: { gcp_project_id: gcpProjectId, gcp_region: regionForContext(context) },
    };
  },
);

const prepareRuntimeFoundationHandler = simpleHandler(
  'gcp:prepare-runtime-foundation',
  'gcp',
  async (context) => {
    const log = makeLog('gcp:prepare-runtime-foundation', context.projectId);
    if (!context.hasToken('gcp')) {
      return {
        reconciled: false,
        suggestsReauth: true,
        message: 'No stored GCP OAuth session. Sign in with Google before preparing runtime foundation.',
      };
    }
    const gcpProjectId = requireGcpProjectId(context);
    const token = await context.getToken('gcp');
    const billingAccountFromUpstream = context.upstreamArtifacts['gcp_billing_account_id']?.trim();
    const billingAccountFromInputs = context.userInputs?.['gcp_billing_account_id']?.trim();
    const billingAccountName = normalizeBillingAccountName(
      billingAccountFromUpstream || billingAccountFromInputs || '',
    );

    let { enabled } = await checkBillingEnabled(token, gcpProjectId);
    if (!enabled && billingAccountName) {
      log(`→ linking billing account "${billingAccountName}" to "${gcpProjectId}"...`);
      await linkBillingAccount(token, gcpProjectId, billingAccountName);
      ({ enabled } = await checkBillingEnabled(token, gcpProjectId));
    }

    if (!enabled) {
      return {
        reconciled: false,
        message: `Billing is not enabled for project "${gcpProjectId}". Provide gcp_billing_account_id in user:setup-gcp-billing, then re-run this step.`,
      };
    }
    await enableProjectService(gcpProjectId, token, 'run.googleapis.com');
    await enableProjectService(gcpProjectId, token, 'cloudbuild.googleapis.com');
    log(`✓ runtime foundation ready for ${gcpProjectId}`);
    return { reconciled: true, resourcesProduced: { gcp_foundation_ready: 'true' } };
  },
  async (context) => {
    if (!context.hasToken('gcp')) {
      return { reconciled: false, suggestsReauth: true, message: 'No stored GCP OAuth session.' };
    }
    const gcpProjectId = requireGcpProjectId(context);
    const token = await context.getToken('gcp');
    const { enabled } = await checkBillingEnabled(token, gcpProjectId);
    return enabled
      ? { reconciled: true, resourcesProduced: { gcp_foundation_ready: 'true' } }
      : { reconciled: false, message: `Billing not enabled for "${gcpProjectId}".` };
  },
);

const ensureArtifactRegistryHandler = simpleHandler(
  'gcp:ensure-artifact-registry',
  'gcp',
  async (context) => {
    const log = makeLog('gcp:ensure-artifact-registry', context.projectId);
    const projectId = requireGcpProjectId(context);
    const region = regionForContext(context);
    const repo = context.userInputs?.['repository']?.trim() || 'studio-serverless';
    const token = await context.getToken('gcp');

    await enableProjectService(projectId, token, 'artifactregistry.googleapis.com');

    const repoPath = `/v1/projects/${projectId}/locations/${region}/repositories/${repo}`;
    try {
      await gcpRequest('GET', 'artifactregistry.googleapis.com', repoPath, token);
    } catch {
      await gcpRequest(
        'POST',
        'artifactregistry.googleapis.com',
        `/v1/projects/${projectId}/locations/${region}/repositories?repositoryId=${encodeURIComponent(repo)}`,
        token,
        JSON.stringify({ format: 'DOCKER', description: 'Studio serverless delivery images' }),
      );
    }
    log(`✓ ensured artifact repository ${repo}`);
    return {
      reconciled: true,
      resourcesProduced: {
        artifact_registry_repo: `${region}-docker.pkg.dev/${projectId}/${repo}`,
      },
    };
  },
  async (context) => {
    const projectId = requireGcpProjectId(context);
    const region = regionForContext(context);
    const repo = context.userInputs?.['repository']?.trim() || 'studio-serverless';
    const token = await context.getToken('gcp');
    try {
      await gcpRequest('GET', 'artifactregistry.googleapis.com', `/v1/projects/${projectId}/locations/${region}/repositories/${repo}`, token);
      return { reconciled: true, resourcesProduced: { artifact_registry_repo: `${region}-docker.pkg.dev/${projectId}/${repo}` } };
    } catch (err) {
      if (err instanceof GcpHttpError && err.statusCode === 404) {
        return { reconciled: false, message: `Artifact Registry repo "${repo}" not found. Re-run provisioning.` };
      }
      throw err;
    }
  },
);

const ensureRuntimeServiceAccountHandler = simpleHandler(
  'gcp:ensure-runtime-service-account',
  'gcp',
  async (context) => {
    const projectId = requireGcpProjectId(context);
    const token = await context.getToken('gcp');
    const accountId = `studio-runtime-${resourceSlug(context).slice(0, 20)}`;
    const email = `${accountId}@${projectId}.iam.gserviceaccount.com`;

    try {
      await gcpRequest('GET', 'iam.googleapis.com', `/v1/projects/-/serviceAccounts/${encodeURIComponent(email)}`, token);
    } catch {
      await gcpRequest(
        'POST',
        'iam.googleapis.com',
        `/v1/projects/${projectId}/serviceAccounts`,
        token,
        JSON.stringify({ accountId, serviceAccount: { displayName: `Studio runtime ${context.projectId}` } }),
      );
    }

    return { reconciled: true, resourcesProduced: { runtime_service_account_email: email } };
  },
  async (context) => {
    const projectId = requireGcpProjectId(context);
    const token = await context.getToken('gcp');
    const accountId = `studio-runtime-${resourceSlug(context).slice(0, 20)}`;
    const email = `${accountId}@${projectId}.iam.gserviceaccount.com`;
    try {
      await gcpRequest('GET', 'iam.googleapis.com', `/v1/projects/-/serviceAccounts/${encodeURIComponent(email)}`, token);
      return { reconciled: true, resourcesProduced: { runtime_service_account_email: email } };
    } catch (err) {
      if (err instanceof GcpHttpError && err.statusCode === 404) {
        return { reconciled: false, message: `Runtime service account "${email}" not found. Re-run provisioning.` };
      }
      throw err;
    }
  },
);

const ensureSecretManagerBindingsHandler = simpleHandler(
  'gcp:ensure-secret-manager-bindings',
  'gcp',
  async (context) => {
    const projectId = requireGcpProjectId(context);
    const token = await context.getToken('gcp');
    const secretId = `${resourceSlug(context)}-runtime-config`;
    const secretPath = `/v1/projects/${projectId}/secrets/${secretId}`;
    const saEmail = context.upstreamArtifacts['runtime_service_account_email']?.trim();

    await enableProjectService(projectId, token, 'secretmanager.googleapis.com');

    try {
      await gcpRequest('GET', 'secretmanager.googleapis.com', secretPath, token);
    } catch {
      await gcpRequest(
        'POST',
        'secretmanager.googleapis.com',
        `/v1/projects/${projectId}/secrets?secretId=${encodeURIComponent(secretId)}`,
        token,
        JSON.stringify({ replication: { automatic: {} } }),
      );
    }

    const payload = Buffer.from(
      JSON.stringify({ projectId: context.projectId, updatedAt: new Date().toISOString() }),
      'utf8',
    ).toString('base64');
    await gcpRequest(
      'POST',
      'secretmanager.googleapis.com',
      `${secretPath}:addVersion`,
      token,
      JSON.stringify({ payload: { data: payload } }),
    );

    if (saEmail) {
      const getPolicy = await gcpRequest('GET', 'secretmanager.googleapis.com', `${secretPath}:getIamPolicy`, token);
      const parsed = JSON.parse(getPolicy.body) as { bindings?: Array<{ role: string; members: string[] }> };
      const member = `serviceAccount:${saEmail}`;
      const role = 'roles/secretmanager.secretAccessor';
      const bindings = parsed.bindings ?? [];
      const existing = bindings.find((b) => b.role === role);
      if (existing) {
        if (!existing.members.includes(member)) existing.members.push(member);
      } else {
        bindings.push({ role, members: [member] });
      }
      await gcpRequest('POST', 'secretmanager.googleapis.com', `${secretPath}:setIamPolicy`, token, JSON.stringify({ policy: { bindings } }));
    }

    return { reconciled: true, resourcesProduced: { secret_manager_bindings: 'configured' } };
  },
  async (context) => {
    const projectId = requireGcpProjectId(context);
    const token = await context.getToken('gcp');
    const secretId = `${resourceSlug(context)}-runtime-config`;
    try {
      await gcpRequest('GET', 'secretmanager.googleapis.com', `/v1/projects/${projectId}/secrets/${secretId}`, token);
      return { reconciled: true, resourcesProduced: { secret_manager_bindings: 'configured' } };
    } catch (err) {
      if (err instanceof GcpHttpError && err.statusCode === 404) {
        return { reconciled: false, message: `Secret "${secretId}" not found in Secret Manager. Re-run provisioning.` };
      }
      throw err;
    }
  },
);

const setupObservabilityBaselineHandler = simpleHandler(
  'gcp:setup-observability-baseline',
  'gcp',
  async (context) => {
    const projectId = requireGcpProjectId(context);
    const token = await context.getToken('gcp');
    const metricName = `${resourceSlug(context)}_http_5xx_count`;
    try {
      await gcpRequest(
        'POST',
        'logging.googleapis.com',
        `/v2/projects/${projectId}/metrics`,
        token,
        JSON.stringify({
          name: metricName,
          description: 'Studio managed metric for Cloud Run 5xx responses',
          filter: 'resource.type="cloud_run_revision" AND httpRequest.status>=500',
        }),
      );
    } catch (err) {
      if (err instanceof GcpHttpError && (err.statusCode === 409 || err.body.includes('ALREADY_EXISTS'))) {
        // metric already exists — idempotent
      } else {
        throw err;
      }
    }
    return { reconciled: true, resourcesProduced: { gcp_observability_ready: 'true' } };
  },
  async (context) => {
    const projectId = requireGcpProjectId(context);
    const token = await context.getToken('gcp');
    const metricName = `${resourceSlug(context)}_http_5xx_count`;
    try {
      await gcpRequest('GET', 'logging.googleapis.com', `/v2/projects/${projectId}/metrics/${encodeURIComponent(metricName)}`, token);
      return { reconciled: true, resourcesProduced: { gcp_observability_ready: 'true' } };
    } catch (err) {
      if (err instanceof GcpHttpError && err.statusCode === 404) {
        return { reconciled: false, message: 'Observability metric not yet created. Re-run provisioning.' };
      }
      throw err;
    }
  },
);

// ---------------------------------------------------------------------------
// API backend deployment steps
// ---------------------------------------------------------------------------

const apiBuildContainerHandler = simpleHandler(
  'api:build-container',
  undefined,
  async (context) => {
    const log = makeLog('api:build-container', context.projectId);
    const projectId = requireGcpProjectId(context);
    const region = regionForContext(context);
    const repo = context.upstreamArtifacts['artifact_registry_repo']?.trim()
      || `${region}-docker.pkg.dev/${projectId}/studio-serverless`;
    const image = `${repo}/${resourceSlug(context)}-api:${Date.now()}`;
    const cwd = process.cwd();
    const contract = resolveDeployContractFromInputs(githubDeployInputsForContext(context));
    const dockerfilePath = path.join(cwd, contract.api.dockerfile);
    const buildContextPath = path.join(cwd, contract.api.buildContext);

    if (!fs.existsSync(dockerfilePath)) {
      return {
        reconciled: false,
        message: `No Dockerfile found at "${contract.api.dockerfile}". Add the API Dockerfile or update deploy_api_dockerfile.`,
      };
    }
    if (!fs.existsSync(buildContextPath)) {
      return {
        reconciled: false,
        message: `No Docker build context found at "${contract.api.buildContext}". Add the directory or update deploy_api_build_context.`,
      };
    }

    const cloudBuildConfig = {
      steps: [
        {
          name: 'gcr.io/cloud-builders/docker',
          args: [
            'build',
            '-f',
            contract.api.dockerfile,
            '-t',
            image,
            contract.api.buildContext,
          ],
        },
      ],
      images: [image],
    };
    const configPath = path.join(os.tmpdir(), `studio-cloudbuild-${context.projectId}-${Date.now()}.json`);
    fs.writeFileSync(configPath, JSON.stringify(cloudBuildConfig, null, 2));
    try {
      await runCommand(
        'gcloud',
        ['builds', 'submit', '.', '--config', configPath, '--project', projectId, '--quiet'],
        cwd,
        log,
      );
    } finally {
      fs.rmSync(configPath, { force: true });
    }

    return { reconciled: true, resourcesProduced: { api_image_uri: image } };
  },
);

const apiDeployCloudRunHandler = simpleHandler(
  'api:deploy-cloud-run',
  undefined,
  async (context) => {
    const log = makeLog('api:deploy-cloud-run', context.projectId);
    const projectId = requireGcpProjectId(context);
    const region = regionForContext(context);
    const image = context.upstreamArtifacts['api_image_uri']?.trim()
      || context.upstreamArtifacts['api_pushed_image_uri']?.trim();
    const runtimeSa = context.upstreamArtifacts['runtime_service_account_email']?.trim();
    if (!image) return { reconciled: false, message: 'Missing built image for deployment.' };
    const service = `${resourceSlug(context)}-api`;
    const args = [
      'run', 'deploy', service,
      '--image', image,
      '--region', region,
      '--project', projectId,
      '--platform', 'managed',
      '--quiet',
    ];
    if (runtimeSa) args.push('--service-account', runtimeSa);
    args.push('--allow-unauthenticated');
    await runCommand('gcloud', args, process.cwd(), log);
    const serviceUrl = await getCloudRunServiceUrl(service, region, projectId, log);
    return {
      reconciled: true,
      resourcesProduced: {
        api_cloud_run_service: service,
        api_cloud_run_url: serviceUrl,
      },
    };
  },
);

const apiRunSmokeCheckHandler = simpleHandler(
  'api:run-smoke-check',
  undefined,
  async (context) => {
    const base = context.upstreamArtifacts['api_cloud_run_url']?.trim();
    if (!base) return { reconciled: false, message: 'Missing api_cloud_run_url for smoke check.' };
    const healthPath = resolveDeployContractFromInputs(githubDeployInputsForContext(context)).api.healthPath || '/api/health';
    const url = `${base.replace(/\/+$/, '')}${healthPath}`;
    await smokeCheck(url);
    return { reconciled: true, resourcesProduced: { api_smoke_check_passed: 'true' } };
  },
);

const apiPromoteTrafficHandler = simpleHandler(
  'api:promote-traffic',
  undefined,
  async (context) => {
    const projectId = requireGcpProjectId(context);
    const region = regionForContext(context);
    const service = context.upstreamArtifacts['api_cloud_run_service']?.trim() || `${resourceSlug(context)}-api`;
    await runCommand(
      'gcloud',
      ['run', 'services', 'update-traffic', service, '--to-latest', '--region', region, '--project', projectId, '--platform', 'managed', '--quiet'],
      process.cwd(),
      makeLog('api:promote-traffic', context.projectId),
    );
    return { reconciled: true, resourcesProduced: { api_active_revision: 'latest' } };
  },
);

const apiRollbackRevisionHandler = simpleHandler(
  'api:rollback-revision',
  undefined,
  async (context) => {
    const projectId = requireGcpProjectId(context);
    const region = regionForContext(context);
    const service = context.upstreamArtifacts['api_cloud_run_service']?.trim() || `${resourceSlug(context)}-api`;
    const log = makeLog('api:rollback-revision', context.projectId);
    const revisions = await runCommand(
      'gcloud',
      ['run', 'revisions', 'list', '--service', service, '--region', region, '--project', projectId, '--platform', 'managed', '--sort-by=~metadata.creationTimestamp', '--format=value(metadata.name)', '--limit=2'],
      process.cwd(),
      log,
    );
    const items = revisions.split('\n').map((v) => v.trim()).filter(Boolean);
    if (items.length < 2) {
      return { reconciled: false, message: 'No previous revision available for rollback.' };
    }
    const target = items[1]!;
    await runCommand(
      'gcloud',
      ['run', 'services', 'update-traffic', service, `--to-revisions=${target}=100`, '--region', region, '--project', projectId, '--platform', 'managed', '--quiet'],
      process.cwd(),
      log,
    );
    return { reconciled: true, resourcesProduced: { api_rollback_revision: target } };
  },
);

const apiBindDomainSslHandler = simpleHandler(
  'api:bind-domain-ssl',
  undefined,
  async (context) => {
    const log = makeLog('api:bind-domain-ssl', context.projectId);
    const gcpProjectId = requireGcpProjectId(context);
    const region = regionForContext(context);
    const slug = resourceSlug(context);

    const cfToken = (
      context.credentialService?.retrieveCredential(context.projectId, 'cloudflare_token') ||
      context.credentialService?.retrieveCredential('__organization__', 'cloudflare_token')
    )?.trim();
    if (!cfToken) return { reconciled: false, message: 'No Cloudflare token found. Complete user:provide-cloudflare-token before binding the API domain.' };
    const zoneId = context.upstreamArtifacts['cloudflare_zone_id']?.trim();
    const zoneDomain = context.upstreamArtifacts['cloudflare_zone_domain']?.trim();
    if (!zoneId || !zoneDomain) return { reconciled: false, message: 'Missing Cloudflare zone info. Complete cloudflare:add-domain-zone before binding the API domain.' };
    const apiDomain = context.userInputs?.['api_domain']?.trim() || `api.${zoneDomain}`;
    const apiCloudRunService = (context.upstreamArtifacts['api_cloud_run_service'] || `${slug}-api`).trim();

    const negName = `${slug}-api-neg`;
    const backendName = `${slug}-api-backend`;
    const urlMapName = `${slug}-api-urlmap`;
    const certName = `${slug}-api-cert`;
    const httpsProxyName = `${slug}-api-https-proxy`;
    const fwdRuleName = `${slug}-api-fwd-https`;

    await runCommand('gcloud', ['services', 'enable', 'compute.googleapis.com', '--project', gcpProjectId, '--quiet'], process.cwd(), log);

    if (!await gcpExists(['compute', 'network-endpoint-groups', 'describe', negName, '--region', region, '--project', gcpProjectId], log)) {
      await runCommand('gcloud', ['compute', 'network-endpoint-groups', 'create', negName, '--region', region, '--network-endpoint-type=serverless', `--cloud-run-service=${apiCloudRunService}`, '--project', gcpProjectId, '--quiet'], process.cwd(), log);
    }

    const backendExists = await gcpExists(['compute', 'backend-services', 'describe', backendName, '--global', '--project', gcpProjectId], log);
    if (!backendExists) {
      await runCommand('gcloud', ['compute', 'backend-services', 'create', backendName, '--global', '--project', gcpProjectId, '--quiet'], process.cwd(), log);
      await runCommand('gcloud', ['compute', 'backend-services', 'add-backend', backendName, '--global', `--network-endpoint-group=${negName}`, `--network-endpoint-group-region=${region}`, '--project', gcpProjectId, '--quiet'], process.cwd(), log);
    } else {
      const backends = await runCommand('gcloud', ['compute', 'backend-services', 'describe', backendName, '--global', '--format=value(backends[].group)', '--project', gcpProjectId], process.cwd(), log).catch(() => '');
      if (!backends.includes(negName)) {
        await runCommand('gcloud', ['compute', 'backend-services', 'add-backend', backendName, '--global', `--network-endpoint-group=${negName}`, `--network-endpoint-group-region=${region}`, '--project', gcpProjectId, '--quiet'], process.cwd(), log);
      }
    }

    if (!await gcpExists(['compute', 'url-maps', 'describe', urlMapName, '--global', '--project', gcpProjectId], log)) {
      await runCommand('gcloud', ['compute', 'url-maps', 'create', urlMapName, `--default-service=${backendName}`, '--global', '--project', gcpProjectId, '--quiet'], process.cwd(), log);
    }

    if (!await gcpExists(['compute', 'ssl-certificates', 'describe', certName, '--global', '--project', gcpProjectId], log)) {
      await runCommand('gcloud', ['compute', 'ssl-certificates', 'create', certName, `--domains=${apiDomain}`, '--global', '--project', gcpProjectId, '--quiet'], process.cwd(), log);
    }

    if (!await gcpExists(['compute', 'target-https-proxies', 'describe', httpsProxyName, '--global', '--project', gcpProjectId], log)) {
      await runCommand('gcloud', ['compute', 'target-https-proxies', 'create', httpsProxyName, `--ssl-certificates=${certName}`, `--url-map=${urlMapName}`, '--global', '--project', gcpProjectId, '--quiet'], process.cwd(), log);
    }

    if (!await gcpExists(['compute', 'forwarding-rules', 'describe', fwdRuleName, '--global', '--project', gcpProjectId], log)) {
      await runCommand('gcloud', ['compute', 'forwarding-rules', 'create', fwdRuleName, '--global', `--target-https-proxy=${httpsProxyName}`, '--ports=443', '--project', gcpProjectId, '--quiet'], process.cwd(), log);
    }

    const ipAddress = (await runCommand('gcloud', ['compute', 'forwarding-rules', 'describe', fwdRuleName, '--global', '--format=value(IPAddress)', '--project', gcpProjectId], process.cwd(), log)).trim();

    const cfClient = new HttpCloudflareApiClient(cfToken);
    const records = await cfClient.getDnsRecords(zoneId);
    const existing = records.filter((r) => r.name === apiDomain && (r.type === 'CNAME' || r.type === 'A'));
    if (!existing.find((r) => r.type === 'A' && r.content.trim() === ipAddress && r.proxied !== true)) {
      for (const stale of existing) {
        if (stale.id) await cfClient.deleteDnsRecord(zoneId, stale.id);
      }
      await cfClient.addDnsRecord(zoneId, { type: 'A', name: 'api', content: ipAddress, proxied: false });
    }

    const certStatus = (await runCommand('gcloud', ['compute', 'ssl-certificates', 'describe', certName, '--global', '--format=value(managed.status)', '--project', gcpProjectId], process.cwd(), log)).trim();
    if (certStatus !== 'ACTIVE') {
      return {
        reconciled: false,
        message: `Infrastructure provisioned and DNS A record set to ${ipAddress}. SSL certificate status: ${certStatus || 'PROVISIONING'} — Google verifies domain ownership after DNS propagates (5–60 min). Re-run this step to check.`,
      };
    }

    return { reconciled: true, resourcesProduced: { api_domain_url: `https://${apiDomain}`, api_lb_ip: ipAddress } };
  },
);

// ---------------------------------------------------------------------------
// Web frontend deployment steps
// ---------------------------------------------------------------------------

const webBuildBundleHandler = simpleHandler(
  'web:cicd-prepare-contract',
  undefined,
  async (context) => {
    const gcpProjectId = requireGcpProjectId(context);
    const artifactRegistryRepo = context.upstreamArtifacts['artifact_registry_repo']?.trim();
    const runtimeServiceAccount = context.upstreamArtifacts['runtime_service_account_email']?.trim();
    if (!artifactRegistryRepo) {
      return { reconciled: false, message: 'Missing artifact_registry_repo. Run gcp:ensure-artifact-registry first.' };
    }
    if (!runtimeServiceAccount) {
      return { reconciled: false, message: 'Missing runtime_service_account_email. Run gcp:ensure-runtime-service-account first.' };
    }

    const { owner, repo } = requireGithubRepoTarget(context);
    return {
      reconciled: true,
      resourcesProduced: {
        web_cicd_contract_ready: 'true',
        web_cloud_run_service: `${resourceSlug(context)}-web`,
        gcp_project_id: gcpProjectId,
        gcp_region: regionForContext(context),
        ci_github_repo: `${owner}/${repo}`,
      },
    };
  },
);

const webPublishServerlessHandler = simpleHandler(
  'web:cicd-verify-deploy',
  undefined,
  async (context) => {
    const log = makeLog('web:cicd-verify-deploy', context.projectId);
    const projectId = requireGcpProjectId(context);
    const region = regionForContext(context);
    const service = `${resourceSlug(context)}-web`;
    let serviceUrl = '';
    try {
      serviceUrl = await getCloudRunServiceUrl(service, region, projectId, log);
    } catch {
      return {
        reconciled: false,
        message:
          `Cloud Run service "${service}" was not found in "${projectId}/${region}". ` +
          'Push app code to GitHub and let web-gcp deploy workflow complete, then re-run this step.',
      };
    }

    return {
      reconciled: true,
      resourcesProduced: {
        web_cloud_run_service: service,
        web_cloud_run_url: serviceUrl,
      },
    };
  },
);

const webRunSmokeCheckHandler = simpleHandler(
  'web:cicd-verify-smoke',
  undefined,
  async (context) => {
    const base = context.upstreamArtifacts['web_cloud_run_url']?.trim();
    if (!base) return { reconciled: false, message: 'Missing web_cloud_run_url for smoke check.' };
    await smokeCheck(base);
    return { reconciled: true, resourcesProduced: { web_smoke_check_passed: 'true' } };
  },
);

const webBindDomainSslHandler = simpleHandler(
  'web:bind-domain-ssl',
  undefined,
  async (context) => {
    const log = makeLog('web:bind-domain-ssl', context.projectId);
    const gcpProjectId = requireGcpProjectId(context);
    const region = regionForContext(context);
    const slug = resourceSlug(context);

    const cfToken = (
      context.credentialService?.retrieveCredential(context.projectId, 'cloudflare_token') ||
      context.credentialService?.retrieveCredential('__organization__', 'cloudflare_token')
    )?.trim();
    if (!cfToken) return { reconciled: false, message: 'No Cloudflare token found. Complete user:provide-cloudflare-token before binding the web domain.' };
    const zoneId = context.upstreamArtifacts['cloudflare_zone_id']?.trim();
    const appDomain = context.upstreamArtifacts['cloudflare_app_domain']?.trim();
    const zoneDomain = context.upstreamArtifacts['cloudflare_zone_domain']?.trim();
    const domainMode = context.upstreamArtifacts['cloudflare_domain_mode']?.trim() || 'subdomain';
    if (!zoneId || !appDomain || !zoneDomain) return { reconciled: false, message: 'Missing Cloudflare zone info. Complete cloudflare:add-domain-zone before binding the web domain.' };
    const webCloudRunService = (context.upstreamArtifacts['web_cloud_run_service'] || `${slug}-web`).trim();

    const negName = `${slug}-web-neg`;
    const backendName = `${slug}-web-backend`;
    const urlMapName = `${slug}-web-urlmap`;
    const certName = `${slug}-web-cert`;
    const httpsProxyName = `${slug}-web-https-proxy`;
    const fwdRuleName = `${slug}-web-fwd-https`;

    await runCommand('gcloud', ['services', 'enable', 'compute.googleapis.com', '--project', gcpProjectId, '--quiet'], process.cwd(), log);

    if (!await gcpExists(['compute', 'network-endpoint-groups', 'describe', negName, '--region', region, '--project', gcpProjectId], log)) {
      await runCommand('gcloud', ['compute', 'network-endpoint-groups', 'create', negName, '--region', region, '--network-endpoint-type=serverless', `--cloud-run-service=${webCloudRunService}`, '--project', gcpProjectId, '--quiet'], process.cwd(), log);
    }

    const backendExists = await gcpExists(['compute', 'backend-services', 'describe', backendName, '--global', '--project', gcpProjectId], log);
    if (!backendExists) {
      await runCommand('gcloud', ['compute', 'backend-services', 'create', backendName, '--global', '--project', gcpProjectId, '--quiet'], process.cwd(), log);
      await runCommand('gcloud', ['compute', 'backend-services', 'add-backend', backendName, '--global', `--network-endpoint-group=${negName}`, `--network-endpoint-group-region=${region}`, '--project', gcpProjectId, '--quiet'], process.cwd(), log);
    } else {
      const backends = await runCommand('gcloud', ['compute', 'backend-services', 'describe', backendName, '--global', '--format=value(backends[].group)', '--project', gcpProjectId], process.cwd(), log).catch(() => '');
      if (!backends.includes(negName)) {
        await runCommand('gcloud', ['compute', 'backend-services', 'add-backend', backendName, '--global', `--network-endpoint-group=${negName}`, `--network-endpoint-group-region=${region}`, '--project', gcpProjectId, '--quiet'], process.cwd(), log);
      }
    }

    if (!await gcpExists(['compute', 'url-maps', 'describe', urlMapName, '--global', '--project', gcpProjectId], log)) {
      await runCommand('gcloud', ['compute', 'url-maps', 'create', urlMapName, `--default-service=${backendName}`, '--global', '--project', gcpProjectId, '--quiet'], process.cwd(), log);
    }

    if (!await gcpExists(['compute', 'ssl-certificates', 'describe', certName, '--global', '--project', gcpProjectId], log)) {
      await runCommand('gcloud', ['compute', 'ssl-certificates', 'create', certName, `--domains=${appDomain}`, '--global', '--project', gcpProjectId, '--quiet'], process.cwd(), log);
    }

    if (!await gcpExists(['compute', 'target-https-proxies', 'describe', httpsProxyName, '--global', '--project', gcpProjectId], log)) {
      await runCommand('gcloud', ['compute', 'target-https-proxies', 'create', httpsProxyName, `--ssl-certificates=${certName}`, `--url-map=${urlMapName}`, '--global', '--project', gcpProjectId, '--quiet'], process.cwd(), log);
    }

    if (!await gcpExists(['compute', 'forwarding-rules', 'describe', fwdRuleName, '--global', '--project', gcpProjectId], log)) {
      await runCommand('gcloud', ['compute', 'forwarding-rules', 'create', fwdRuleName, '--global', `--target-https-proxy=${httpsProxyName}`, '--ports=443', '--project', gcpProjectId, '--quiet'], process.cwd(), log);
    }

    const ipAddress = (await runCommand('gcloud', ['compute', 'forwarding-rules', 'describe', fwdRuleName, '--global', '--format=value(IPAddress)', '--project', gcpProjectId], process.cwd(), log)).trim();

    const dnsRecordName = domainMode === 'zone-root' ? '@' : appDomain.slice(0, appDomain.length - zoneDomain.length - 1);
    const cfClient = new HttpCloudflareApiClient(cfToken);
    const records = await cfClient.getDnsRecords(zoneId);
    const existing = records.filter((r) => r.name === appDomain && (r.type === 'CNAME' || r.type === 'A'));
    if (!existing.find((r) => r.type === 'A' && r.content.trim() === ipAddress && r.proxied !== true)) {
      for (const stale of existing) {
        if (stale.id) await cfClient.deleteDnsRecord(zoneId, stale.id);
      }
      await cfClient.addDnsRecord(zoneId, { type: 'A', name: dnsRecordName, content: ipAddress, proxied: false });
    }

    const certStatus = (await runCommand('gcloud', ['compute', 'ssl-certificates', 'describe', certName, '--global', '--format=value(managed.status)', '--project', gcpProjectId], process.cwd(), log)).trim();
    if (certStatus !== 'ACTIVE') {
      return {
        reconciled: false,
        message: `Infrastructure provisioned and DNS A record set to ${ipAddress}. SSL certificate status: ${certStatus || 'PROVISIONING'} — Google verifies domain ownership after DNS propagates (5–60 min). Re-run this step to check.`,
      };
    }

    return { reconciled: true, resourcesProduced: { web_domain_url: `https://${appDomain}`, web_lb_ip: ipAddress } };
  },
);

// ---------------------------------------------------------------------------
// Combined web+API steps
// ---------------------------------------------------------------------------

const comboCrossServiceSmokeHandler = simpleHandler(
  'combo:cross-service-smoke-check',
  undefined,
  async (context) => {
    const webUrl = context.upstreamArtifacts['web_cloud_run_url']?.trim();
    const apiUrl = context.upstreamArtifacts['api_cloud_run_url']?.trim();
    if (!webUrl || !apiUrl) {
      return { reconciled: false, message: 'Missing web or api URL for combined smoke check.' };
    }
    const healthPath = resolveDeployContractFromInputs(githubDeployInputsForContext(context)).api.healthPath || '/api/health';
    await smokeCheck(webUrl);
    await smokeCheck(`${apiUrl.replace(/\/+$/, '')}${healthPath}`);
    return { reconciled: true, resourcesProduced: { combo_smoke_check_passed: 'true' } };
  },
);

const comboPromoteReleaseHandler = simpleHandler(
  'combo:promote-release',
  undefined,
  async (context) => {
    const projectId = requireGcpProjectId(context);
    const region = regionForContext(context);
    const log = makeLog('combo:promote-release', context.projectId);
    const slug = resourceSlug(context);
    const apiService = context.upstreamArtifacts['api_cloud_run_service']?.trim() || `${slug}-api`;
    const webService = context.upstreamArtifacts['web_cloud_run_service']?.trim() || `${slug}-web`;

    for (const service of [apiService, webService]) {
      await runCommand(
        'gcloud',
        ['run', 'services', 'update-traffic', service, '--to-latest', '--region', region, '--project', projectId, '--platform', 'managed', '--quiet'],
        process.cwd(),
        log,
      );
    }
    return { reconciled: true, resourcesProduced: { combo_release_promoted: new Date().toISOString() } };
  },
);

const comboRollbackReleaseHandler = simpleHandler(
  'combo:rollback-release',
  undefined,
  async (context) => {
    const projectId = requireGcpProjectId(context);
    const region = regionForContext(context);
    const log = makeLog('combo:rollback-release', context.projectId);
    const slug = resourceSlug(context);

    async function rollbackService(service: string): Promise<void> {
      const revisions = await runCommand(
        'gcloud',
        ['run', 'revisions', 'list', '--service', service, '--region', region, '--project', projectId, '--platform', 'managed', '--sort-by=~metadata.creationTimestamp', '--format=value(metadata.name)', '--limit=2'],
        process.cwd(),
        log,
      );
      const items = revisions.split('\n').map((v) => v.trim()).filter(Boolean);
      if (items.length < 2) throw new Error(`No previous revision for service "${service}".`);
      const target = items[1]!;
      await runCommand(
        'gcloud',
        ['run', 'services', 'update-traffic', service, `--to-revisions=${target}=100`, '--region', region, '--project', projectId, '--platform', 'managed', '--quiet'],
        process.cwd(),
        log,
      );
    }

    const apiService = context.upstreamArtifacts['api_cloud_run_service']?.trim() || `${slug}-api`;
    const webService = context.upstreamArtifacts['web_cloud_run_service']?.trim() || `${slug}-web`;
    await rollbackService(apiService);
    await rollbackService(webService);
    return { reconciled: true, resourcesProduced: { combo_release_rolled_back: new Date().toISOString() } };
  },
);

// ---------------------------------------------------------------------------
// CI/CD steps
// ---------------------------------------------------------------------------

const cicdGenerateWorkflowHandler = simpleHandler(
  'cicd:generate-github-workflow',
  'github',
  async (context) => {
    const githubToken = readGitHubToken(context);
    if (!githubToken) {
      return {
        reconciled: false,
        message: 'No GitHub token in vault. Complete user:provide-github-pat before generating CI workflow wiring.',
      };
    }
    const { owner, repo } = requireGithubRepoTarget(context);
    const octokit = new Octokit({ auth: githubToken });
    let files: string[] = [];
    try {
      const workflows = await octokit.repos.getContent({ owner, repo, path: '.github/workflows' });
      files = Array.isArray(workflows.data) ? workflows.data.map((entry) => entry.name) : [];
    } catch {
      files = [];
    }

    const webDeliveryWorkflow = files.find((name) => /^web-gcp-(react|nextjs)-delivery\.yml$/.test(name));
    const legacyWebBuildWorkflow = files.find((name) => /^web-gcp-(react|nextjs)-build\.yml$/.test(name));
    const legacyWebDeployWorkflow = files.find((name) => /^web-gcp-(react|nextjs)-deploy\.yml$/.test(name));
    if (!webDeliveryWorkflow && (!legacyWebBuildWorkflow || !legacyWebDeployWorkflow)) {
      return {
        reconciled: false,
        message:
          `Required Cloud Run web workflows were not found in "${owner}/${repo}". ` +
          'Run github:deploy-workflows with web target enabled, then retry.',
      };
    }

    return {
      reconciled: true,
      resourcesProduced: {
        cloudrun_workflow_path: webDeliveryWorkflow
          ? webDeliveryWorkflow
          : `${legacyWebBuildWorkflow},${legacyWebDeployWorkflow}`,
      },
    };
  },
  async (context) => {
    const createResult = await cicdGenerateWorkflowHandler.create(context);
    return createResult.reconciled
      ? createResult
      : { reconciled: false, message: createResult.message ?? 'Cloud Run web workflows not ready.' };
  },
);

const cicdConfigureIdentityHandler = simpleHandler(
  'cicd:configure-deploy-identity',
  'gcp',
  async (context) => {
    const githubToken = readGitHubToken(context);
    if (!githubToken) {
      return {
        reconciled: false,
        message: 'No GitHub token in vault. Complete user:provide-github-pat before configuring CI deployment identity.',
      };
    }
    const { owner, repo } = requireGithubRepoTarget(context);
    const projectId = requireGcpProjectId(context);
    const region = regionForContext(context);
    const runtimeServiceAccountEmail = context.upstreamArtifacts['runtime_service_account_email']?.trim();
    if (!runtimeServiceAccountEmail) {
      return {
        reconciled: false,
        message:
          'Missing runtime_service_account_email. Run gcp:ensure-runtime-service-account before configuring CI deployment identity.',
      };
    }
    const token = await context.getToken('gcp');
    const projectNumber = await getGcpProjectNumber(token, projectId);
    const slug = resourceSlug(context);
    const poolId = 'studio-github';
    const providerId = `studio-${slug.slice(0, 20)}`;
    await ensureWorkloadIdentityPool(token, projectNumber, poolId);
    const providerResource = await ensureWorkloadIdentityProvider(token, projectNumber, poolId, providerId, owner, repo);

    const deployRoles = [
      'roles/run.admin',
      'roles/artifactregistry.writer',
      'roles/iam.serviceAccountUser',
    ];
    const ciMember = `serviceAccount:${runtimeServiceAccountEmail}`;
    const projectPolicy = await getIamPolicy(token, projectId);
    const nextBindings = (projectPolicy.bindings ?? []).map((binding) => ({
      role: binding.role,
      members: [...binding.members],
    }));
    for (const role of deployRoles) {
      const existing = nextBindings.find((binding) => binding.role === role);
      if (existing) {
        if (!existing.members.includes(ciMember)) existing.members.push(ciMember);
      } else {
        nextBindings.push({ role, members: [ciMember] });
      }
    }
    await setIamPolicy(token, projectId, nextBindings, projectPolicy.etag);

    const principalMember =
      `principalSet://iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}/attribute.repository/${owner}/${repo}`;
    await ensureServiceAccountImpersonationBinding(token, runtimeServiceAccountEmail, principalMember);

    const artifactRegistryRepo = context.upstreamArtifacts['artifact_registry_repo']?.trim();
    if (!artifactRegistryRepo) {
      return { reconciled: false, message: 'Missing artifact_registry_repo. Run gcp:ensure-artifact-registry first.' };
    }
    const artifactRepository = parseArtifactRegistryRepoName(artifactRegistryRepo);
    const cloudBuildSourceBucket = await ensureCloudBuildSourceBucket(token, projectId, region);

    const githubClient = new HttpGitHubApiClient(githubToken);
    await githubClient.setRepositorySecret(owner, repo, 'GCP_WORKLOAD_IDENTITY_PROVIDER', providerResource);
    await githubClient.setRepositorySecret(owner, repo, 'GCP_CI_SERVICE_ACCOUNT', runtimeServiceAccountEmail);
    const octokit = new Octokit({ auth: githubToken });
    await upsertRepoVariable(octokit, owner, repo, 'GCP_PROJECT_ID', projectId);
    await upsertRepoVariable(octokit, owner, repo, 'GCP_REGION', region);
    await upsertRepoVariable(octokit, owner, repo, 'GCP_ARTIFACT_REPOSITORY', artifactRepository);
    await upsertRepoVariable(octokit, owner, repo, 'WEB_CLOUD_RUN_SERVICE', `${slug}-web`);
    await upsertRepoVariable(octokit, owner, repo, 'API_CLOUD_RUN_SERVICE', `${slug}-api`);

    return {
      reconciled: true,
      resourcesProduced: {
        ci_deploy_identity_configured: 'configured',
        gcp_ci_service_account: runtimeServiceAccountEmail,
        gcp_workload_identity_provider: providerResource,
        cloudbuild_source_bucket: cloudBuildSourceBucket,
      },
    };
  },
  async (context) => {
    const ciServiceAccountEmail = context.upstreamArtifacts['runtime_service_account_email']?.trim();
    if (!ciServiceAccountEmail) {
      return {
        reconciled: false,
        message: 'Missing runtime_service_account_email for CI identity validation.',
      };
    }
    const token = await context.getToken('gcp');
    const projectId = requireGcpProjectId(context);
    const region = regionForContext(context);
    try {
      await gcpRequest('GET', 'iam.googleapis.com', `/v1/projects/-/serviceAccounts/${encodeURIComponent(ciServiceAccountEmail)}`, token);
      const cloudBuildSourceBucket = await ensureCloudBuildSourceBucket(token, projectId, region);
      return {
        reconciled: true,
        resourcesProduced: {
          ci_deploy_identity_configured: 'configured',
          cloudbuild_source_bucket: cloudBuildSourceBucket,
        },
      };
    } catch (err) {
      if (err instanceof GcpHttpError && err.statusCode === 404) {
        return { reconciled: false, message: `CI deploy service account "${ciServiceAccountEmail}" is missing.` };
      }
      throw err;
    }
  },
);

const cicdWirePromotionsHandler = simpleHandler(
  'cicd:wire-environment-promotions',
  'github',
  async (context) => {
    const githubToken = readGitHubToken(context);
    if (!githubToken) {
      return {
        reconciled: false,
        message: 'No GitHub token in vault. Complete user:provide-github-pat before wiring promotions.',
      };
    }
    const { owner, repo } = requireGithubRepoTarget(context);
    const octokit = new Octokit({ auth: githubToken });
    const workflows = await listWorkflowFiles(octokit, owner, repo);
    const webDeployWorkflow = workflows.find(
      (name) => /^web-gcp-(react|nextjs)-(deploy|delivery)\.yml$/.test(name),
    );
    if (!webDeployWorkflow) {
      return {
        reconciled: false,
        message: `No web deploy workflow found in "${owner}/${repo}". Re-run github:deploy-workflows with web target enabled.`,
      };
    }
    const workflowContent = await readWorkflowFile(octokit, owner, repo, webDeployWorkflow);
    if (!workflowContent || !workflowContent.includes('environment:')) {
      return {
        reconciled: false,
        message: `${webDeployWorkflow} is missing environment gating. Re-run github:deploy-workflows.`,
      };
    }
    return { reconciled: true, resourcesProduced: { ci_promotions_wired: webDeployWorkflow } };
  },
  async (context) => {
    const createResult = await cicdWirePromotionsHandler.create(context);
    return createResult.reconciled
      ? createResult
      : { reconciled: false, message: createResult.message ?? 'CI promotion controls are not wired.' };
  },
);

const cicdWireRollbackHandler = simpleHandler(
  'cicd:wire-rollback-action',
  'github',
  async (context) => {
    const githubToken = readGitHubToken(context);
    if (!githubToken) {
      return {
        reconciled: false,
        message: 'No GitHub token in vault. Complete user:provide-github-pat before wiring rollback.',
      };
    }
    const { owner, repo } = requireGithubRepoTarget(context);
    const octokit = new Octokit({ auth: githubToken });
    const workflows = await listWorkflowFiles(octokit, owner, repo);
    const webDeployWorkflow = workflows.find(
      (name) => /^web-gcp-(react|nextjs)-(deploy|delivery)\.yml$/.test(name),
    );
    if (!webDeployWorkflow) {
      return {
        reconciled: false,
        message: `No web deploy workflow found in "${owner}/${repo}". Re-run github:deploy-workflows with web target enabled.`,
      };
    }
    const workflowContent = await readWorkflowFile(octokit, owner, repo, webDeployWorkflow);
    if (!workflowContent || !workflowContent.includes('rollback:')) {
      return {
        reconciled: false,
        message: `${webDeployWorkflow} is missing rollback job. Re-run github:deploy-workflows.`,
      };
    }
    return { reconciled: true, resourcesProduced: { ci_rollback_wired: webDeployWorkflow } };
  },
  async (context) => {
    const createResult = await cicdWireRollbackHandler.create(context);
    return createResult.reconciled
      ? createResult
      : { reconciled: false, message: createResult.message ?? 'CI rollback wiring is incomplete.' };
  },
);

export const GCP_SERVERLESS_STEP_HANDLERS: StepHandler[] = [
  resolveProjectContextHandler,
  prepareRuntimeFoundationHandler,
  ensureArtifactRegistryHandler,
  ensureRuntimeServiceAccountHandler,
  ensureSecretManagerBindingsHandler,
  setupObservabilityBaselineHandler,
  apiBuildContainerHandler,
  apiDeployCloudRunHandler,
  apiRunSmokeCheckHandler,
  apiPromoteTrafficHandler,
  apiRollbackRevisionHandler,
  apiBindDomainSslHandler,
  webBuildBundleHandler,
  webPublishServerlessHandler,
  webRunSmokeCheckHandler,
  webBindDomainSslHandler,
  comboCrossServiceSmokeHandler,
  comboPromoteReleaseHandler,
  comboRollbackReleaseHandler,
  cicdGenerateWorkflowHandler,
  cicdConfigureIdentityHandler,
  cicdWirePromotionsHandler,
  cicdWireRollbackHandler,
];
