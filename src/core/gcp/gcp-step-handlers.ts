/**
 * GCP/Firebase provisioning step handlers.
 *
 * Implements the full create / delete / validate / sync lifecycle for every
 * Firebase provisioning graph step.  Each method:
 *   1. Reads vault state to understand what is already stored.
 *   2. Calls context.getToken('gcp') exactly ONCE and reuses the token.
 *   3. Executes the GCP API work, logging every action clearly.
 *   4. Persists results to vault / ProjectManager.
 *   5. Returns a StepHandlerResult — never throws for business-logic failures.
 *
 * Log format (designed for both human and LLM readability):
 *   [gcp:<step>] studio="<studioProjectId>" | <message>
 *   Leading ✓ = success, ✗ = failure, → = in-progress action.
 */

import type { StepHandler, StepHandlerContext, StepHandlerResult } from '../../provisioning/step-handler-registry.js';
import {
  GcpHttpError,
  gcpRequest,
  fetchGcpProjectSummary,
  getGcpProjectStatus,
  findGcpProjectsByDisplayName,
  createGcpProject,
  deleteGcpProject,
  waitForProjectActive,
  ensureProvisionerServiceAccount,
  deleteServiceAccount,
  createServiceAccountKey,
  deleteServiceAccountKey,
  findMissingProvisionerRoles,
  grantProvisionerRoles,
  removeProvisionerRoles,
  ensureRequiredProjectApis,
  isServiceEnabled,
  enableProjectService,
  listFirebaseIosApps,
  registerFirebaseIosApp,
  listFirebaseAndroidApps,
  registerFirebaseAndroidApp,
  deployFirestoreRules,
  deployStorageRules,
  getActiveFirestoreRulesetName,
  getActiveStorageRulesetName,
  parseDisabledApiServiceName,
  sleep,
  provisionerSaEmail,
} from './gcp-api-client.js';
import {
  getStoredGcpProjectId,
  storeGcpProjectId,
  getStoredSaEmail,
  storeSaEmail,
  getStoredSaKeyJson,
  deleteSaKeyJson,
  buildStudioGcpProjectId,
  buildGcpProjectIdWithEntropy,
  applyGcpProjectLinked,
  recordProvisionerServiceAccountKey,
  getStoredFirebaseIosAppId,
  storeFirebaseIosAppId,
  getStoredFirebaseAndroidAppId,
  storeFirebaseAndroidAppId,
} from './gcp-credentials.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Structured logger for a step + studio project pair. */
function makeLog(step: string, studioId: string): (msg: string) => void {
  return (msg: string) => console.log(`[gcp:${step}] studio="${studioId}" | ${msg}`);
}

/**
 * Executes `fn` once. If it throws a "GCP API disabled" 403, enables that API
 * and retries once after a propagation delay. Uses the already-obtained token.
 */
async function withApiRetry<T>(
  gcpProjectId: string,
  token: string,
  fn: () => Promise<T>,
  log: (msg: string) => void,
): Promise<T> {
  try {
    return await fn();
  } catch (firstErr) {
    const service = parseDisabledApiServiceName(firstErr);
    if (!service) throw firstErr;
    log(`→ API "${service}" is disabled on "${gcpProjectId}" — enabling and retrying in 5s...`);
    const enabled = await enableProjectService(gcpProjectId, token, service);
    if (!enabled) throw firstErr;
    await sleep(5000);
    return await fn(); // second attempt — throws naturally if still failing
  }
}

// ---------------------------------------------------------------------------
// firebase:create-gcp-project
// ---------------------------------------------------------------------------

const createGcpProjectHandler: StepHandler = {
  stepKey: 'firebase:create-gcp-project',
  requiredAuth: 'gcp',

  async create(context: StepHandlerContext): Promise<StepHandlerResult> {
    const { projectId, vaultManager, passphrase, projectManager } = context;
    const log = makeLog('create-gcp-project', projectId);

    const storedId = getStoredGcpProjectId(vaultManager, passphrase, projectId);

    if (storedId) {
      log(`Vault already has GCP project ID "${storedId}" — verifying it is accessible...`);
      const token = await context.getToken('gcp');
      const status = await getGcpProjectStatus(token, storedId);
      if (status === 'found') {
        log(`✓ GCP project "${storedId}" is ACTIVE and accessible — step already complete.`);
        return { reconciled: true, resourcesProduced: { gcp_project_id: storedId } };
      }
      log(`✗ GCP project "${storedId}" is ${status}. Revert this step to unlink, then re-run.`);
      return {
        reconciled: false,
        message: `Previously linked GCP project "${storedId}" is ${status}. Revert this step to unlink it, then re-run.`,
      };
    }

    const expectedId = buildStudioGcpProjectId(projectId);
    const displayName = `Studio ${projectId}`;
    log(`No stored GCP project — will create "${expectedId}" (display name: "${displayName}")...`);

    const token = await context.getToken('gcp');
    const createResult = await createGcpProject(token, expectedId, displayName);
    log(`→ createGcpProject("${expectedId}") returned: "${createResult}"`);

    let finalId: string;
    if (createResult === 'conflict') {
      finalId = buildGcpProjectIdWithEntropy(projectId);
      log(`ID conflict on "${expectedId}" — retrying with entropy-suffixed ID "${finalId}"...`);
      await createGcpProject(token, finalId, displayName);
    } else {
      finalId = expectedId;
    }

    log(`→ Waiting for project "${finalId}" to become ACTIVE (polls every 1.5s, up to 30s)...`);
    await waitForProjectActive(token, finalId);

    log(`→ Enabling required GCP APIs on "${finalId}": serviceusage, iam, cloudresourcemanager, firebase...`);
    await ensureRequiredProjectApis(token, finalId);

    const userEmail =
      vaultManager.getCredential(passphrase, 'firebase', `${projectId}/connected_by_email`) ??
      context.upstreamArtifacts['connected_by_email'] ??
      'unknown';

    storeGcpProjectId(vaultManager, passphrase, projectId, finalId);
    applyGcpProjectLinked(projectManager, projectId, finalId, userEmail);

    log(`✓ COMPLETE — GCP project "${finalId}" created, activated, APIs enabled, and stored in vault.`);
    return { reconciled: true, resourcesProduced: { gcp_project_id: finalId } };
  },

  async delete(context: StepHandlerContext): Promise<StepHandlerResult> {
    const { projectId, vaultManager, passphrase, projectManager } = context;
    const log = makeLog('create-gcp-project:delete', projectId);

    const storedId = getStoredGcpProjectId(vaultManager, passphrase, projectId);
    if (!storedId) {
      log('No stored GCP project ID in vault — nothing to delete.');
      return { reconciled: true, message: 'No GCP project linked — nothing to delete.' };
    }

    log(`→ Deleting GCP project "${storedId}" via Cloud Resource Manager API...`);
    try {
      const token = await context.getToken('gcp');
      await deleteGcpProject(token, storedId);
      log(`✓ GCP project "${storedId}" submitted for deletion (enters 30-day pending-delete state).`);
    } catch (err) {
      const msg = (err as Error).message;
      log(`✗ Delete failed: ${msg}`);
      return { reconciled: false, message: `Could not delete GCP project "${storedId}": ${msg}` };
    }

    vaultManager.deleteCredential(passphrase, 'firebase', `${projectId}/gcp_project_id`);

    try {
      const proj = projectManager.getProject(projectId);
      if (proj.integrations.firebase) {
        projectManager.updateIntegration(projectId, 'firebase', {
          status: 'pending',
          notes: 'GCP project deleted via provisioner revert.',
          config: { gcp_project_id: '', service_account_email: '', connected_by: '', credential_scope: 'project' },
        });
      }
    } catch { /* project record may already be gone */ }

    log(`✓ Vault entry "gcp_project_id" cleared and Firebase integration reset.`);
    return {
      reconciled: true,
      message: `GCP project "${storedId}" submitted for deletion. Projects remain in "pending delete" for 30 days before permanent removal.`,
      resourcesProduced: {},
    };
  },

  async validate(context: StepHandlerContext): Promise<StepHandlerResult> {
    const { projectId, vaultManager, passphrase } = context;
    const log = makeLog('create-gcp-project:validate', projectId);

    const storedId = getStoredGcpProjectId(vaultManager, passphrase, projectId);
    if (!storedId) {
      log('✗ No GCP project ID in vault.');
      return { reconciled: false, message: 'No GCP project ID stored. Complete "Create GCP Project" first.' };
    }

    log(`Validating GCP project "${storedId}" is accessible...`);
    try {
      const token = await context.getToken('gcp');
      const status = await getGcpProjectStatus(token, storedId);
      if (status === 'found') {
        log(`✓ GCP project "${storedId}" is ACTIVE and accessible.`);
        return { reconciled: true, resourcesProduced: { gcp_project_id: storedId } };
      }
      if (status === 'not_found') {
        log(`✗ GCP project "${storedId}" was NOT FOUND — it may have been deleted externally.`);
        return { reconciled: false, message: `GCP project "${storedId}" not found in GCP. It may have been deleted.` };
      }
      log(`✗ GCP project "${storedId}" returned 403 — token lacks permission to read this project.`);
      return {
        reconciled: false,
        message: `GCP project "${storedId}" is inaccessible (403). Token may be for a different Google account.`,
        suggestsReauth: true,
      };
    } catch (err) {
      log(`✗ Validation error: ${(err as Error).message}`);
      return { reconciled: false, message: (err as Error).message };
    }
  },

  async sync(context: StepHandlerContext): Promise<StepHandlerResult | null> {
    const { projectId, vaultManager, passphrase, projectManager } = context;
    const log = makeLog('create-gcp-project:sync', projectId);

    const storedId = getStoredGcpProjectId(vaultManager, passphrase, projectId);

    if (storedId) {
      log(`Vault has GCP project ID "${storedId}" — verifying it still exists...`);
      try {
        const token = await context.getToken('gcp');
        const summary = await fetchGcpProjectSummary(token, storedId);
        if (!summary.ok) {
          if (summary.reason === 'not_found') {
            log(`✗ GCP project "${storedId}" no longer exists. Revert this step to unlink it.`);
            return { reconciled: false, message: `GCP project "${storedId}" no longer exists in GCP.` };
          }
          // 403: project exists but this token can't read it — project was provisioned, treat as reconciled
          log(`GCP project "${storedId}" returned 403 — exists but this token cannot read it. Treating as reconciled.`);
        } else {
          log(`✓ GCP project "${storedId}" is ${summary.lifecycleState ?? 'ACTIVE'}.`);
        }
      } catch (err) {
        log(`✗ Failed to verify project "${storedId}": ${(err as Error).message}`);
        return { reconciled: false, message: `Could not verify GCP project: ${(err as Error).message}` };
      }
      return { reconciled: true, resourcesProduced: { gcp_project_id: storedId } };
    }

    // No stored ID — try to discover via OAuth
    if (!context.hasToken('gcp')) {
      log('No stored GCP project and no OAuth session available — re-auth needed to discover/create.');
      return {
        reconciled: false,
        message: 'No GCP project linked and no Google OAuth session. Sign in with Google to create or discover the project.',
        suggestsReauth: true,
      };
    }

    log('No stored GCP project — searching for it by expected ID or display name...');
    const token = await context.getToken('gcp');
    const expectedId = buildStudioGcpProjectId(projectId);
    const displayName = `Studio ${projectId}`;
    const userEmail =
      vaultManager.getCredential(passphrase, 'firebase', `${projectId}/connected_by_email`) ?? 'unknown';

    const byId = await fetchGcpProjectSummary(token, expectedId);
    if (byId.ok) {
      log(`✓ Found project by expected ID "${expectedId}" — linking to studio project.`);
      storeGcpProjectId(vaultManager, passphrase, projectId, expectedId);
      applyGcpProjectLinked(projectManager, projectId, expectedId, userEmail);
      return { reconciled: true, resourcesProduced: { gcp_project_id: expectedId } };
    }

    log(`No project at "${expectedId}" — searching accessible projects by display name "${displayName}"...`);
    const matches = await findGcpProjectsByDisplayName(token, displayName);
    if (matches.length === 0) {
      log(`No projects named "${displayName}" found. This step must be run to create it.`);
      return {
        reconciled: false,
        message: `No GCP project with ID "${expectedId}" or display name "${displayName}" found. Run this step to create it.`,
      };
    }
    if (matches.length > 1) {
      log(`✗ ${matches.length} projects named "${displayName}" found — ambiguous. Resolve in Cloud Console.`);
      return {
        reconciled: false,
        message: `Multiple GCP projects named "${displayName}" exist. Rename or delete duplicates in Cloud Console.`,
      };
    }

    const chosen = matches[0]!;
    log(`✓ Linked GCP project "${chosen.projectId}" found by display name. Storing in vault.`);
    storeGcpProjectId(vaultManager, passphrase, projectId, chosen.projectId);
    applyGcpProjectLinked(projectManager, projectId, chosen.projectId, userEmail);
    return { reconciled: true, resourcesProduced: { gcp_project_id: chosen.projectId } };
  },
};

// ---------------------------------------------------------------------------
// firebase:enable-firebase
// Validates the GCP project is set up before SA creation proceeds.
// Firebase services activate automatically once the project exists.
// ---------------------------------------------------------------------------

const enableFirebaseHandler: StepHandler = {
  stepKey: 'firebase:enable-firebase',
  requiredAuth: 'gcp',

  async create(context: StepHandlerContext): Promise<StepHandlerResult> {
    const { projectId, vaultManager, passphrase } = context;
    const log = makeLog('enable-firebase', projectId);
    const pid =
      getStoredGcpProjectId(vaultManager, passphrase, projectId) ??
      context.upstreamArtifacts['gcp_project_id'];

    if (!pid) {
      log('✗ No GCP project ID in vault or upstream artifacts. "Create GCP Project" must run first.');
      return { reconciled: false, message: 'GCP project not set up. Run "Create GCP Project" first.' };
    }

    log(`→ Checking if firebase.googleapis.com is enabled on "${pid}"...`);
    const token = await context.getToken('gcp');
    const alreadyEnabled = await isServiceEnabled(token, pid, 'firebase.googleapis.com');
    if (alreadyEnabled) {
      log(`✓ firebase.googleapis.com is already ENABLED on "${pid}".`);
      return { reconciled: true, resourcesProduced: { firebase_project_id: pid } };
    }

    log(`→ Enabling firebase.googleapis.com on "${pid}"...`);
    const ok = await enableProjectService(pid, token, 'firebase.googleapis.com');
    if (!ok) {
      log(`✗ Failed to enable firebase.googleapis.com on "${pid}".`);
      return { reconciled: false, message: `Could not enable firebase.googleapis.com on GCP project "${pid}".` };
    }
    log(`→ Waiting 4s for API propagation on "${pid}"...`);
    await sleep(4000);
    log(`✓ COMPLETE — firebase.googleapis.com ENABLED on "${pid}".`);
    return { reconciled: true, resourcesProduced: { firebase_project_id: pid } };
  },

  async delete(_context: StepHandlerContext): Promise<StepHandlerResult> {
    const log = makeLog('enable-firebase:delete', _context.projectId);
    // firebase.googleapis.com cannot be selectively disabled via the API — it is tied to the GCP project lifecycle.
    log('○ firebase.googleapis.com cannot be disabled independently. Delete the GCP project to remove Firebase.');
    return {
      reconciled: true,
      message: 'Firebase is bound to the GCP project lifecycle. Delete the GCP project (revert "Create GCP Project") to remove it.',
    };
  },

  async validate(context: StepHandlerContext): Promise<StepHandlerResult> {
    const { projectId, vaultManager, passphrase } = context;
    const log = makeLog('enable-firebase:validate', projectId);

    const pid = getStoredGcpProjectId(vaultManager, passphrase, projectId);
    if (!pid) {
      log('✗ No GCP project ID in vault.');
      return { reconciled: false, message: 'No GCP project ID stored — "Create GCP Project" must complete first.' };
    }

    log(`→ Verifying firebase.googleapis.com is enabled on "${pid}"...`);
    try {
      const token = await context.getToken('gcp');
      const enabled = await isServiceEnabled(token, pid, 'firebase.googleapis.com');
      if (enabled) {
        log(`✓ firebase.googleapis.com is ENABLED on "${pid}".`);
        return { reconciled: true, resourcesProduced: { firebase_project_id: pid } };
      }
      log(`✗ firebase.googleapis.com is NOT ENABLED on "${pid}".`);
      return { reconciled: false, message: `firebase.googleapis.com is not enabled on "${pid}". Re-run this step.` };
    } catch (err) {
      const is403 = err instanceof GcpHttpError && err.statusCode === 403;
      log(`✗ Failed to check service status: ${(err as Error).message}`);
      return { reconciled: false, message: `Could not verify Firebase status: ${(err as Error).message}`, suggestsReauth: is403 };
    }
  },

  async sync(context: StepHandlerContext): Promise<StepHandlerResult | null> {
    const { projectId, vaultManager, passphrase } = context;
    const log = makeLog('enable-firebase:sync', projectId);

    const pid = getStoredGcpProjectId(vaultManager, passphrase, projectId);
    if (!pid) return null; // upstream not complete — skip silently

    log(`→ Checking firebase.googleapis.com service state on "${pid}"...`);
    try {
      const token = await context.getToken('gcp');
      const enabled = await isServiceEnabled(token, pid, 'firebase.googleapis.com');
      if (enabled) {
        log(`✓ firebase.googleapis.com is ENABLED on "${pid}".`);
        return { reconciled: true, resourcesProduced: { firebase_project_id: pid } };
      }
      log(`○ firebase.googleapis.com is NOT ENABLED on "${pid}" — run this step to enable it.`);
      return { reconciled: false, message: `firebase.googleapis.com is not enabled on "${pid}". Run this step to enable it.` };
    } catch (err) {
      const is403 = err instanceof GcpHttpError && err.statusCode === 403;
      log(`✗ Could not check firebase.googleapis.com status: ${(err as Error).message}`);
      return { reconciled: false, message: `Could not verify Firebase status: ${(err as Error).message}`, suggestsReauth: is403 };
    }
  },
};

// ---------------------------------------------------------------------------
// firebase:create-provisioner-sa
// ---------------------------------------------------------------------------

const createProvisionerSaHandler: StepHandler = {
  stepKey: 'firebase:create-provisioner-sa',
  requiredAuth: 'gcp',

  async create(context: StepHandlerContext): Promise<StepHandlerResult> {
    const { projectId, vaultManager, passphrase } = context;
    const log = makeLog('create-provisioner-sa', projectId);

    const gcpProjectId = getStoredGcpProjectId(vaultManager, passphrase, projectId);
    if (!gcpProjectId) {
      log('✗ No GCP project ID in vault — "Create GCP Project" must complete first.');
      return { reconciled: false, message: 'GCP project ID not in vault. Complete "Create GCP Project" first.' };
    }

    const expectedEmail = provisionerSaEmail(gcpProjectId);
    log(`→ Ensuring service account "${expectedEmail}" exists on project "${gcpProjectId}"...`);

    const token = await context.getToken('gcp');
    const saEmail = await ensureProvisionerServiceAccount(token, gcpProjectId);
    storeSaEmail(vaultManager, passphrase, projectId, saEmail);

    log(`✓ COMPLETE — Service account "${saEmail}" is ready and stored in vault.`);
    return { reconciled: true, resourcesProduced: { provisioner_sa_email: saEmail } };
  },

  async delete(context: StepHandlerContext): Promise<StepHandlerResult> {
    const { projectId, vaultManager, passphrase } = context;
    const log = makeLog('create-provisioner-sa:delete', projectId);

    const gcpProjectId = getStoredGcpProjectId(vaultManager, passphrase, projectId);
    const saEmail = getStoredSaEmail(vaultManager, passphrase, projectId);

    if (!gcpProjectId || !saEmail) {
      log('No service account metadata in vault — nothing to delete.');
      return { reconciled: true, message: 'No service account metadata — nothing to delete.' };
    }

    log(`→ Deleting service account "${saEmail}" from project "${gcpProjectId}"...`);
    try {
      const token = await context.getToken('gcp');
      const result = await deleteServiceAccount(token, gcpProjectId, saEmail);
      vaultManager.deleteCredential(passphrase, 'firebase', `${projectId}/service_account_email`);
      const msg =
        result === 'deleted'
          ? `Deleted service account "${saEmail}".`
          : `Service account "${saEmail}" was already absent.`;
      log(`✓ ${msg}`);
      return { reconciled: true, message: msg, resourcesProduced: {} };
    } catch (err) {
      const msg = (err as Error).message;
      log(`✗ Failed to delete service account "${saEmail}": ${msg}`);
      return { reconciled: false, message: msg };
    }
  },

  async validate(context: StepHandlerContext): Promise<StepHandlerResult> {
    const { projectId, vaultManager, passphrase } = context;
    const log = makeLog('create-provisioner-sa:validate', projectId);

    const gcpProjectId = getStoredGcpProjectId(vaultManager, passphrase, projectId);
    const saEmail = getStoredSaEmail(vaultManager, passphrase, projectId);

    if (!gcpProjectId || !saEmail) {
      log('✗ Missing GCP project ID or SA email in vault.');
      return { reconciled: false, message: 'No service account email stored. Complete prior steps first.' };
    }

    log(`Validating service account "${saEmail}" on project "${gcpProjectId}"...`);
    const saPath = `/v1/projects/${gcpProjectId}/serviceAccounts/${encodeURIComponent(saEmail)}`;

    try {
      const token = await context.getToken('gcp');
      await withApiRetry(
        gcpProjectId,
        token,
        () => gcpRequest('GET', 'iam.googleapis.com', saPath, token),
        log,
      );
      log(`✓ Service account "${saEmail}" exists and is accessible.`);
      return { reconciled: true, resourcesProduced: { provisioner_sa_email: saEmail } };
    } catch (err) {
      if (err instanceof GcpHttpError && err.statusCode === 404) {
        log(`✗ Service account "${saEmail}" NOT FOUND — it may have been deleted externally.`);
        return {
          reconciled: false,
          message: `Service account "${saEmail}" not found in project "${gcpProjectId}". Revert and re-run this step.`,
        };
      }
      if (err instanceof GcpHttpError && err.statusCode === 403) {
        log(`✗ 403 accessing service account "${saEmail}" — token lacks IAM read permission.`);
        return {
          reconciled: false,
          message: 'Permission denied reading service account. Token may be expired or for the wrong account.',
          suggestsReauth: true,
        };
      }
      log(`✗ Unexpected error: ${(err as Error).message}`);
      return { reconciled: false, message: (err as Error).message };
    }
  },

  async sync(context: StepHandlerContext): Promise<StepHandlerResult | null> {
    const { projectId, vaultManager, passphrase } = context;
    const log = makeLog('create-provisioner-sa:sync', projectId);

    const gcpProjectId = getStoredGcpProjectId(vaultManager, passphrase, projectId);
    if (!gcpProjectId) {
      return { reconciled: false, message: 'GCP project not set up. Run "Create GCP Project" first.' };
    }

    const storedEmail = getStoredSaEmail(vaultManager, passphrase, projectId);
    if (!storedEmail) {
      log('○ No provisioner SA email in vault — step has not run yet.');
      return { reconciled: false, message: 'No provisioner service account recorded. Run this step to create one.' };
    }

    // Sync is read-only: verify the stored SA still exists in GCP. Do not auto-create.
    log(`→ Verifying service account "${storedEmail}" on project "${gcpProjectId}"...`);
    const saPath = `/v1/projects/${gcpProjectId}/serviceAccounts/${encodeURIComponent(storedEmail)}`;
    try {
      const token = await context.getToken('gcp');
      await gcpRequest('GET', 'iam.googleapis.com', saPath, token);
      log(`✓ Service account "${storedEmail}" exists in GCP.`);
      return { reconciled: true, resourcesProduced: { provisioner_sa_email: storedEmail } };
    } catch (err) {
      if (err instanceof GcpHttpError && err.statusCode === 404) {
        log(`✗ Service account "${storedEmail}" no longer exists in GCP — revert and re-run this step.`);
        return { reconciled: false, message: `Service account "${storedEmail}" was deleted from GCP. Revert and re-run this step.` };
      }
      if (err instanceof GcpHttpError && err.statusCode === 403) {
        log(`✗ 403 verifying SA "${storedEmail}" — token may be expired or for the wrong account.`);
        return { reconciled: false, message: 'Permission denied reading service account. Re-authenticate with Google.', suggestsReauth: true };
      }
      log(`✗ Unexpected error verifying SA: ${(err as Error).message}`);
      return { reconciled: false, message: `Could not verify service account: ${(err as Error).message}` };
    }
  },
};

// ---------------------------------------------------------------------------
// firebase:bind-provisioner-iam
// ---------------------------------------------------------------------------

const bindProvisionerIamHandler: StepHandler = {
  stepKey: 'firebase:bind-provisioner-iam',
  requiredAuth: 'gcp',

  async create(context: StepHandlerContext): Promise<StepHandlerResult> {
    const { projectId, vaultManager, passphrase } = context;
    const log = makeLog('bind-provisioner-iam', projectId);

    const gcpProjectId = getStoredGcpProjectId(vaultManager, passphrase, projectId);
    const saEmail =
      getStoredSaEmail(vaultManager, passphrase, projectId) ??
      context.upstreamArtifacts['provisioner_sa_email'];

    if (!gcpProjectId || !saEmail) {
      log('✗ Missing GCP project ID or SA email — prior steps must complete first.');
      return { reconciled: false, message: 'GCP project or service account not set up. Run prior steps first.' };
    }

    const member = `serviceAccount:${saEmail}`;
    log(`→ Granting provisioner IAM roles to "${member}" on project "${gcpProjectId}"...`);
    log(`  Roles: roles/firebase.admin, roles/iam.serviceAccountAdmin, roles/iam.serviceAccountKeyAdmin,`);
    log(`         roles/serviceusage.serviceUsageAdmin, roles/cloudkms.admin`);

    // Service accounts need a few seconds to propagate globally in GCP IAM before bindings can be set.
    log(`→ Waiting 3s for SA "${saEmail}" to propagate in GCP IAM...`);
    await sleep(3000);

    const token = await context.getToken('gcp');
    await grantProvisionerRoles(token, gcpProjectId, saEmail);

    log(`✓ COMPLETE — All provisioner IAM roles granted to "${member}".`);
    return { reconciled: true, resourcesProduced: {} };
  },

  async delete(context: StepHandlerContext): Promise<StepHandlerResult> {
    const { projectId, vaultManager, passphrase } = context;
    const log = makeLog('bind-provisioner-iam:delete', projectId);

    const gcpProjectId = getStoredGcpProjectId(vaultManager, passphrase, projectId);
    const saEmail = getStoredSaEmail(vaultManager, passphrase, projectId);

    if (!gcpProjectId || !saEmail) {
      log('No IAM metadata in vault — nothing to remove.');
      return { reconciled: true, message: 'No IAM metadata — nothing to remove.' };
    }

    log(`→ Removing provisioner IAM bindings for "serviceAccount:${saEmail}" from project "${gcpProjectId}"...`);
    try {
      const token = await context.getToken('gcp');
      await removeProvisionerRoles(token, gcpProjectId, saEmail);
      log(`✓ Provisioner IAM role bindings removed.`);
      return {
        reconciled: true,
        message: `Removed provisioner role bindings for ${saEmail} from project ${gcpProjectId}.`,
        resourcesProduced: {},
      };
    } catch (err) {
      const msg = (err as Error).message;
      log(`✗ Failed to remove IAM bindings: ${msg}`);
      return { reconciled: false, message: msg };
    }
  },

  async validate(context: StepHandlerContext): Promise<StepHandlerResult> {
    const { projectId, vaultManager, passphrase } = context;
    const log = makeLog('bind-provisioner-iam:validate', projectId);

    const gcpProjectId = getStoredGcpProjectId(vaultManager, passphrase, projectId);
    const saEmail = getStoredSaEmail(vaultManager, passphrase, projectId);

    if (!gcpProjectId || !saEmail) {
      log('✗ Missing GCP project ID or SA email in vault.');
      return { reconciled: false, message: 'No connection metadata for IAM check.' };
    }

    const member = `serviceAccount:${saEmail}`;
    log(`Checking IAM policy for "${member}" on project "${gcpProjectId}"...`);

    try {
      const token = await context.getToken('gcp');
      const missing = await withApiRetry(
        gcpProjectId,
        token,
        () => findMissingProvisionerRoles(token, gcpProjectId, member),
        log,
      );

      if (missing.length === 0) {
        log(`✓ All provisioner IAM roles are bound for "${member}".`);
        return { reconciled: true, resourcesProduced: {} };
      }
      log(`✗ Missing IAM roles for "${member}": ${missing.join(', ')}`);
      return { reconciled: false, message: `Missing IAM role bindings: ${missing.join(', ')}` };
    } catch (err) {
      const is403 = err instanceof GcpHttpError && err.statusCode === 403;
      log(`✗ IAM policy check error: ${(err as Error).message}`);
      return { reconciled: false, message: (err as Error).message, suggestsReauth: is403 };
    }
  },

  async sync(context: StepHandlerContext): Promise<StepHandlerResult | null> {
    const { projectId, vaultManager, passphrase } = context;
    const log = makeLog('bind-provisioner-iam:sync', projectId);

    const gcpProjectId = getStoredGcpProjectId(vaultManager, passphrase, projectId);
    const saEmail = getStoredSaEmail(vaultManager, passphrase, projectId);

    if (!gcpProjectId || !saEmail) {
      return { reconciled: false, message: 'GCP project or service account not set up. Run prior steps first.' };
    }

    // Sync is read-only: check current IAM state against required roles. Do not auto-grant.
    const member = `serviceAccount:${saEmail}`;
    log(`→ Checking IAM bindings for "${member}" on "${gcpProjectId}"...`);

    try {
      const token = await context.getToken('gcp');
      const missing = await findMissingProvisionerRoles(token, gcpProjectId, member);
      if (missing.length === 0) {
        log(`✓ All provisioner IAM roles are present for "${member}".`);
        return { reconciled: true, resourcesProduced: {} };
      }
      log(`✗ Missing ${missing.length} role(s) for "${member}": ${missing.join(', ')} — run this step to bind them.`);
      return { reconciled: false, message: `Missing IAM role bindings: ${missing.join(', ')}. Run this step to apply them.` };
    } catch (err) {
      const is403 = err instanceof GcpHttpError && err.statusCode === 403;
      log(`✗ IAM policy check error: ${(err as Error).message}`);
      return { reconciled: false, message: `IAM check failed: ${(err as Error).message}`, suggestsReauth: is403 };
    }
  },
};

// ---------------------------------------------------------------------------
// firebase:generate-sa-key
// ---------------------------------------------------------------------------

const generateSaKeyHandler: StepHandler = {
  stepKey: 'firebase:generate-sa-key',
  requiredAuth: 'gcp',

  async create(context: StepHandlerContext): Promise<StepHandlerResult> {
    const { projectId, vaultManager, passphrase, projectManager } = context;
    const log = makeLog('generate-sa-key', projectId);

    const gcpProjectId = getStoredGcpProjectId(vaultManager, passphrase, projectId);
    const saEmail =
      getStoredSaEmail(vaultManager, passphrase, projectId) ??
      context.upstreamArtifacts['provisioner_sa_email'];

    if (!gcpProjectId || !saEmail) {
      log('✗ Missing GCP project ID or SA email — prior steps must complete first.');
      return { reconciled: false, message: 'GCP project or service account not set up. Run prior steps first.' };
    }

    log(`→ Generating JSON key for service account "${saEmail}" on project "${gcpProjectId}"...`);
    const token = await context.getToken('gcp');
    const saKeyJson = await createServiceAccountKey(token, gcpProjectId, saEmail);
    recordProvisionerServiceAccountKey(
      vaultManager,
      passphrase,
      projectManager,
      projectId,
      gcpProjectId,
      saEmail,
      saKeyJson,
    );

    log(`✓ COMPLETE — SA key generated, vaulted, and Firebase integration marked as fully connected.`);
    return { reconciled: true, resourcesProduced: { service_account_json: 'vaulted' } };
  },

  async delete(context: StepHandlerContext): Promise<StepHandlerResult> {
    const { projectId, vaultManager, passphrase } = context;
    const log = makeLog('generate-sa-key:delete', projectId);

    const raw = getStoredSaKeyJson(vaultManager, passphrase, projectId);
    const gcpProjectId = getStoredGcpProjectId(vaultManager, passphrase, projectId);
    const saEmail = getStoredSaEmail(vaultManager, passphrase, projectId);

    // Attempt to delete the actual GCP key resource before clearing the vault.
    if (raw && gcpProjectId && saEmail) {
      try {
        const parsed = JSON.parse(raw) as { private_key_id?: string };
        const keyId = parsed.private_key_id;
        if (keyId) {
          log(`→ Deleting GCP SA key "${keyId}" from project "${gcpProjectId}"...`);
          const token = await context.getToken('gcp');
          const outcome = await deleteServiceAccountKey(token, gcpProjectId, saEmail, keyId);
          if (outcome === 'deleted') {
            log(`✓ GCP SA key "${keyId}" deleted from IAM.`);
          } else {
            log(`○ GCP SA key "${keyId}" was already absent in IAM.`);
          }
        } else {
          log('○ No private_key_id in vault JSON — skipping GCP key deletion.');
        }
      } catch (err) {
        log(`✗ Failed to delete GCP SA key: ${(err as Error).message} — clearing vault anyway.`);
      }
    }

    deleteSaKeyJson(vaultManager, passphrase, projectId);
    log('✓ Service account key JSON cleared from vault.');
    return { reconciled: true, message: 'Service account key deleted from GCP and cleared from vault.', resourcesProduced: {} };
  },

  async validate(context: StepHandlerContext): Promise<StepHandlerResult> {
    const { projectId, vaultManager, passphrase } = context;
    const log = makeLog('generate-sa-key:validate', projectId);

    const raw = getStoredSaKeyJson(vaultManager, passphrase, projectId);
    if (!raw) {
      log('✗ No service_account_json found in vault.');
      return { reconciled: false, message: 'No service account key JSON in vault. Run this step to generate one.' };
    }

    try {
      const parsed = JSON.parse(raw) as { type?: string; project_id?: string; client_email?: string };
      if (parsed.type !== 'service_account') {
        log(`✗ Vault payload has unexpected type "${parsed.type}" (expected "service_account").`);
        return {
          reconciled: false,
          message: 'Vault payload is not a valid service account JSON (type !== "service_account").',
        };
      }
      log(`✓ Service account key present: email="${parsed.client_email}" project="${parsed.project_id}".`);
      return { reconciled: true, resourcesProduced: { service_account_json: 'vaulted' } };
    } catch {
      log('✗ Vault payload is not parseable JSON.');
      return { reconciled: false, message: 'Vault payload is not valid JSON. Revert and re-run this step.' };
    }
  },

  async sync(context: StepHandlerContext): Promise<StepHandlerResult | null> {
    const { projectId, vaultManager, passphrase } = context;
    const log = makeLog('generate-sa-key:sync', projectId);

    // Sync is read-only: only check what is already in the vault.
    // Regeneration belongs in create — doing it here would immediately undo a reset.
    const raw = getStoredSaKeyJson(vaultManager, passphrase, projectId);
    if (!raw?.trim()) {
      log('○ No service account key JSON in vault — step is not complete.');
      return { reconciled: false, message: 'No service account key in vault. Run this step to generate one.' };
    }

    try {
      const parsed = JSON.parse(raw) as { type?: string; client_email?: string; project_id?: string };
      if (parsed.type !== 'service_account') {
        log(`✗ Vault payload has unexpected type "${parsed.type}" — re-run this step.`);
        return { reconciled: false, message: 'Vault payload is not a valid service account JSON.' };
      }
      log(`✓ Valid service account key in vault: email="${parsed.client_email}" project="${parsed.project_id}".`);
      return { reconciled: true, resourcesProduced: { service_account_json: 'vaulted' } };
    } catch {
      log('✗ Vault payload is not parseable JSON — re-run this step.');
      return { reconciled: false, message: 'Vault payload is not valid JSON. Revert and re-run this step.' };
    }
  },
};

// ---------------------------------------------------------------------------
// firebase:enable-services
// Enables Auth, Firestore, Storage, FCM, and Rules GCP APIs on the project.
// Per-environment step — idempotent; safe to run multiple times.
// ---------------------------------------------------------------------------

const FIREBASE_SERVICE_APIS = [
  'identitytoolkit.googleapis.com',  // Firebase Auth
  'firestore.googleapis.com',         // Cloud Firestore
  'storage.googleapis.com',           // Cloud Storage
  'fcmregistrations.googleapis.com',  // Firebase Cloud Messaging
  'firebaserules.googleapis.com',     // Firebase Security Rules
] as const;

const enableServicesHandler: StepHandler = {
  stepKey: 'firebase:enable-services',
  requiredAuth: 'gcp',

  async create(context: StepHandlerContext): Promise<StepHandlerResult> {
    const { projectId, vaultManager, passphrase } = context;
    const log = makeLog('enable-services', projectId);

    const gcpProjectId = getStoredGcpProjectId(vaultManager, passphrase, projectId);
    if (!gcpProjectId) {
      log('✗ No GCP project ID in vault. Complete "Create GCP Project" first.');
      return { reconciled: false, message: 'GCP project not set up. Run "Create GCP Project" first.' };
    }

    const token = await context.getToken('gcp');
    const failed: string[] = [];

    for (const api of FIREBASE_SERVICE_APIS) {
      log(`→ Enabling ${api} on "${gcpProjectId}"...`);
      const ok = await enableProjectService(gcpProjectId, token, api);
      if (ok) {
        log(`✓ ${api} enabled.`);
      } else {
        log(`✗ Failed to enable ${api}.`);
        failed.push(api);
      }
    }

    if (failed.length > 0) {
      return { reconciled: false, message: `Failed to enable the following APIs on "${gcpProjectId}": ${failed.join(', ')}` };
    }

    log(`→ Waiting 4s for API propagation on "${gcpProjectId}"...`);
    await sleep(4000);
    log(`✓ COMPLETE — All Firebase service APIs enabled on "${gcpProjectId}".`);
    return { reconciled: true, resourcesProduced: { enabled_services: FIREBASE_SERVICE_APIS.join(',') } };
  },

  async delete(_context: StepHandlerContext): Promise<StepHandlerResult> {
    const log = makeLog('enable-services:delete', _context.projectId);
    log('○ Firebase service APIs cannot be selectively disabled — no API action taken.');
    return {
      reconciled: true,
      message: 'Firebase services (Auth, Firestore, Storage, FCM) cannot be disabled via API without data loss. Disable manually in Cloud Console if needed.',
    };
  },

  async validate(context: StepHandlerContext): Promise<StepHandlerResult> {
    const { projectId, vaultManager, passphrase } = context;
    const log = makeLog('enable-services:validate', projectId);

    const gcpProjectId = getStoredGcpProjectId(vaultManager, passphrase, projectId);
    if (!gcpProjectId) {
      log('✗ No GCP project ID in vault.');
      return { reconciled: false, message: 'GCP project not set up. Run "Create GCP Project" first.' };
    }

    log(`→ Checking Firebase service APIs on "${gcpProjectId}"...`);
    const token = await context.getToken('gcp');
    const missing: string[] = [];
    for (const api of FIREBASE_SERVICE_APIS) {
      const enabled = await isServiceEnabled(token, gcpProjectId, api);
      if (!enabled) missing.push(api);
    }

    if (missing.length === 0) {
      log(`✓ All Firebase service APIs are enabled on "${gcpProjectId}".`);
      return { reconciled: true, resourcesProduced: { enabled_services: FIREBASE_SERVICE_APIS.join(',') } };
    }
    log(`✗ Missing APIs: ${missing.join(', ')}`);
    return { reconciled: false, message: `APIs not yet enabled on "${gcpProjectId}": ${missing.join(', ')}. Run this step to enable them.` };
  },

  async sync(context: StepHandlerContext): Promise<StepHandlerResult | null> {
    const { projectId, vaultManager, passphrase } = context;
    const log = makeLog('enable-services:sync', projectId);

    const gcpProjectId = getStoredGcpProjectId(vaultManager, passphrase, projectId);
    if (!gcpProjectId) return null;

    log(`→ Checking Firebase service APIs on "${gcpProjectId}"...`);
    try {
      const token = await context.getToken('gcp');
      const missing: string[] = [];
      for (const api of FIREBASE_SERVICE_APIS) {
        const enabled = await isServiceEnabled(token, gcpProjectId, api);
        if (!enabled) missing.push(api);
      }
      if (missing.length === 0) {
        log(`✓ All Firebase service APIs enabled.`);
        return { reconciled: true, resourcesProduced: { enabled_services: FIREBASE_SERVICE_APIS.join(',') } };
      }
      log(`○ Missing: ${missing.join(', ')} — run this step to enable them.`);
      return { reconciled: false, message: `APIs not enabled: ${missing.join(', ')}.` };
    } catch (err) {
      const is403 = err instanceof GcpHttpError && err.statusCode === 403;
      log(`✗ Could not check service APIs: ${(err as Error).message}`);
      return { reconciled: false, message: `Could not verify Firebase services: ${(err as Error).message}`, suggestsReauth: is403 };
    }
  },
};

// ---------------------------------------------------------------------------
// firebase:register-ios-app
// ---------------------------------------------------------------------------

const registerIosAppHandler: StepHandler = {
  stepKey: 'firebase:register-ios-app',
  requiredAuth: 'gcp',

  async create(context: StepHandlerContext): Promise<StepHandlerResult> {
    const { projectId, vaultManager, passphrase, projectManager } = context;
    const log = makeLog('register-ios-app', projectId);

    const gcpProjectId = getStoredGcpProjectId(vaultManager, passphrase, projectId);
    if (!gcpProjectId) {
      log('✗ No GCP project ID in vault. Complete "Create GCP Project" first.');
      return { reconciled: false, message: 'GCP project not set up. Run "Create GCP Project" first.' };
    }

    const module = projectManager.getProject(projectId);
    const bundleId = module.project.bundleId;
    const displayName = module.project.name;

    log(`→ Checking for existing iOS app with bundle ID "${bundleId}" on "${gcpProjectId}"...`);
    const token = await context.getToken('gcp');
    const existing = await listFirebaseIosApps(token, gcpProjectId);
    const match = existing.find((a) => a.bundleId === bundleId);

    if (match) {
      log(`✓ iOS app "${bundleId}" already registered (appId=${match.appId}). Storing in vault.`);
      storeFirebaseIosAppId(vaultManager, passphrase, projectId, match.appId);
      return { reconciled: true, resourcesProduced: { firebase_ios_app_id: match.appId } };
    }

    log(`→ Registering iOS app "${bundleId}" (displayName="${displayName}") — awaiting Firebase operation...`);
    const appId = await registerFirebaseIosApp(token, gcpProjectId, bundleId, displayName);
    storeFirebaseIosAppId(vaultManager, passphrase, projectId, appId);

    log(`✓ COMPLETE — iOS app registered. appId="${appId}"`);
    return { reconciled: true, resourcesProduced: { firebase_ios_app_id: appId } };
  },

  async delete(context: StepHandlerContext): Promise<StepHandlerResult> {
    const { projectId, vaultManager, passphrase } = context;
    const log = makeLog('register-ios-app:delete', projectId);
    // Firebase does not support deleting app registrations via the Management API.
    const stored = getStoredFirebaseIosAppId(vaultManager, passphrase, projectId);
    if (stored) {
      vaultManager.deleteCredential(passphrase, 'firebase', `${projectId}/firebase_ios_app_id`);
      log(`○ Removed vault entry for iOS appId "${stored}". The Firebase registration itself must be deleted via Cloud Console.`);
    } else {
      log('○ No iOS app ID in vault — nothing to clear.');
    }
    return {
      reconciled: true,
      message: 'Firebase does not support programmatic app deletion. The vault entry was cleared. Delete the app in the Firebase Console if needed.',
    };
  },

  async validate(context: StepHandlerContext): Promise<StepHandlerResult> {
    const { projectId, vaultManager, passphrase, projectManager } = context;
    const log = makeLog('register-ios-app:validate', projectId);

    const gcpProjectId = getStoredGcpProjectId(vaultManager, passphrase, projectId);
    const storedAppId = getStoredFirebaseIosAppId(vaultManager, passphrase, projectId);
    if (!gcpProjectId || !storedAppId) {
      log('✗ No GCP project or iOS app ID in vault.');
      return { reconciled: false, message: 'iOS app not registered. Run this step to register it.' };
    }

    const module = projectManager.getProject(projectId);
    const bundleId = module.project.bundleId;
    log(`→ Verifying iOS app "${bundleId}" (appId=${storedAppId}) on "${gcpProjectId}"...`);
    const token = await context.getToken('gcp');
    const apps = await listFirebaseIosApps(token, gcpProjectId);
    const found = apps.find((a) => a.appId === storedAppId);
    if (found) {
      log(`✓ iOS app "${storedAppId}" (bundleId="${found.bundleId}") is registered.`);
      return { reconciled: true, resourcesProduced: { firebase_ios_app_id: storedAppId } };
    }
    log(`✗ iOS appId "${storedAppId}" not found in Firebase — re-run this step.`);
    return { reconciled: false, message: `iOS app "${storedAppId}" not found in Firebase project "${gcpProjectId}". Re-run this step.` };
  },

  async sync(context: StepHandlerContext): Promise<StepHandlerResult | null> {
    const { projectId, vaultManager, passphrase, projectManager } = context;
    const log = makeLog('register-ios-app:sync', projectId);

    const gcpProjectId = getStoredGcpProjectId(vaultManager, passphrase, projectId);
    if (!gcpProjectId) return null;

    const module = projectManager.getProject(projectId);
    const bundleId = module.project.bundleId;
    const storedAppId = getStoredFirebaseIosAppId(vaultManager, passphrase, projectId);

    log(`→ Looking for iOS app "${bundleId}" on Firebase project "${gcpProjectId}"...`);
    try {
      const token = await context.getToken('gcp');
      const apps = await listFirebaseIosApps(token, gcpProjectId);
      const match = apps.find((a) => a.bundleId === bundleId);
      if (match) {
        if (match.appId !== storedAppId) {
          log(`→ Updating vault: found appId "${match.appId}" for bundleId "${bundleId}" (was "${storedAppId ?? 'unset'}").`);
          storeFirebaseIosAppId(vaultManager, passphrase, projectId, match.appId);
        }
        log(`✓ iOS app "${bundleId}" is registered (appId=${match.appId}).`);
        return { reconciled: true, resourcesProduced: { firebase_ios_app_id: match.appId } };
      }
      log(`○ iOS app "${bundleId}" not registered on Firebase — run this step.`);
      return { reconciled: false, message: `iOS app "${bundleId}" not found in Firebase. Run this step to register it.` };
    } catch (err) {
      const is403 = err instanceof GcpHttpError && err.statusCode === 403;
      log(`✗ Failed to list Firebase iOS apps: ${(err as Error).message}`);
      return { reconciled: false, message: `Could not check iOS app registration: ${(err as Error).message}`, suggestsReauth: is403 };
    }
  },
};

// ---------------------------------------------------------------------------
// firebase:register-android-app
// ---------------------------------------------------------------------------

const registerAndroidAppHandler: StepHandler = {
  stepKey: 'firebase:register-android-app',
  requiredAuth: 'gcp',

  async create(context: StepHandlerContext): Promise<StepHandlerResult> {
    const { projectId, vaultManager, passphrase, projectManager } = context;
    const log = makeLog('register-android-app', projectId);

    const gcpProjectId = getStoredGcpProjectId(vaultManager, passphrase, projectId);
    if (!gcpProjectId) {
      log('✗ No GCP project ID in vault. Complete "Create GCP Project" first.');
      return { reconciled: false, message: 'GCP project not set up. Run "Create GCP Project" first.' };
    }

    const module = projectManager.getProject(projectId);
    const packageName = module.project.bundleId; // Android package name mirrors the iOS bundle ID convention
    const displayName = module.project.name;

    log(`→ Checking for existing Android app with package "${packageName}" on "${gcpProjectId}"...`);
    const token = await context.getToken('gcp');
    const existing = await listFirebaseAndroidApps(token, gcpProjectId);
    const match = existing.find((a) => a.packageName === packageName);

    if (match) {
      log(`✓ Android app "${packageName}" already registered (appId=${match.appId}). Storing in vault.`);
      storeFirebaseAndroidAppId(vaultManager, passphrase, projectId, match.appId);
      return { reconciled: true, resourcesProduced: { firebase_android_app_id: match.appId } };
    }

    log(`→ Registering Android app "${packageName}" (displayName="${displayName}") — awaiting Firebase operation...`);
    const appId = await registerFirebaseAndroidApp(token, gcpProjectId, packageName, displayName);
    storeFirebaseAndroidAppId(vaultManager, passphrase, projectId, appId);

    log(`✓ COMPLETE — Android app registered. appId="${appId}"`);
    return { reconciled: true, resourcesProduced: { firebase_android_app_id: appId } };
  },

  async delete(context: StepHandlerContext): Promise<StepHandlerResult> {
    const { projectId, vaultManager, passphrase } = context;
    const log = makeLog('register-android-app:delete', projectId);
    const stored = getStoredFirebaseAndroidAppId(vaultManager, passphrase, projectId);
    if (stored) {
      vaultManager.deleteCredential(passphrase, 'firebase', `${projectId}/firebase_android_app_id`);
      log(`○ Removed vault entry for Android appId "${stored}". The Firebase registration must be deleted via Cloud Console.`);
    } else {
      log('○ No Android app ID in vault — nothing to clear.');
    }
    return {
      reconciled: true,
      message: 'Firebase does not support programmatic app deletion. The vault entry was cleared. Delete the app in the Firebase Console if needed.',
    };
  },

  async validate(context: StepHandlerContext): Promise<StepHandlerResult> {
    const { projectId, vaultManager, passphrase, projectManager } = context;
    const log = makeLog('register-android-app:validate', projectId);

    const gcpProjectId = getStoredGcpProjectId(vaultManager, passphrase, projectId);
    const storedAppId = getStoredFirebaseAndroidAppId(vaultManager, passphrase, projectId);
    if (!gcpProjectId || !storedAppId) {
      log('✗ No GCP project or Android app ID in vault.');
      return { reconciled: false, message: 'Android app not registered. Run this step to register it.' };
    }

    const module = projectManager.getProject(projectId);
    const packageName = module.project.bundleId;
    log(`→ Verifying Android app "${packageName}" (appId=${storedAppId}) on "${gcpProjectId}"...`);
    const token = await context.getToken('gcp');
    const apps = await listFirebaseAndroidApps(token, gcpProjectId);
    const found = apps.find((a) => a.appId === storedAppId);
    if (found) {
      log(`✓ Android app "${storedAppId}" (package="${found.packageName}") is registered.`);
      return { reconciled: true, resourcesProduced: { firebase_android_app_id: storedAppId } };
    }
    log(`✗ Android appId "${storedAppId}" not found in Firebase — re-run this step.`);
    return { reconciled: false, message: `Android app "${storedAppId}" not found in Firebase project. Re-run this step.` };
  },

  async sync(context: StepHandlerContext): Promise<StepHandlerResult | null> {
    const { projectId, vaultManager, passphrase, projectManager } = context;
    const log = makeLog('register-android-app:sync', projectId);

    const gcpProjectId = getStoredGcpProjectId(vaultManager, passphrase, projectId);
    if (!gcpProjectId) return null;

    const module = projectManager.getProject(projectId);
    const packageName = module.project.bundleId;
    const storedAppId = getStoredFirebaseAndroidAppId(vaultManager, passphrase, projectId);

    log(`→ Looking for Android app "${packageName}" on Firebase project "${gcpProjectId}"...`);
    try {
      const token = await context.getToken('gcp');
      const apps = await listFirebaseAndroidApps(token, gcpProjectId);
      const match = apps.find((a) => a.packageName === packageName);
      if (match) {
        if (match.appId !== storedAppId) {
          log(`→ Updating vault: found appId "${match.appId}" for package "${packageName}" (was "${storedAppId ?? 'unset'}").`);
          storeFirebaseAndroidAppId(vaultManager, passphrase, projectId, match.appId);
        }
        log(`✓ Android app "${packageName}" is registered (appId=${match.appId}).`);
        return { reconciled: true, resourcesProduced: { firebase_android_app_id: match.appId } };
      }
      log(`○ Android app "${packageName}" not registered on Firebase — run this step.`);
      return { reconciled: false, message: `Android app "${packageName}" not found in Firebase. Run this step to register it.` };
    } catch (err) {
      const is403 = err instanceof GcpHttpError && err.statusCode === 403;
      log(`✗ Failed to list Firebase Android apps: ${(err as Error).message}`);
      return { reconciled: false, message: `Could not check Android app registration: ${(err as Error).message}`, suggestsReauth: is403 };
    }
  },
};

// ---------------------------------------------------------------------------
// firebase:configure-firestore-rules  (per-environment)
// ---------------------------------------------------------------------------

const DEFAULT_FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if false;
    }
  }
}`;

const configureFirestoreRulesHandler: StepHandler = {
  stepKey: 'firebase:configure-firestore-rules',
  requiredAuth: 'gcp',

  async create(context: StepHandlerContext): Promise<StepHandlerResult> {
    const { projectId, vaultManager, passphrase } = context;
    const log = makeLog('configure-firestore-rules', projectId);

    const gcpProjectId = getStoredGcpProjectId(vaultManager, passphrase, projectId);
    if (!gcpProjectId) {
      log('✗ No GCP project ID in vault. Complete "Create GCP Project" first.');
      return { reconciled: false, message: 'GCP project not set up. Run "Create GCP Project" first.' };
    }

    log(`→ Deploying Firestore security rules (deny-all default) to "${gcpProjectId}"...`);
    const token = await context.getToken('gcp');
    await withApiRetry(gcpProjectId, token, () => deployFirestoreRules(token, gcpProjectId, DEFAULT_FIRESTORE_RULES), log);

    log(`✓ COMPLETE — Firestore rules deployed to "${gcpProjectId}". Update rules in your source repo to customize.`);
    return { reconciled: true, resourcesProduced: {} };
  },

  async delete(_context: StepHandlerContext): Promise<StepHandlerResult> {
    const log = makeLog('configure-firestore-rules:delete', _context.projectId);
    log('○ Firestore rules cannot be "undeployed" — the previous ruleset remains active until new rules are pushed.');
    return { reconciled: true, message: 'Firestore rules cannot be deleted via API. Update your rules and re-run this step to change them.' };
  },

  async validate(context: StepHandlerContext): Promise<StepHandlerResult> {
    const { projectId, vaultManager, passphrase } = context;
    const log = makeLog('configure-firestore-rules:validate', projectId);

    const gcpProjectId = getStoredGcpProjectId(vaultManager, passphrase, projectId);
    if (!gcpProjectId) {
      log('✗ No GCP project ID in vault.');
      return { reconciled: false, message: 'GCP project not set up. Run "Create GCP Project" first.' };
    }

    log(`→ Checking active Firestore ruleset on "${gcpProjectId}"...`);
    const token = await context.getToken('gcp');
    const rulesetName = await getActiveFirestoreRulesetName(token, gcpProjectId);
    if (rulesetName) {
      log(`✓ Firestore rules are deployed (ruleset: ${rulesetName}).`);
      return { reconciled: true, resourcesProduced: {} };
    }
    log('✗ No active Firestore rules release found.');
    return { reconciled: false, message: 'No Firestore security rules are deployed. Run this step to deploy them.' };
  },

  async sync(context: StepHandlerContext): Promise<StepHandlerResult | null> {
    const { projectId, vaultManager, passphrase } = context;
    const log = makeLog('configure-firestore-rules:sync', projectId);

    const gcpProjectId = getStoredGcpProjectId(vaultManager, passphrase, projectId);
    if (!gcpProjectId) return null;

    log(`→ Checking active Firestore ruleset on "${gcpProjectId}"...`);
    try {
      const token = await context.getToken('gcp');
      const rulesetName = await getActiveFirestoreRulesetName(token, gcpProjectId);
      if (rulesetName) {
        log(`✓ Firestore rules deployed (ruleset: ${rulesetName}).`);
        return { reconciled: true, resourcesProduced: {} };
      }
      log('○ No active Firestore rules release — run this step to deploy them.');
      return { reconciled: false, message: 'No Firestore security rules deployed. Run this step.' };
    } catch (err) {
      const is403 = err instanceof GcpHttpError && err.statusCode === 403;
      log(`✗ Could not check Firestore rules: ${(err as Error).message}`);
      return { reconciled: false, message: `Could not verify Firestore rules: ${(err as Error).message}`, suggestsReauth: is403 };
    }
  },
};

// ---------------------------------------------------------------------------
// firebase:configure-storage-rules  (per-environment)
// ---------------------------------------------------------------------------

const DEFAULT_STORAGE_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if false;
    }
  }
}`;

const configureStorageRulesHandler: StepHandler = {
  stepKey: 'firebase:configure-storage-rules',
  requiredAuth: 'gcp',

  async create(context: StepHandlerContext): Promise<StepHandlerResult> {
    const { projectId, vaultManager, passphrase } = context;
    const log = makeLog('configure-storage-rules', projectId);

    const gcpProjectId = getStoredGcpProjectId(vaultManager, passphrase, projectId);
    if (!gcpProjectId) {
      log('✗ No GCP project ID in vault. Complete "Create GCP Project" first.');
      return { reconciled: false, message: 'GCP project not set up. Run "Create GCP Project" first.' };
    }

    log(`→ Deploying Cloud Storage security rules (deny-all default) to "${gcpProjectId}" (bucket: ${gcpProjectId}.appspot.com)...`);
    const token = await context.getToken('gcp');
    await withApiRetry(gcpProjectId, token, () => deployStorageRules(token, gcpProjectId, DEFAULT_STORAGE_RULES), log);

    log(`✓ COMPLETE — Storage rules deployed to "${gcpProjectId}". Update rules in your source repo to customize.`);
    return { reconciled: true, resourcesProduced: {} };
  },

  async delete(_context: StepHandlerContext): Promise<StepHandlerResult> {
    const log = makeLog('configure-storage-rules:delete', _context.projectId);
    log('○ Storage rules cannot be "undeployed" — the previous ruleset remains active until new rules are pushed.');
    return { reconciled: true, message: 'Storage rules cannot be deleted via API. Update your rules and re-run this step to change them.' };
  },

  async validate(context: StepHandlerContext): Promise<StepHandlerResult> {
    const { projectId, vaultManager, passphrase } = context;
    const log = makeLog('configure-storage-rules:validate', projectId);

    const gcpProjectId = getStoredGcpProjectId(vaultManager, passphrase, projectId);
    if (!gcpProjectId) {
      log('✗ No GCP project ID in vault.');
      return { reconciled: false, message: 'GCP project not set up. Run "Create GCP Project" first.' };
    }

    log(`→ Checking active Storage ruleset on "${gcpProjectId}"...`);
    const token = await context.getToken('gcp');
    const rulesetName = await getActiveStorageRulesetName(token, gcpProjectId);
    if (rulesetName) {
      log(`✓ Storage rules are deployed (ruleset: ${rulesetName}).`);
      return { reconciled: true, resourcesProduced: {} };
    }
    log('✗ No active Storage rules release found.');
    return { reconciled: false, message: 'No Cloud Storage security rules deployed. Run this step to deploy them.' };
  },

  async sync(context: StepHandlerContext): Promise<StepHandlerResult | null> {
    const { projectId, vaultManager, passphrase } = context;
    const log = makeLog('configure-storage-rules:sync', projectId);

    const gcpProjectId = getStoredGcpProjectId(vaultManager, passphrase, projectId);
    if (!gcpProjectId) return null;

    log(`→ Checking active Storage ruleset on "${gcpProjectId}"...`);
    try {
      const token = await context.getToken('gcp');
      const rulesetName = await getActiveStorageRulesetName(token, gcpProjectId);
      if (rulesetName) {
        log(`✓ Storage rules deployed (ruleset: ${rulesetName}).`);
        return { reconciled: true, resourcesProduced: {} };
      }
      log('○ No active Storage rules release — run this step to deploy them.');
      return { reconciled: false, message: 'No Cloud Storage security rules deployed. Run this step.' };
    } catch (err) {
      const is403 = err instanceof GcpHttpError && err.statusCode === 403;
      log(`✗ Could not check Storage rules: ${(err as Error).message}`);
      return { reconciled: false, message: `Could not verify Storage rules: ${(err as Error).message}`, suggestsReauth: is403 };
    }
  },
};

// ---------------------------------------------------------------------------
// Export: all Firebase step handlers
// ---------------------------------------------------------------------------

export const FIREBASE_STEP_HANDLERS: StepHandler[] = [
  createGcpProjectHandler,
  enableFirebaseHandler,
  createProvisionerSaHandler,
  bindProvisionerIamHandler,
  generateSaKeyHandler,
  enableServicesHandler,
  registerIosAppHandler,
  registerAndroidAppHandler,
  configureFirestoreRulesHandler,
  configureStorageRulesHandler,
];
