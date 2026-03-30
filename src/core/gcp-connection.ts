/**
 * GCP / Firebase connection service.
 *
 * Thin orchestration layer that composes OAuthManager, GcpOAuthProvider, and the
 * GCP credential/API helpers. Provides the same public interface as before so
 * existing callers (api.ts, gate-resolvers.ts, firebase adapter) continue to work
 * without changes.
 *
 * Implementation details live in:
 *   - src/core/oauth-manager.ts         — provider-agnostic OAuth session lifecycle
 *   - src/core/gcp/gcp-oauth-provider.ts — Google Cloud OAuth specifics
 *   - src/core/gcp/gcp-api-client.ts    — raw GCP HTTP client + helpers
 *   - src/core/gcp/gcp-credentials.ts   — vault credential management
 *   - src/core/gcp/gcp-step-handlers.ts — per-step create/delete/validate/sync
 */

import { GoogleAuth } from 'google-auth-library';
import type { VaultManager } from '../vault.js';
import type { ProjectManager, IntegrationConfigRecord } from '../studio/project-manager.js';
import { OAuthManager } from './oauth-manager.js';
import { GcpOAuthProvider } from './gcp/gcp-oauth-provider.js';
import {
  GcpHttpError,
  gcpRequest,
  parseDisabledApiServiceName,
  formatDisabledApiHelp,
  fetchGcpProjectSummary,
  getGcpProjectStatus,
  findGcpProjectsByDisplayName,
  createGcpProject,
  deleteGcpProject,
  waitForProjectActive,
  ensureRequiredProjectApis,
  ensureProvisionerServiceAccount,
  grantProvisionerRoles,
  removeProvisionerRoles,
  findMissingProvisionerRoles,
  createServiceAccountKey,
  deleteServiceAccount,
  enableProjectService,
  sleep,
  provisionerSaEmail,
} from './gcp/gcp-api-client.js';
import {
  buildStudioGcpProjectId,
  buildGcpProjectIdWithEntropy,
  getStoredGcpProjectId,
  storeGcpProjectId,
  getStoredSaEmail,
  storeSaEmail,
  getStoredSaKeyJson,
  storeSaKeyJson,
  deleteGcpCredentials,
  getStoredConnectionDetails,
  storeConnectionDetails,
  buildOAuthPreviewDetails,
  syncFirebaseIntegration,
  applyGcpProjectLinked,
  recordProvisionerServiceAccountKey,
  type GcpConnectionDetails,
  type GcpProjectConnectionStatus,
} from './gcp/gcp-credentials.js';

// ---------------------------------------------------------------------------
// Re-export types consumed by api.ts and other callers
// ---------------------------------------------------------------------------

export type { GcpConnectionDetails, GcpProjectConnectionStatus };
export { buildStudioGcpProjectId };
export const GCP_PROVISIONER_SERVICE_ACCOUNT_ID = 'platform-provisioner';

export type GcpStepStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
export type GcpOAuthSessionStepId = 'oauth_consent';
export type GcpBootstrapPhaseId = 'oauth_consent' | 'gcp_project' | 'service_account' | 'iam_binding' | 'vault';
/** @deprecated Use GcpOAuthSessionStepId */
export type GcpOAuthStepId = GcpOAuthSessionStepId;

export interface GcpOAuthStep {
  id: GcpOAuthSessionStepId;
  label: string;
  status: GcpStepStatus;
  message?: string;
}

export interface GcpOAuthSessionStart {
  sessionId: string;
  authUrl: string;
  state: string;
  phase: 'awaiting_user';
  steps: GcpOAuthStep[];
}

export interface GcpOAuthSessionStatus {
  sessionId: string;
  projectId: string;
  phase: 'awaiting_user' | 'processing' | 'completed' | 'failed' | 'expired';
  steps: GcpOAuthStep[];
  connected: boolean;
  details?: GcpConnectionDetails;
  gcpProjectDiscover?: GcpOAuthProjectDiscoverResult;
  error?: string;
}

export interface GcpOAuthProjectDiscoverResult {
  outcome: 'linked' | 'already_linked' | 'not_found' | 'inaccessible' | 'ambiguous' | 'error';
  gcpProjectId?: string;
  expectedProjectId: string;
  expectedDisplayName: string;
  message: string;
}

export interface GcpCredentialProvider {
  getAccessToken(projectId: string, context?: string): Promise<string>;
}

export interface GcpStepValidationResult {
  valid: boolean;
  message: string;
}

export interface GcpStepRevertResult {
  stepId: GcpBootstrapPhaseId;
  reverted: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// GcpConnectionService
// ---------------------------------------------------------------------------

export class GcpConnectionService implements GcpCredentialProvider {
  private readonly oauthManager: OAuthManager;
  private readonly gcpProvider: GcpOAuthProvider;

  constructor(
    private readonly vaultManager: VaultManager,
    private readonly projectManager: ProjectManager,
    oauthClientId: string,
    oauthClientSecret: string,
  ) {
    this.gcpProvider = new GcpOAuthProvider(oauthClientId, oauthClientSecret);
    this.oauthManager = new OAuthManager(vaultManager, () => this.getVaultPassphrase());
  }

  // ---------------------------------------------------------------------------
  // GcpCredentialProvider impl
  // ---------------------------------------------------------------------------

  async getAccessToken(projectId: string, context?: string): Promise<string> {
    this.ensureProjectExists(projectId);
    return this.getAccessTokenForGcpOperations(projectId, context);
  }

  // ---------------------------------------------------------------------------
  // Capability
  // ---------------------------------------------------------------------------

  getCapability(): { available: boolean; oauthConfigured: boolean; mode: 'project_bootstrap' } {
    const oauthConfigured = this.gcpProvider.isConfigured();
    return { available: oauthConfigured, oauthConfigured, mode: 'project_bootstrap' };
  }

  // ---------------------------------------------------------------------------
  // OAuth session management (delegates to OAuthManager)
  // ---------------------------------------------------------------------------

  async startProjectOAuthFlow(projectId: string): Promise<GcpOAuthSessionStart> {
    if (!this.gcpProvider.isConfigured()) {
      throw new Error('Google OAuth is not configured. Set PLATFORM_GCP_OAUTH_CLIENT_ID and PLATFORM_GCP_OAUTH_CLIENT_SECRET.');
    }
    this.ensureProjectExists(projectId);

    const start = await this.oauthManager.startSession(
      this.gcpProvider,
      projectId,
      async (accessToken, email) => {
        const passphrase = this.getVaultPassphrase();
        this.gcpProvider.storeConnectedEmail(this.vaultManager, passphrase, projectId, email);
        const discover = await this.discoverStudioGcpProjectWithUserAccessToken(projectId, accessToken);
        return { gcpProjectDiscover: discover };
      },
    );

    console.log(`[studio-gcp] OAuth flow started for Studio project "${projectId}" (session ${start.sessionId}).`);
    return {
      sessionId: start.sessionId,
      authUrl: start.authUrl,
      state: start.state,
      phase: 'awaiting_user',
      steps: start.steps as GcpOAuthStep[],
    };
  }

  getProjectOAuthStatus(projectId: string, sessionId: string): GcpOAuthSessionStatus {
    this.ensureProjectExists(projectId);
    const status = this.oauthManager.getSessionStatus(sessionId, projectId);
    const passphrase = this.getVaultPassphrase();
    const details = status.connected
      ? (getStoredConnectionDetails(this.vaultManager, passphrase, projectId) ??
        buildOAuthPreviewDetails(projectId, this.vaultManager, passphrase, status.connectedEmail ?? 'unknown'))
      : undefined;

    return {
      sessionId: status.sessionId,
      projectId: status.projectId,
      phase: status.phase,
      steps: status.steps as GcpOAuthStep[],
      connected: status.connected,
      details,
      gcpProjectDiscover: status.metadata?.['gcpProjectDiscover'] as GcpOAuthProjectDiscoverResult | undefined,
      error: status.error,
    };
  }

  // ---------------------------------------------------------------------------
  // Connection status
  // ---------------------------------------------------------------------------

  getProjectConnectionStatus(projectId: string): GcpProjectConnectionStatus {
    this.ensureProjectExists(projectId);
    const passphrase = this.getVaultPassphrase();
    const details = getStoredConnectionDetails(this.vaultManager, passphrase, projectId);
    const integration = this.projectManager.getProject(projectId).integrations.firebase;

    if (details) return { connected: true, details, integration };

    if (this.hasStoredUserOAuthRefreshToken(projectId)) {
      const userEmail = this.gcpProvider.getConnectedEmail(this.vaultManager, passphrase, projectId);
      return {
        connected: true,
        details: buildOAuthPreviewDetails(projectId, this.vaultManager, passphrase, userEmail),
        integration,
      };
    }

    return { connected: false };
  }

  // ---------------------------------------------------------------------------
  // GCP project discovery
  // ---------------------------------------------------------------------------

  async discoverStudioGcpProjectWithStoredOAuth(studioProjectId: string): Promise<GcpOAuthProjectDiscoverResult> {
    this.ensureProjectExists(studioProjectId);
    const token = await this.getUserOAuthAccessToken(studioProjectId);
    if (!token) {
      const expectedProjectId = buildStudioGcpProjectId(studioProjectId);
    return {
        outcome: 'error',
        expectedProjectId,
        expectedDisplayName: `Studio ${studioProjectId}`,
        message: 'No Google OAuth session stored. Run Connect with Google first.',
      };
    }
    return this.discoverStudioGcpProjectWithUserAccessToken(studioProjectId, token);
  }

  async discoverStudioGcpProjectWithUserAccessToken(
    studioProjectId: string,
    userAccessToken: string,
  ): Promise<GcpOAuthProjectDiscoverResult> {
    const expectedProjectId = buildStudioGcpProjectId(studioProjectId);
    const expectedDisplayName = `Studio ${studioProjectId}`;
    const passphrase = this.getVaultPassphrase();
    const userEmail = this.gcpProvider.getConnectedEmail(this.vaultManager, passphrase, studioProjectId);

    try {
      const vaultId = getStoredGcpProjectId(this.vaultManager, passphrase, studioProjectId);

      if (vaultId) {
        const summary = await fetchGcpProjectSummary(userAccessToken, vaultId);
        if (!summary.ok) {
          if (summary.reason === 'inaccessible') {
        return {
              outcome: 'inaccessible',
              gcpProjectId: vaultId,
              expectedProjectId,
              expectedDisplayName,
              message: `Vault lists GCP project "${vaultId}" but it is not accessible with the signed-in Google account (403).`,
            };
          }
        return {
            outcome: 'not_found',
            gcpProjectId: vaultId,
            expectedProjectId,
            expectedDisplayName,
            message: `Vault lists GCP project "${vaultId}" but it was not found in GCP.`,
          };
        }
        applyGcpProjectLinked(this.projectManager, studioProjectId, vaultId, userEmail);
        const nameNote = summary.name === expectedDisplayName
          ? `Display name matches "${expectedDisplayName}".`
          : `Note: display name is "${summary.name}" (expected "${expectedDisplayName}").`;
        return { outcome: 'already_linked', gcpProjectId: vaultId, expectedProjectId, expectedDisplayName, message: `GCP project "${vaultId}" is reachable. ${nameNote}` };
      }

      const byId = await fetchGcpProjectSummary(userAccessToken, expectedProjectId);
      if (byId.ok) {
        storeGcpProjectId(this.vaultManager, passphrase, studioProjectId, expectedProjectId);
        applyGcpProjectLinked(this.projectManager, studioProjectId, expectedProjectId, userEmail);
        const nameNote = byId.name === expectedDisplayName
          ? `Linked project "${expectedProjectId}" (display name "${expectedDisplayName}").`
          : `Linked project "${expectedProjectId}". Display name is "${byId.name}" (expected "${expectedDisplayName}").`;
        return { outcome: 'linked', gcpProjectId: expectedProjectId, expectedProjectId, expectedDisplayName, message: nameNote };
      }

      // 403 could mean "no access" or "doesn't exist" — search by display name
      const matches = await findGcpProjectsByDisplayName(userAccessToken, expectedDisplayName);
      if (matches.length === 0) {
          return {
          outcome: 'not_found', expectedProjectId, expectedDisplayName,
          message: `No GCP project with id "${expectedProjectId}" or display name "${expectedDisplayName}". Run "Create GCP Project" provisioning step.`,
        };
      }
      if (matches.length > 1) {
      return {
          outcome: 'ambiguous', expectedProjectId, expectedDisplayName,
          message: `Multiple GCP projects named "${expectedDisplayName}". Rename or delete duplicates in Cloud Console.`,
        };
      }

      const chosen = matches[0]!;
      storeGcpProjectId(this.vaultManager, passphrase, studioProjectId, chosen.projectId);
      applyGcpProjectLinked(this.projectManager, studioProjectId, chosen.projectId, userEmail);
      return {
        outcome: 'linked', gcpProjectId: chosen.projectId, expectedProjectId, expectedDisplayName,
        message: `Linked GCP project "${chosen.projectId}" (display name "${expectedDisplayName}").`,
      };
    } catch (err) {
      return { outcome: 'error', expectedProjectId, expectedDisplayName, message: (err as Error).message };
    }
  }

  // ---------------------------------------------------------------------------
  // Stored credentials
  // ---------------------------------------------------------------------------

  getStoredGcpProjectId(studioProjectId: string): string | null {
    this.ensureProjectExists(studioProjectId);
    return getStoredGcpProjectId(this.vaultManager, this.getVaultPassphrase(), studioProjectId);
  }

  storeGcpProjectIdInVault(studioProjectId: string, gcpProjectId: string): void {
    this.ensureProjectExists(studioProjectId);
    storeGcpProjectId(this.vaultManager, this.getVaultPassphrase(), studioProjectId, gcpProjectId);
  }

  storeProvisionerServiceAccountEmail(studioProjectId: string, email: string): void {
    this.ensureProjectExists(studioProjectId);
    storeSaEmail(this.vaultManager, this.getVaultPassphrase(), studioProjectId, email);
  }

  recordProvisionerServiceAccountKey(
    studioProjectId: string,
    gcpProjectId: string,
    saEmail: string,
    saKeyJson: string,
  ): GcpProjectConnectionStatus {
    this.ensureProjectExists(studioProjectId);
    return recordProvisionerServiceAccountKey(
      this.vaultManager,
      this.getVaultPassphrase(),
      this.projectManager,
      studioProjectId,
      gcpProjectId,
      saEmail,
      saKeyJson,
    );
  }

  hasStoredUserOAuthRefreshToken(studioProjectId: string): boolean {
    return this.oauthManager.hasToken(this.gcpProvider, studioProjectId);
  }

  async hasGcpOAuthToken(studioProjectId: string): Promise<boolean> {
    const token = await this.getUserOAuthAccessToken(studioProjectId);
    return token !== null;
  }

  async requireUserOAuthAccessToken(studioProjectId: string, context: string): Promise<string> {
    return this.oauthManager.requireToken(this.gcpProvider, studioProjectId, context);
  }

  // ---------------------------------------------------------------------------
  // Manual SA key connect / disconnect
  // ---------------------------------------------------------------------------

  connectProjectWithServiceAccountKey(projectId: string, saKeyJson: string): GcpProjectConnectionStatus {
    this.ensureProjectExists(projectId);
    let parsed: { project_id?: string; client_email?: string; type?: string };
    try { parsed = JSON.parse(saKeyJson); }
    catch { throw new Error('Invalid service account JSON: not valid JSON.'); }
    if (parsed.type !== 'service_account') throw new Error('Invalid service account JSON: "type" must be "service_account".');
    if (!parsed.project_id || !parsed.client_email) throw new Error('Invalid service account JSON: missing project_id or client_email.');

    const passphrase = this.getVaultPassphrase();
    const details: GcpConnectionDetails = {
      projectId: parsed.project_id,
      serviceAccountEmail: parsed.client_email,
      userEmail: 'manual',
      connectedAt: new Date().toISOString(),
    };
    storeSaKeyJson(this.vaultManager, passphrase, projectId, saKeyJson);
    storeConnectionDetails(this.vaultManager, passphrase, projectId, details);
    return syncFirebaseIntegration(this.projectManager, projectId, details);
  }

  disconnectProject(projectId: string): GcpProjectConnectionStatus & { removed: boolean } {
    this.ensureProjectExists(projectId);
    const passphrase = this.getVaultPassphrase();
    const removed = deleteGcpCredentials(this.vaultManager, passphrase, projectId);

    const project = this.projectManager.getProject(projectId);
    if (project.integrations.firebase) {
      this.projectManager.updateIntegration(projectId, 'firebase', {
        status: 'pending',
        notes: 'Firebase/GCP connection disabled for this project.',
        config: { gcp_project_id: '', service_account_email: '', connected_by: '', credential_scope: 'project' },
      });
    }
    return { removed, connected: false, integration: this.projectManager.getProject(projectId).integrations.firebase };
  }

  // ---------------------------------------------------------------------------
  // Sync / validate / revert (bootstrap phases)
  // ---------------------------------------------------------------------------

  /** @deprecated Use StepHandlerRegistry for graph-level steps. Kept for OAuthFlowPanel bootstrap phase UI. */
  async syncOAuthPipelineFromLiveState(studioProjectId: string): Promise<GcpOAuthStep[]> {
    this.ensureProjectExists(studioProjectId);
    const result = await this.validateStep(studioProjectId, 'oauth_consent');
    return [{
        id: 'oauth_consent',
      label: 'Sign in with Google and approve access',
        status: result.valid ? 'completed' : 'failed',
        message: result.message,
    }];
  }

  /**
   * Reconcile a Firebase provisioning graph step with live GCP + vault.
   * Called by plan/sync route. Delegates to GCP step handlers for each step key.
   */
  async syncProvisioningFirebaseGraphStep(
    studioProjectId: string,
    stepKey: string,
  ): Promise<{ reconciled: boolean; message?: string; resourcesProduced?: Record<string, string>; suggestsReauth?: boolean } | null> {
    const { globalStepHandlerRegistry } = await import('../provisioning/step-handler-registry.js');
    const handler = globalStepHandlerRegistry.get(stepKey);
    if (!handler) return null;

    const context = this.buildStepHandlerContext(studioProjectId);
    return handler.sync(context);
  }

  async validateStep(studioProjectId: string, stepId: GcpBootstrapPhaseId): Promise<GcpStepValidationResult> {
    this.ensureProjectExists(studioProjectId);
    const passphrase = this.getVaultPassphrase();
    const hasOAuth = this.hasStoredUserOAuthRefreshToken(studioProjectId);

    switch (stepId) {
      case 'oauth_consent': {
        if (hasOAuth) return { valid: true, message: 'Google OAuth refresh token is stored.' };
        const d = getStoredConnectionDetails(this.vaultManager, passphrase, studioProjectId);
        if (!d) return { valid: false, message: 'No OAuth refresh token or service account connection. Sign in with Google or upload a service account key.' };
        return { valid: true, message: `Connection recorded for GCP project ${d.projectId} (${d.serviceAccountEmail}).` };
      }
      case 'gcp_project': {
        const details = getStoredConnectionDetails(this.vaultManager, passphrase, studioProjectId);
        const projectId = details?.projectId ?? getStoredGcpProjectId(this.vaultManager, passphrase, studioProjectId);
        if (!projectId) return { valid: false, message: 'No GCP project id stored. Complete "Create GCP Project" first.' };
        try {
          const token = await this.getAccessTokenForGcpOperations(studioProjectId, 'validate:gcp_project');
          const status = await getGcpProjectStatus(token, projectId);
          if (status === 'found') return { valid: true, message: `Project "${projectId}" exists and is reachable.` };
          if (status === 'not_found') return { valid: false, message: `Project "${projectId}" was not found in GCP.` };
          return { valid: false, message: `Project "${projectId}" exists but is not accessible with the provisioner key (403).` };
        } catch (err) {
          return { valid: false, message: (err as Error).message };
        }
      }
      case 'service_account': {
        const gcpProjectId = getStoredGcpProjectId(this.vaultManager, passphrase, studioProjectId);
        const saEmail = getStoredSaEmail(this.vaultManager, passphrase, studioProjectId);
        if (!gcpProjectId || !saEmail) return { valid: false, message: 'No service account email stored.' };
        const saPath = `/v1/projects/${gcpProjectId}/serviceAccounts/${encodeURIComponent(saEmail)}`;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const token = await this.getAccessTokenForGcpOperations(studioProjectId, 'validate:service_account');
            await gcpRequest('GET', 'iam.googleapis.com', saPath, token);
            return { valid: true, message: `Service account ${saEmail} exists.` };
          } catch (err) {
            if (err instanceof GcpHttpError && err.statusCode === 404) return { valid: false, message: 'Service account not found in project.' };
            const toEnable = parseDisabledApiServiceName(err);
            if (toEnable && attempt === 0) {
              const token = await this.getAccessTokenForGcpOperations(studioProjectId, 'validate:service_account:enable-api');
              const enabled = await enableProjectService(gcpProjectId, token, toEnable);
              if (enabled) { await sleep(4500); continue; }
            }
            const apiHelp = formatDisabledApiHelp(gcpProjectId, err, hasOAuth);
            if (apiHelp) return { valid: false, message: apiHelp };
            return { valid: false, message: (err as Error).message };
          }
        }
        return { valid: false, message: 'Service account check failed after attempting to enable required GCP APIs. Retry sync in a minute.' };
      }
      case 'iam_binding': {
        const gcpProjectId = getStoredGcpProjectId(this.vaultManager, passphrase, studioProjectId);
        const saEmail = getStoredSaEmail(this.vaultManager, passphrase, studioProjectId);
        if (!gcpProjectId || !saEmail) return { valid: false, message: 'No connection metadata for IAM check.' };
        const member = `serviceAccount:${saEmail}`;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const token = await this.getAccessTokenForGcpOperations(studioProjectId, 'validate:iam_binding');
            const missing = await findMissingProvisionerRoles(token, gcpProjectId, member);
            if (missing.length === 0) return { valid: true, message: `All provisioner roles bound for ${member}.` };
            return { valid: false, message: `Missing IAM bindings: ${missing.join(', ')}` };
          } catch (err) {
            const toEnable = parseDisabledApiServiceName(err);
            if (toEnable && attempt === 0) {
              const token = await this.getAccessTokenForGcpOperations(studioProjectId, 'validate:iam_binding:enable-api');
              const enabled = await enableProjectService(gcpProjectId, token, toEnable);
              if (enabled) { await sleep(4500); continue; }
            }
            const apiHelp = formatDisabledApiHelp(gcpProjectId, err, hasOAuth);
            if (apiHelp) return { valid: false, message: apiHelp };
            return { valid: false, message: (err as Error).message };
          }
        }
        return { valid: false, message: 'IAM policy check failed after attempting to enable required GCP APIs. Retry sync in a minute.' };
      }
      case 'vault': {
        const raw = getStoredSaKeyJson(this.vaultManager, passphrase, studioProjectId);
        if (!raw) return { valid: false, message: 'No service_account_json in vault.' };
        try {
          const parsed = JSON.parse(raw) as { type?: string };
          if (parsed.type !== 'service_account') return { valid: false, message: 'Vault payload is not a service account JSON.' };
          return { valid: true, message: 'Service account key JSON is present and well-formed.' };
        } catch {
          return { valid: false, message: 'Vault payload is not valid JSON.' };
        }
      }
      default:
        return { valid: false, message: `Unknown step: ${String(stepId)}` };
      }
    }

  static getCascadeSteps(stepId: GcpBootstrapPhaseId): GcpBootstrapPhaseId[] {
    const ORDER: GcpBootstrapPhaseId[] = ['oauth_consent', 'gcp_project', 'service_account', 'iam_binding', 'vault'];
    const idx = ORDER.indexOf(stepId);
    if (idx === -1) throw new Error(`Unknown bootstrap phase: ${stepId}`);
    return ORDER.slice(idx);
  }

  async revertSteps(
    studioProjectId: string,
    cascadeStepIds: GcpBootstrapPhaseId[],
  ): Promise<GcpStepRevertResult[]> {
    this.ensureProjectExists(studioProjectId);
    const toRun = new Set(cascadeStepIds);
    const results: GcpStepRevertResult[] = [];
    const passphrase = this.getVaultPassphrase();

    let accessToken: string | null = null;
    let tokenError: string | null = null;
    const needsGcpToken = toRun.has('iam_binding') || toRun.has('service_account') || toRun.has('gcp_project');
    if (needsGcpToken) {
      try {
        accessToken = await this.getAccessTokenForGcpOperations(studioProjectId, 'revert');
      } catch (err) {
        tokenError = (err as Error).message;
      }
    }

    const details = getStoredConnectionDetails(this.vaultManager, passphrase, studioProjectId);
    const revertProjectId = details?.projectId ?? getStoredGcpProjectId(this.vaultManager, passphrase, studioProjectId);
    const revertSaEmail = details?.serviceAccountEmail ?? getStoredSaEmail(this.vaultManager, passphrase, studioProjectId);

    if (toRun.has('iam_binding')) {
      if (!accessToken) {
        results.push({ stepId: 'iam_binding', reverted: false, message: tokenError ?? 'No access token for IAM revert.' });
      } else if (!revertProjectId || !revertSaEmail) {
        results.push({ stepId: 'iam_binding', reverted: false, message: 'Missing connection metadata.' });
      } else {
        try {
          await removeProvisionerRoles(accessToken, revertProjectId, revertSaEmail);
          results.push({ stepId: 'iam_binding', reverted: true, message: 'Removed provisioner role bindings from project IAM.' });
        } catch (err) {
          results.push({ stepId: 'iam_binding', reverted: false, message: (err as Error).message });
        }
      }
    }

    if (toRun.has('service_account')) {
      if (!accessToken) {
        results.push({ stepId: 'service_account', reverted: false, message: tokenError ?? 'No access token for service account revert.' });
      } else if (!revertProjectId || !revertSaEmail) {
        results.push({ stepId: 'service_account', reverted: false, message: 'Missing connection metadata.' });
      } else {
        try {
          const result = await deleteServiceAccount(accessToken, revertProjectId, revertSaEmail);
          results.push({
            stepId: 'service_account',
            reverted: true,
            message: result === 'deleted' ? `Deleted service account ${revertSaEmail}.` : 'Service account already absent.',
          });
        } catch (err) {
            results.push({ stepId: 'service_account', reverted: false, message: (err as Error).message });
        }
      }
    }

    if (toRun.has('gcp_project')) {
      results.push({
        stepId: 'gcp_project',
        reverted: false,
        message: 'GCP project deletion is not performed via the provisioner. Delete the project in Google Cloud Console or use the teardown flow.',
      });
    }

    const gcpApiAttempted = results.filter((r) => r.stepId === 'iam_binding' || r.stepId === 'service_account');
    const gcpApiAllSucceeded = gcpApiAttempted.every((r) => r.reverted);
    const needsLocalCleanup = (toRun.has('vault') || toRun.has('oauth_consent')) && gcpApiAllSucceeded;

    if (needsLocalCleanup) {
      const removed = deleteGcpCredentials(this.vaultManager, passphrase, studioProjectId);
      const project = this.projectManager.getProject(studioProjectId);
      if (project.integrations.firebase) {
        this.projectManager.updateIntegration(studioProjectId, 'firebase', {
          status: 'pending',
          notes: 'Firebase/GCP connection disabled for this project.',
          config: { gcp_project_id: '', service_account_email: '', connected_by: '', credential_scope: 'project' },
        });
      }
      const localMsg = removed
        ? 'Removed credentials from vault and reset Firebase integration.'
        : 'Reset Firebase integration (vault was already empty).';
      if (toRun.has('vault')) results.push({ stepId: 'vault', reverted: true, message: localMsg });
      if (toRun.has('oauth_consent')) results.push({ stepId: 'oauth_consent', reverted: true, message: localMsg });
    } else if (toRun.has('vault') || toRun.has('oauth_consent')) {
      for (const stepId of [...(toRun.has('vault') ? ['vault' as const] : []), ...(toRun.has('oauth_consent') ? ['oauth_consent' as const] : [])]) {
        results.push({
          stepId,
          reverted: false,
          message: 'Credentials kept in vault because GCP resource cleanup did not fully succeed. Fix the errors above, then revert again.',
        });
      }
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // GCP API helpers (used by adapters / gate resolvers)
  // ---------------------------------------------------------------------------

  async ensureProjectForStudioProject(accessToken: string, studioProjectId: string): Promise<string> {
    const passphrase = this.getVaultPassphrase();
    const existingId = getStoredGcpProjectId(this.vaultManager, passphrase, studioProjectId);
    const gcpProjectId = existingId ?? buildStudioGcpProjectId(studioProjectId);
    console.log(`[studio-gcp] ensureProjectForStudioProject: studioId="${studioProjectId}" gcpId="${gcpProjectId}" existing=${Boolean(existingId)}`);

    if (existingId) {
      const status = await getGcpProjectStatus(accessToken, gcpProjectId);
      if (status === 'found') return gcpProjectId;
      throw new Error(
        `Previously connected GCP project "${gcpProjectId}" is no longer accessible (${status}). ` +
          'Disconnect the Firebase integration and reconnect to create a new project.',
      );
    }

    const createResult = await createGcpProject(accessToken, gcpProjectId, `Studio ${studioProjectId}`);
    if (createResult === 'created' || createResult === 'already_exists') {
      await waitForProjectActive(accessToken, gcpProjectId);
      storeGcpProjectId(this.vaultManager, passphrase, studioProjectId, gcpProjectId);
      return gcpProjectId;
    }

    const retryId = buildGcpProjectIdWithEntropy(studioProjectId);
    await createGcpProject(accessToken, retryId, `Studio ${studioProjectId}`);
    await waitForProjectActive(accessToken, retryId);
    storeGcpProjectId(this.vaultManager, passphrase, studioProjectId, retryId);
    return retryId;
  }

  async ensureProvisionerServiceAccount(accessToken: string, gcpProjectId: string): Promise<string> {
    return ensureProvisionerServiceAccount(accessToken, gcpProjectId);
  }

  async grantProvisionerProjectRoles(accessToken: string, gcpProjectId: string, saEmail: string): Promise<void> {
    return grantProvisionerRoles(accessToken, gcpProjectId, saEmail);
  }

  async createServiceAccountKey(accessToken: string, gcpProjectId: string, saEmail: string): Promise<string> {
    return createServiceAccountKey(accessToken, gcpProjectId, saEmail);
  }

  async ensureRequiredProjectApis(accessToken: string, gcpProjectId: string): Promise<void> {
    return ensureRequiredProjectApis(accessToken, gcpProjectId);
  }

  /**
   * Deletes the GCP project linked to this studio project using the stored OAuth token.
   * Useful for cleaning up orphaned projects that were created under a different console account.
   */
  async deleteLinkedGcpProject(studioProjectId: string): Promise<{ gcpProjectId: string }> {
    this.ensureProjectExists(studioProjectId);
    const passphrase = this.getVaultPassphrase();
    const gcpProjectId = getStoredGcpProjectId(this.vaultManager, passphrase, studioProjectId);
    if (!gcpProjectId) {
      throw new Error(`No GCP project linked to studio project "${studioProjectId}". Nothing to delete.`);
    }
    const accessToken = await this.getAccessTokenForGcpOperations(studioProjectId, 'delete-linked-project');
    await deleteGcpProject(accessToken, gcpProjectId);
    console.log(`[studio-gcp] Deleted GCP project "${gcpProjectId}" for studio project "${studioProjectId}".`);
    return { gcpProjectId };
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async getUserOAuthAccessToken(studioProjectId: string): Promise<string | null> {
    return this.oauthManager.getToken(this.gcpProvider, studioProjectId);
  }

  private async getServiceAccountAccessToken(studioProjectId: string): Promise<string> {
    const passphrase = this.getVaultPassphrase();
    const saJson = getStoredSaKeyJson(this.vaultManager, passphrase, studioProjectId);
    if (!saJson) throw new Error('No service account key in vault. Cannot call GCP APIs for validate/revert.');
    let credentials: Record<string, unknown>;
    try { credentials = JSON.parse(saJson) as Record<string, unknown>; }
    catch { throw new Error('Stored service account JSON is invalid.'); }

    const auth = new GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const client = await auth.getClient();
    const tokenResponse = await client.getAccessToken();
    const token = tokenResponse.token;
    if (!token) throw new Error('Failed to obtain access token from service account credentials.');
    return token;
  }

  private async getAccessTokenForGcpOperations(studioProjectId: string, context?: string): Promise<string> {
    const userToken = await this.getUserOAuthAccessToken(studioProjectId);
    if (userToken) {
      if (context) console.log(`[studio-gcp] ${context}: using user OAuth token.`);
      return userToken;
    }
    if (context) console.warn(`[studio-gcp] ${context}: no user OAuth token — falling back to service account key.`);
    return this.getServiceAccountAccessToken(studioProjectId);
  }

  private buildStepHandlerContext(studioProjectId: string): import('../provisioning/step-handler-registry.js').StepHandlerContext {
    const passphrase = this.getVaultPassphrase();
    return {
      projectId: studioProjectId,
      upstreamArtifacts: {},
      getToken: async (providerId: string) => {
        if (providerId === 'gcp') return this.getAccessTokenForGcpOperations(studioProjectId, `step-handler:${providerId}`);
        throw new Error(`No token provider for "${providerId}".`);
      },
      hasToken: (providerId: string) => {
        if (providerId === 'gcp') return this.hasStoredUserOAuthRefreshToken(studioProjectId);
        return false;
      },
      vaultManager: this.vaultManager,
      passphrase,
      projectManager: this.projectManager,
    };
  }

  private ensureProjectExists(projectId: string): void {
    this.projectManager.getProject(projectId);
  }

  private getVaultPassphrase(): string {
    const passphrase = process.env['STUDIO_VAULT_PASSPHRASE']?.trim();
    if (!passphrase) throw new Error('STUDIO_VAULT_PASSPHRASE is required to use Studio credential storage for GCP/Firebase.');
    return passphrase;
  }
}
