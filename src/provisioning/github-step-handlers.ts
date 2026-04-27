import { Octokit } from '@octokit/rest';
import type { StepHandler, StepHandlerContext, StepHandlerResult } from './step-handler-registry.js';
import { projectResourceSlug } from '../studio/project-identity.js';
import { HttpGitHubApiClient } from '../providers/github.js';
import { ExpoGraphqlEasApiClient } from '../providers/expo-graphql-eas-client.js';
import {
  buildDefaultEasJson,
  patchAppJsonWithEasProjectId,
  patchAppConfigJsWithEasProjectId,
  patchAppConfigJsWithEncryptionDeclaration,
  patchAppJsonWithEncryptionDeclaration,
  type EasJsonSubmitInfo,
} from '../providers/eas.js';
import type { Environment } from '../providers/types.js';

function readGitHubToken(context: StepHandlerContext): string | undefined {
  return context.vaultManager.getCredential(context.passphrase, 'github', 'token')?.trim();
}

function readExpoToken(context: StepHandlerContext): string | undefined {
  return context.vaultManager.getCredential(context.passphrase, 'eas', 'expo_token')?.trim();
}

/**
 * Sentinel values written to plan state in place of secrets so the real value
 * never travels through orchestrator/upstreamArtifacts. Any handler that needs
 * the real secret MUST read it directly from the vault.
 */
const VAULT_PLACEHOLDER_VALUES = new Set<string>([
  '[stored in vault]',
  '[redacted]',
  '[empty]',
]);

/**
 * Resolve the plaintext Expo robot token. Always reads from the vault. The
 * upstream `user:provide-expo-token` gate produces `expo_token: '[stored in
 * vault]'` as a sentinel — DO NOT use upstreamArtifacts for this value, or you
 * will end up uploading the literal string `[stored in vault]` to GitHub as
 * the secret value (which is exactly the bug that caused EAS to reject the
 * workflow with "bearer token is invalid").
 */
function resolveExpoToken(context: StepHandlerContext): string | undefined {
  const upstream = context.upstreamArtifacts['expo_token']?.trim();
  if (upstream && !VAULT_PLACEHOLDER_VALUES.has(upstream)) return upstream;
  return readExpoToken(context);
}

function parseGitHubRepoUrl(url: string): { owner: string; repo: string } | null {
  const cleaned = url.trim().replace(/\.git$/i, '');
  const match = cleaned.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\/|$)/i);
  if (!match) return null;
  return { owner: match[1]!, repo: match[2]! };
}

function readExplicitGithubOwner(context: StepHandlerContext): string | null {
  const raw = context.userInputs?.['github_owner']?.trim();
  if (!raw) return null;
  const owner = raw.replace(/^@+/, '');
  // GitHub owner/login syntax is alnum or single hyphen separators.
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) {
    throw new Error(
      `Invalid GitHub owner/org "${raw}". Use a GitHub username or organization login (letters, numbers, hyphens).`,
    );
  }
  return owner;
}

function resolveOwnerRepo(context: StepHandlerContext): { owner: string; repo: string } | null {
  const upstreamUrl = context.upstreamArtifacts['github_repo_url']?.trim();
  if (upstreamUrl) {
    return parseGitHubRepoUrl(upstreamUrl);
  }

  const projectRecord = context.projectManager.getProject(context.projectId);
  const organization = context.projectManager.getOrganization();
  const orgGithubConfig = organization.integrations.github?.config ?? {};
  const explicitOwner = readExplicitGithubOwner(context);
  const owner =
    explicitOwner ||
    projectRecord.project.githubOrg?.trim() ||
    orgGithubConfig['owner_default']?.trim() ||
    orgGithubConfig['username']?.trim() ||
    projectRecord.project.slug;
  const repo = projectResourceSlug(projectRecord.project);
  if (!owner || !repo) return null;
  return { owner, repo };
}

function isNotFoundError(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  return status === 404;
}

async function checkRepository(context: StepHandlerContext): Promise<StepHandlerResult> {
  const token = readGitHubToken(context);
  if (!token) {
    return { reconciled: false, message: 'No GitHub token in vault.' };
  }

  const target = resolveOwnerRepo(context);
  if (!target) {
    return {
      reconciled: false,
      message: 'Could not resolve GitHub owner/repo for this project.',
    };
  }

  const octokit = new Octokit({ auth: token });
  try {
    const { data } = await octokit.repos.get({ owner: target.owner, repo: target.repo });
    return {
      reconciled: true,
      resourcesProduced: {
        github_repo_url: (data.html_url ?? `https://github.com/${target.owner}/${target.repo}`).replace(/\/+$/g, ''),
        github_repo_id: String(data.id),
      },
    };
  } catch (err) {
    if (isNotFoundError(err)) {
      return {
        reconciled: false,
        message: `GitHub repository "${target.owner}/${target.repo}" was not found.`,
      };
    }
    throw err;
  }
}

const createRepositoryHandler: StepHandler = {
  stepKey: 'github:create-repository',

  async create(context: StepHandlerContext): Promise<StepHandlerResult> {
    const token = readGitHubToken(context);
    if (!token) {
      return {
        reconciled: false,
        message: 'No GitHub token in the organization vault. Connect GitHub under organization settings first.',
      };
    }

    const target = resolveOwnerRepo(context);
    if (!target) {
      return {
        reconciled: false,
        message: 'Could not resolve GitHub owner/repo for this project.',
      };
    }

    const octokit = new Octokit({ auth: token });
    try {
      const existing = await octokit.repos.get({ owner: target.owner, repo: target.repo });
      return {
        reconciled: true,
        resourcesProduced: {
          github_repo_url: (existing.data.html_url ?? `https://github.com/${target.owner}/${target.repo}`).replace(/\/+$/g, ''),
          github_repo_id: String(existing.data.id),
        },
      };
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }

    try {
      const created = await octokit.repos.createInOrg({
        org: target.owner,
        name: target.repo,
        auto_init: true,
        private: true,
      });
      return {
        reconciled: true,
        resourcesProduced: {
          github_repo_url: (created.data.html_url ?? `https://github.com/${target.owner}/${target.repo}`).replace(/\/+$/g, ''),
          github_repo_id: String(created.data.id),
        },
      };
    } catch {
      const created = await octokit.repos.createForAuthenticatedUser({
        name: target.repo,
        auto_init: true,
        private: true,
      });
      return {
        reconciled: true,
        resourcesProduced: {
          github_repo_url: (created.data.html_url ?? `https://github.com/${target.owner}/${target.repo}`).replace(/\/+$/g, ''),
          github_repo_id: String(created.data.id),
        },
      };
    }
  },

  async delete(context: StepHandlerContext): Promise<StepHandlerResult> {
    const token = readGitHubToken(context);
    if (!token) {
      return {
        reconciled: false,
        message: 'No GitHub token in vault — cannot delete the GitHub repository.',
      };
    }

    const target = resolveOwnerRepo(context);
    if (!target) {
      return {
        reconciled: false,
        message: 'Could not resolve GitHub owner/repo for this project.',
      };
    }

    const octokit = new Octokit({ auth: token });
    try {
      await octokit.repos.delete({ owner: target.owner, repo: target.repo });
      return {
        reconciled: true,
        message: `Deleted GitHub repository "${target.owner}/${target.repo}".`,
      };
    } catch (err) {
      if (isNotFoundError(err)) {
        return {
          reconciled: true,
          message: `GitHub repository "${target.owner}/${target.repo}" was already absent.`,
        };
      }
      throw err;
    }
  },

  async validate(context: StepHandlerContext): Promise<StepHandlerResult> {
    return checkRepository(context);
  },

  async sync(context: StepHandlerContext): Promise<StepHandlerResult | null> {
    return checkRepository(context);
  },
};

// =============================================================================
// GitHub secret partitioning
// =============================================================================
// Repository-level secrets (one value, applies to every env — including jobs
// with no `environment:` declared). Owned by `eas:store-token-in-github`.
//
//   EXPO_TOKEN   - Expo robot token. Same value across envs. Acts as the
//                  fallback when an env doesn't override it. Read by
//                  `expo/expo-github-action@v8` and `eas-cli`.
//
// Environment-level secrets (per-env — preview vs production typically point
// at different backends, so the value differs). Owned by `github:inject-secrets`.
//
//   FIREBASE_SERVICE_ACCOUNT - Firebase service-account JSON for the env's
//                              Firebase project. Read by deploy/build workflows.
//
// We do NOT duplicate EXPO_TOKEN at env level. GitHub resolves env-secret →
// repo-secret, so the repo-level value is visible inside every env (protected
// or not). Writing it twice was redundant and let the two values silently
// drift after rotations.
// =============================================================================

const EXPO_TOKEN_SECRET_NAME = 'EXPO_TOKEN';
const FIREBASE_SERVICE_ACCOUNT_SECRET_NAME = 'FIREBASE_SERVICE_ACCOUNT';

// Legacy env-level secret names that earlier provisioning runs wrote. Kept
// here so the inject/delete paths can scrub them — otherwise stale values
// linger forever in env settings after the partitioning refactor.
const LEGACY_ENV_LEVEL_SECRET_NAMES = [
  // We used to write EXPO_TOKEN at env level too; now it's repo-only.
  'EXPO_TOKEN',
  // Original env-level name before the EXPO_TOKEN rename.
  'EAS_TOKEN',
];
// Legacy single-env name we used to write all secrets to. Kept so the delete
// handler can clean it up off any project that was provisioned before we
// switched to writing to every project env declared in `project.environments`.
const LEGACY_GLOBAL_ENVIRONMENT = 'global';

/**
 * Resolve the target environments for `github:inject-secrets`. Reads the
 * project's declared environments (e.g. `["preview","production"]`) so the
 * secrets land on every env that any workflow may run in. GitHub does NOT
 * merge secrets across envs — a job in env X only sees env X's secrets +
 * repo-level — so writing to a single hardcoded env makes the secrets
 * invisible to most workflow jobs.
 */
function resolveTargetEnvironments(context: StepHandlerContext): string[] {
  const project = context.projectManager.getProject(context.projectId).project;
  const envs = (project.environments ?? []).filter((e) => e && e.trim().length > 0);
  if (envs.length === 0) {
    throw new Error(
      `Project "${context.projectId}" has no environments declared — cannot inject GitHub environment secrets.`,
    );
  }
  return envs;
}

async function checkExpoTokenSecretExists(context: StepHandlerContext): Promise<StepHandlerResult> {
  const token = readGitHubToken(context);
  if (!token) {
    return { reconciled: false, message: 'No GitHub token in vault.' };
  }

  const target = resolveOwnerRepo(context);
  if (!target) {
    return { reconciled: false, message: 'Could not resolve GitHub owner/repo for this project.' };
  }

  const client = new HttpGitHubApiClient(token);
  const exists = await client.hasRepositorySecret(target.owner, target.repo, EXPO_TOKEN_SECRET_NAME);
  if (exists) {
    return { reconciled: true };
  }
  return {
    reconciled: false,
    message: `GitHub secret "${EXPO_TOKEN_SECRET_NAME}" does not exist on "${target.owner}/${target.repo}".`,
  };
}

const storeEasTokenInGitHubHandler: StepHandler = {
  stepKey: 'eas:store-token-in-github',

  async create(context: StepHandlerContext): Promise<StepHandlerResult> {
    const githubToken = readGitHubToken(context);
    if (!githubToken) {
      return {
        reconciled: false,
        message: 'No GitHub token in the organization vault. Connect GitHub under organization settings first.',
      };
    }

    const target = resolveOwnerRepo(context);
    if (!target) {
      return { reconciled: false, message: 'Could not resolve GitHub owner/repo for this project.' };
    }

    const expoToken = resolveExpoToken(context);
    if (!expoToken) {
      return {
        reconciled: false,
        message: 'No Expo robot token available. Connect EAS under organization settings so the token is stored in the vault.',
      };
    }

    const client = new HttpGitHubApiClient(githubToken);
    await client.setRepositorySecret(target.owner, target.repo, EXPO_TOKEN_SECRET_NAME, expoToken);
    return { reconciled: true, resourcesProduced: {} };
  },

  async delete(context: StepHandlerContext): Promise<StepHandlerResult> {
    const token = readGitHubToken(context);
    if (!token) {
      return { reconciled: false, message: 'No GitHub token in vault — cannot remove the GitHub secret.' };
    }

    const target = resolveOwnerRepo(context);
    if (!target) {
      return { reconciled: false, message: 'Could not resolve GitHub owner/repo for this project.' };
    }

    const client = new HttpGitHubApiClient(token);
    const repoLabel = `${target.owner}/${target.repo}`;

    const existedBefore = await client.hasRepositorySecret(target.owner, target.repo, EXPO_TOKEN_SECRET_NAME);
    console.log(
      `[github-step] delete ${EXPO_TOKEN_SECRET_NAME} on ${repoLabel}: existed_before=${existedBefore}`,
    );
    if (!existedBefore) {
      return {
        reconciled: true,
        message: `GitHub secret "${EXPO_TOKEN_SECRET_NAME}" was not present on "${repoLabel}" (already absent).`,
      };
    }

    await client.deleteRepositorySecret(target.owner, target.repo, EXPO_TOKEN_SECRET_NAME);

    // Post-condition: verify the secret is actually gone. GitHub's delete API
    // returns 204 even in some weird cases where the underlying resource sticks
    // around (token scope mismatch, fine-grained PAT without the right repo
    // selected, etc.), so we re-read to be sure.
    const stillExists = await client.hasRepositorySecret(
      target.owner,
      target.repo,
      EXPO_TOKEN_SECRET_NAME,
    );
    console.log(
      `[github-step] delete ${EXPO_TOKEN_SECRET_NAME} on ${repoLabel}: still_exists_after=${stillExists}`,
    );
    if (stillExists) {
      return {
        reconciled: false,
        message:
          `Delete API reported success but secret "${EXPO_TOKEN_SECRET_NAME}" still exists on "${repoLabel}". ` +
          'Likely the GitHub token in the vault lacks delete permission on this repo (fine-grained PAT missing repo, or org SSO not authorized).',
      };
    }
    return {
      reconciled: true,
      message: `Removed GitHub secret "${EXPO_TOKEN_SECRET_NAME}" from "${repoLabel}".`,
    };
  },

  async validate(context: StepHandlerContext): Promise<StepHandlerResult> {
    return checkExpoTokenSecretExists(context);
  },

  async sync(context: StepHandlerContext): Promise<StepHandlerResult | null> {
    return checkExpoTokenSecretExists(context);
  },
};

const injectGitHubEnvironmentSecretsHandler: StepHandler = {
  stepKey: 'github:inject-secrets',

  async create(context: StepHandlerContext): Promise<StepHandlerResult> {
    const githubToken = readGitHubToken(context);
    if (!githubToken) {
      return {
        reconciled: false,
        message: 'No GitHub token in the organization vault. Connect GitHub under organization settings first.',
      };
    }

    const target = resolveOwnerRepo(context);
    if (!target) {
      return { reconciled: false, message: 'Could not resolve GitHub owner/repo for this project.' };
    }

    const targetEnvs = resolveTargetEnvironments(context);
    const client = new HttpGitHubApiClient(githubToken);
    const repoLabel = `${target.owner}/${target.repo}`;
    const injected: string[] = [];
    const scrubbed: string[] = [];

    const serviceAccountJson = await context.vaultManager.getCredential(
      context.passphrase,
      'firebase',
      `${context.projectId}/service_account_json`,
    );

    // Make sure each target env exists before writing secrets to it.
    // setEnvironmentSecret would 404 otherwise (env created lazily here so
    // inject-secrets is robust even if `github:create-environments` was
    // skipped or only ran for a subset of envs).
    for (const env of targetEnvs) {
      await client.createEnvironment(target.owner, target.repo, env);
    }

    for (const env of targetEnvs) {
      // FIREBASE_SERVICE_ACCOUNT — env-scoped because preview/production
      // typically use different Firebase projects. Today the vault stores a
      // single SA per Studio project so the same value goes to every env;
      // when per-env Firebase projects are wired up this code becomes the
      // place to look up the env-specific SA.
      if (serviceAccountJson?.trim()) {
        await client.setEnvironmentSecret(
          target.owner,
          target.repo,
          env,
          FIREBASE_SERVICE_ACCOUNT_SECRET_NAME,
          serviceAccountJson,
        );
        injected.push(`${env}/${FIREBASE_SERVICE_ACCOUNT_SECRET_NAME}`);
      }

      // EXPO_TOKEN is REPO-LEVEL only (owned by eas:store-token-in-github).
      // Scrub any leftover env-level copies (and the legacy EAS_TOKEN name)
      // so they can't shadow the repo-level value with a stale token after
      // a rotation.
      for (const legacy of LEGACY_ENV_LEVEL_SECRET_NAMES) {
        await client.deleteEnvironmentSecret(target.owner, target.repo, env, legacy);
        scrubbed.push(`${env}/${legacy}`);
      }
    }

    // Delete the legacy `global` GitHub environment outright. Earlier
    // versions of this handler (and the orchestrator's fallback when
    // `context.environment` was unset) wrote secrets to a phantom `global`
    // env. No workflow job ever runs in `global`, so the env is dead weight
    // and its presence is confusing in the GitHub Settings → Environments UI.
    if (!targetEnvs.includes(LEGACY_GLOBAL_ENVIRONMENT)) {
      try {
        await client.deleteEnvironment(target.owner, target.repo, LEGACY_GLOBAL_ENVIRONMENT);
      } catch (err) {
        console.warn(
          `[github-step] inject-secrets on ${repoLabel}: failed to delete legacy "${LEGACY_GLOBAL_ENVIRONMENT}" env: ${(err as Error).message}`,
        );
      }
    }

    console.log(
      `[github-step] inject-secrets on ${repoLabel}: wrote=[${injected.join(', ') || 'none'}] ` +
        `scrubbed-legacy=[${scrubbed.join(', ') || 'none'}]`,
    );

    return {
      reconciled: true,
      resourcesProduced: {
        injected_secrets: injected.join(','),
      },
    };
  },

  async delete(context: StepHandlerContext): Promise<StepHandlerResult> {
    const githubToken = readGitHubToken(context);
    if (!githubToken) {
      return {
        reconciled: false,
        message: 'No GitHub token in vault — cannot remove GitHub environment secrets.',
      };
    }

    const target = resolveOwnerRepo(context);
    if (!target) {
      return { reconciled: false, message: 'Could not resolve GitHub owner/repo for this project.' };
    }

    const client = new HttpGitHubApiClient(githubToken);
    const repoLabel = `${target.owner}/${target.repo}`;
    const targetEnvs = resolveTargetEnvironments(context);
    // Removes the env-level secret we own (FIREBASE_SERVICE_ACCOUNT) plus
    // legacy env-level names (EXPO_TOKEN/EAS_TOKEN) we used to write before
    // the partitioning refactor. Repo-level EXPO_TOKEN is intentionally
    // NOT touched here — that's owned by `eas:store-token-in-github`.
    const namesToRemove = [
      FIREBASE_SERVICE_ACCOUNT_SECRET_NAME,
      ...LEGACY_ENV_LEVEL_SECRET_NAMES,
    ];
    // Include the legacy `global` env so `delete()` cleans up secrets left
    // behind by older provisioning runs.
    const envsToScrub = Array.from(new Set([...targetEnvs, LEGACY_GLOBAL_ENVIRONMENT]));

    const stillThere: string[] = [];
    for (const env of envsToScrub) {
      const before = await client
        .listEnvironmentSecrets(target.owner, target.repo, env)
        .catch(() => [] as string[]);
      console.log(
        `[github-step] delete env-secrets on ${repoLabel} (${env}): before=[${before.join(',')}]`,
      );
      for (const name of namesToRemove) {
        await client.deleteEnvironmentSecret(target.owner, target.repo, env, name);
      }
      const after = await client
        .listEnvironmentSecrets(target.owner, target.repo, env)
        .catch(() => [] as string[]);
      console.log(
        `[github-step] delete env-secrets on ${repoLabel} (${env}): after=[${after.join(',')}]`,
      );
      for (const name of namesToRemove) {
        if (after.includes(name)) stillThere.push(`${env}/${name}`);
      }
    }

    // Always remove the legacy `global` GitHub env entirely on revert. The
    // env was a leftover from an earlier orchestrator fallback and serves
    // no purpose; leaving an empty `global` env in GitHub Settings is just
    // visual noise after a teardown.
    try {
      await client.deleteEnvironment(target.owner, target.repo, LEGACY_GLOBAL_ENVIRONMENT);
      console.log(
        `[github-step] delete env-secrets on ${repoLabel}: removed legacy "${LEGACY_GLOBAL_ENVIRONMENT}" env`,
      );
    } catch (err) {
      console.warn(
        `[github-step] delete env-secrets on ${repoLabel}: failed to delete legacy "${LEGACY_GLOBAL_ENVIRONMENT}" env: ${(err as Error).message}`,
      );
    }

    if (stillThere.length > 0) {
      return {
        reconciled: false,
        message:
          `Delete API reported success but env secrets [${stillThere.join(', ')}] still exist on ` +
          `"${repoLabel}". Likely the GitHub token lacks delete permission on this repo/environment ` +
          '(fine-grained PAT scope or org SSO authorization).',
      };
    }
    return {
      reconciled: true,
      message:
        `Removed env secrets [${namesToRemove.join(', ')}] from ` +
        `"${repoLabel}" envs [${envsToScrub.join(', ')}] and removed legacy "${LEGACY_GLOBAL_ENVIRONMENT}" env.`,
    };
  },

  async validate(context: StepHandlerContext): Promise<StepHandlerResult> {
    const githubToken = readGitHubToken(context);
    if (!githubToken) return { reconciled: false, message: 'No GitHub token in vault.' };

    const target = resolveOwnerRepo(context);
    if (!target) return { reconciled: false, message: 'Could not resolve GitHub owner/repo for this project.' };

    const targetEnvs = resolveTargetEnvironments(context);
    const client = new HttpGitHubApiClient(githubToken);
    const repoLabel = `${target.owner}/${target.repo}`;

    // Validates only env-level ownership: FIREBASE_SERVICE_ACCOUNT in every
    // project env. EXPO_TOKEN is repo-level (owned by
    // `eas:store-token-in-github`) so we don't expect it here.
    const missingPerEnv: Record<string, string[]> = {};
    for (const env of targetEnvs) {
      const secrets = await client.listEnvironmentSecrets(target.owner, target.repo, env);
      console.log(
        `[github-step] validate inject-secrets on ${repoLabel} (${env}): found=[${secrets.join(',')}]`,
      );
      const missing: string[] = [];
      if (!secrets.includes(FIREBASE_SERVICE_ACCOUNT_SECRET_NAME)) {
        missing.push(FIREBASE_SERVICE_ACCOUNT_SECRET_NAME);
      }
      if (missing.length > 0) missingPerEnv[env] = missing;
    }

    if (Object.keys(missingPerEnv).length === 0) return { reconciled: true };

    const breakdown = Object.entries(missingPerEnv)
      .map(([env, names]) => `${env}: missing [${names.join(', ')}]`)
      .join('; ');
    return {
      reconciled: false,
      message:
        `Expected "${FIREBASE_SERVICE_ACCOUNT_SECRET_NAME}" in every project env on ` +
        `"${repoLabel}". ${breakdown}.`,
    };
  },

  async sync(context: StepHandlerContext): Promise<StepHandlerResult | null> {
    return injectGitHubEnvironmentSecretsHandler.validate(context);
  },
};

async function resolveEasProjectId(context: StepHandlerContext): Promise<string | null> {
  const upstream = context.upstreamArtifacts['eas_project_id']?.trim();
  if (upstream) return upstream;
  const expoToken = readExpoToken(context);
  if (!expoToken) return null;
  const projectRecord = context.projectManager.getProject(context.projectId);
  const slug = projectResourceSlug(projectRecord.project) || context.projectId;
  const organization = projectRecord.project.easAccount?.trim() || undefined;
  const client = new ExpoGraphqlEasApiClient(expoToken);
  return client.getProject(slug, organization);
}

function planEnvironments(context: StepHandlerContext): Environment[] {
  const projectRecord = context.projectManager.getProject(context.projectId);
  const envs = (projectRecord.project.environments as Environment[] | undefined) ?? [];
  if (envs.length > 0) return envs;
  return ['development', 'preview', 'production'] as Environment[];
}

const writeEasJsonHandler: StepHandler = {
  stepKey: 'eas:write-eas-json',

  async create(context: StepHandlerContext): Promise<StepHandlerResult> {
    const githubToken = readGitHubToken(context);
    if (!githubToken) {
      return {
        reconciled: false,
        message: 'No GitHub token in the organization vault. Connect GitHub under organization settings first.',
      };
    }
    const target = resolveOwnerRepo(context);
    if (!target) {
      return { reconciled: false, message: 'Could not resolve GitHub owner/repo for this project.' };
    }
    const easProjectId = await resolveEasProjectId(context);
    if (!easProjectId) {
      return {
        reconciled: false,
        message: 'No EAS project id available. Run "Create EAS Project" first or connect EAS in organization settings.',
      };
    }

    const client = new HttpGitHubApiClient(githubToken);
    const written: string[] = [];
    const skipped: string[] = [];

    const existingEasJson = await client.getRepoFile(target.owner, target.repo, 'eas.json');
    if (!existingEasJson) {
      const submitInfo: EasJsonSubmitInfo = {
        ascAppId:
          context.upstreamArtifacts['asc_app_id']?.trim() ||
          context.vaultManager.getCredential(context.passphrase, 'firebase', `${context.projectId}/asc_app_id`)?.trim() ||
          undefined,
        appleTeamId:
          context.upstreamArtifacts['apple_team_id']?.trim() ||
          context.vaultManager.getCredential(context.passphrase, 'firebase', `${context.projectId}/apple_team_id`)?.trim() ||
          undefined,
        appleId: context.upstreamArtifacts['apple_id']?.trim() || undefined,
      };
      const content = buildDefaultEasJson(planEnvironments(context), submitInfo);
      await client.upsertRepoFile(
        target.owner,
        target.repo,
        'eas.json',
        content,
        'chore: add eas.json (Studio bootstrap)',
      );
      written.push('eas.json');
    } else {
      skipped.push('eas.json (already present)');
    }

    const appConfigTs = await client.getRepoFile(target.owner, target.repo, 'app.config.ts');
    const appConfigJs = await client.getRepoFile(target.owner, target.repo, 'app.config.js');
    const appConfigSource = appConfigTs ?? appConfigJs;
    const appConfigPath = appConfigTs ? 'app.config.ts' : appConfigJs ? 'app.config.js' : null;

    let appJsonNote: string | undefined;
    if (appConfigSource && appConfigPath) {
      let working = appConfigSource.content;
      let mutated = false;
      const withProjectId = patchAppConfigJsWithEasProjectId(working, easProjectId);
      if (withProjectId === null) {
        if (!new RegExp(`projectId\\s*:\\s*['"\`]${easProjectId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`).test(working)) {
          appJsonNote = `Detected ${appConfigPath} but couldn't safely auto-add \`extra.eas.projectId = "${easProjectId}"\` — add it yourself.`;
        }
      } else {
        working = withProjectId;
        mutated = true;
      }
      const withEncryption = patchAppConfigJsWithEncryptionDeclaration(working);
      if (withEncryption !== null) {
        working = withEncryption;
        mutated = true;
      }
      if (mutated) {
        await client.upsertRepoFile(
          target.owner,
          target.repo,
          appConfigPath,
          working,
          'chore: configure Expo app for EAS build (Studio)',
        );
        written.push(appConfigPath);
      } else {
        skipped.push(`${appConfigPath} (already configured or unrecognized shape)`);
      }
    } else {
      const appJson = await client.getRepoFile(target.owner, target.repo, 'app.json');
      if (!appJson) {
        appJsonNote = `No app.json or app.config.{ts,js} found in the repo root — push your Expo project (or set \`extra.eas.projectId = "${easProjectId}"\` in your app config) before running EAS build.`;
        skipped.push('app.json (missing)');
      } else {
        let working = appJson.content;
        let mutated = false;
        const withProjectId = patchAppJsonWithEasProjectId(working, easProjectId);
        if (withProjectId !== null) {
          working = withProjectId;
          mutated = true;
        }
        const withEncryption = patchAppJsonWithEncryptionDeclaration(working);
        if (withEncryption !== null) {
          working = withEncryption;
          mutated = true;
        }
        if (mutated) {
          await client.upsertRepoFile(
            target.owner,
            target.repo,
            'app.json',
            working,
            'chore: configure Expo app for EAS build (Studio)',
          );
          written.push('app.json');
        } else {
          skipped.push('app.json (no changes needed)');
        }
      }
    }

    const summary = [
      written.length > 0 ? `Committed: ${written.join(', ')}.` : 'No files committed.',
      skipped.length > 0 ? `Skipped: ${skipped.join(', ')}.` : null,
      appJsonNote,
    ]
      .filter(Boolean)
      .join(' ');

    return {
      reconciled: true,
      resourcesProduced: { eas_json_path: 'eas.json' },
      message: summary,
    };
  },

  async delete(context: StepHandlerContext): Promise<StepHandlerResult> {
    return {
      reconciled: true,
      message:
        'Leaving eas.json in the repository — delete it manually if you no longer want EAS builds. ' +
        'Studio does not auto-remove application source files.',
    };
  },

  async validate(context: StepHandlerContext): Promise<StepHandlerResult> {
    const githubToken = readGitHubToken(context);
    if (!githubToken) return { reconciled: false, message: 'No GitHub token in vault.' };
    const target = resolveOwnerRepo(context);
    if (!target) return { reconciled: false, message: 'Could not resolve GitHub owner/repo for this project.' };
    const client = new HttpGitHubApiClient(githubToken);
    const exists = await client.getRepoFile(target.owner, target.repo, 'eas.json');
    if (!exists) {
      return {
        reconciled: false,
        message: `eas.json is missing from ${target.owner}/${target.repo}. Re-run "Commit eas.json to Repo".`,
      };
    }
    return { reconciled: true, resourcesProduced: { eas_json_path: 'eas.json' } };
  },

  async sync(context: StepHandlerContext): Promise<StepHandlerResult | null> {
    return writeEasJsonHandler.validate(context);
  },
};

export const GITHUB_STEP_HANDLERS: StepHandler[] = [
  createRepositoryHandler,
  storeEasTokenInGitHubHandler,
  injectGitHubEnvironmentSecretsHandler,
  writeEasJsonHandler,
];
