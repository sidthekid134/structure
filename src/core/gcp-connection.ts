import * as http from 'http';
import * as https from 'https';
import * as url from 'url';
import * as crypto from 'crypto';
import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import { VaultManager } from '../vault.js';
import {
  ProjectManager,
  IntegrationConfigRecord,
} from '../studio/project-manager.js';

export type GcpStepStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/** Single step shown in the OAuth session UI — sign-in only; infra runs as plan steps. */
export type GcpOAuthSessionStepId = 'oauth_consent';

/**
 * Bootstrap phases for vault validation, sync, and revert (not shown as OAuth sub-steps).
 */
export type GcpBootstrapPhaseId =
  | 'oauth_consent'
  | 'gcp_project'
  | 'service_account'
  | 'iam_binding'
  | 'vault';

export interface GcpOAuthStep {
  id: GcpOAuthSessionStepId;
  label: string;
  status: GcpStepStatus;
  message?: string;
}

export interface GcpConnectionDetails {
  projectId: string;
  serviceAccountEmail: string;
  userEmail: string;
  connectedAt: string;
}

export interface GcpProjectConnectionStatus {
  connected: boolean;
  details?: GcpConnectionDetails;
  integration?: IntegrationConfigRecord;
}

export interface GcpOAuthSessionStart {
  sessionId: string;
  authUrl: string;
  state: string;
  phase: 'awaiting_user';
  steps: GcpOAuthStep[];
}

/** Result of matching a Studio app to a live GCP project after Google sign-in. */
export interface GcpOAuthProjectDiscoverResult {
  outcome: 'linked' | 'already_linked' | 'not_found' | 'inaccessible' | 'ambiguous' | 'error';
  gcpProjectId?: string;
  expectedProjectId: string;
  expectedDisplayName: string;
  message: string;
}

export interface GcpOAuthSessionStatus {
  sessionId: string;
  projectId: string;
  phase: 'awaiting_user' | 'processing' | 'completed' | 'failed' | 'expired';
  steps: GcpOAuthStep[];
  connected: boolean;
  details?: GcpConnectionDetails;
  /** Populated when OAuth completes: looks up GCP project by expected id or display name `Studio <studioProjectId>`. */
  gcpProjectDiscover?: GcpOAuthProjectDiscoverResult;
  error?: string;
}

export type GcpOAuthStepId = GcpOAuthSessionStepId;

/** Studio obtains GCP access tokens for plan steps: prefers user OAuth, then provisioner SA key. */
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

interface InternalSession {
  sessionId: string;
  projectId: string;
  state: string;
  client: OAuth2Client;
  server: http.Server;
  codePromise: Promise<string>;
  resolveCode: (code: string) => void;
  rejectCode: (err: Error) => void;
  timeout: NodeJS.Timeout;
  status: GcpOAuthSessionStatus;
}

interface TokenInfo {
  email?: string;
  scope?: string;
}

interface ServiceAccountKeyResponse {
  privateKeyData?: string;
}

class GcpHttpError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly body: string,
  ) {
    super(message);
  }
}

/**
 * When GCP returns 403 because a required API is disabled (not a generic permission error).
 * Produces a short, actionable message with a console enable link.
 * If `hasUserOAuth` is false, suggests re-running Connect with Google for auto-enabling.
 */
function formatGcpApiDisabledHelp(
  gcpProjectId: string,
  err: unknown,
  hasUserOAuth = true,
): string | null {
  if (!(err instanceof GcpHttpError) || err.statusCode !== 403) return null;
  const b = err.body;
  const apiDisabled =
    b.includes('has not been used') ||
    b.includes('It is disabled') ||
    b.includes('it is disabled');
  if (!apiDisabled) return null;

  const reconnectHint = hasUserOAuth
    ? ''
    : ' Alternatively, run "Connect with Google" so Studio can enable APIs automatically using your Google account.';
  const q = encodeURIComponent(gcpProjectId);
  if (b.includes('Identity and Access Management (IAM) API') || b.includes('iam.googleapis.com')) {
    return (
      `Identity and Access Management (IAM) API is not enabled on GCP project "${gcpProjectId}". ` +
      `Enable it, wait a few minutes for propagation, then run sync again: ` +
      `https://console.cloud.google.com/apis/library/iam.googleapis.com?project=${q}` +
      reconnectHint
    );
  }
  if (b.includes('Cloud Resource Manager API') || b.includes('cloudresourcemanager.googleapis.com')) {
    return (
      `Cloud Resource Manager API is not enabled on GCP project "${gcpProjectId}". ` +
      `Enable it, wait a few minutes, then retry: ` +
      `https://console.cloud.google.com/apis/library/cloudresourcemanager.googleapis.com?project=${q}` +
      reconnectHint
    );
  }
  return null;
}

/**
 * Maps an "API not enabled" 403 body to the Service Usage `services/{name}` id for `:enable`.
 */
function parseDisabledApisServiceToEnable(err: unknown): string | null {
  if (!(err instanceof GcpHttpError) || err.statusCode !== 403) return null;
  const b = err.body;
  const apiDisabled =
    b.includes('has not been used') ||
    b.includes('It is disabled') ||
    b.includes('it is disabled');
  if (!apiDisabled) return null;
  if (b.includes('Identity and Access Management (IAM) API') || b.includes('iam.googleapis.com')) {
    return 'iam.googleapis.com';
  }
  if (b.includes('Cloud Resource Manager API') || b.includes('cloudresourcemanager.googleapis.com')) {
    return 'cloudresourcemanager.googleapis.com';
  }
  return null;
}

const LOOPBACK_HOST = '127.0.0.1';
const OAUTH_TIMEOUT_MS = 10 * 60 * 1000;
const GCP_OAUTH_SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];
export const GCP_PROVISIONER_SERVICE_ACCOUNT_ID = 'platform-provisioner';

const PROVISIONER_PROJECT_ROLES = [
  'roles/firebase.admin',
  'roles/iam.serviceAccountAdmin',
  'roles/iam.serviceAccountKeyAdmin',
  'roles/serviceusage.serviceUsageAdmin',
  'roles/cloudkms.admin',
] as const;

export function buildStudioGcpProjectId(studioProjectId: string): string {
  const base = studioProjectId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  const hash = crypto
    .createHash('sha1')
    .update(studioProjectId)
    .digest('hex')
    .slice(0, 6);

  const maxBaseLength = 30 - 'st--'.length - hash.length;
  const trimmedBase = (base || 'project').slice(0, maxBaseLength).replace(/-+$/g, '');
  return `st-${trimmedBase}-${hash}`;
}

export class GcpConnectionService implements GcpCredentialProvider {
  private readonly sessions = new Map<string, InternalSession>();

  constructor(
    private readonly vaultManager: VaultManager,
    private readonly projectManager: ProjectManager,
    private readonly oauthClientId: string,
    private readonly oauthClientSecret: string,
  ) {}

  /**
   * Access token for GCP API calls from provisioning steps: user OAuth first, else provisioner SA key.
   */
  async getAccessToken(projectId: string, context?: string): Promise<string> {
    this.ensureProjectExists(projectId);
    return this.getAccessTokenForGcpOperations(projectId, context);
  }

  getStoredGcpProjectId(studioProjectId: string): string | null {
    this.ensureProjectExists(studioProjectId);
    const passphrase = this.getVaultPassphrase();
    const id = this.vaultManager.getCredential(
      passphrase,
      'firebase',
      this.vaultKey(studioProjectId, 'gcp_project_id'),
    );
    return id?.trim() || null;
  }

  storeGcpProjectIdInVault(studioProjectId: string, gcpProjectId: string): void {
    this.ensureProjectExists(studioProjectId);
    const passphrase = this.getVaultPassphrase();
    this.vaultManager.setCredential(
      passphrase,
      'firebase',
      this.vaultKey(studioProjectId, 'gcp_project_id'),
      gcpProjectId,
    );
  }

  storeProvisionerServiceAccountEmail(studioProjectId: string, email: string): void {
    this.ensureProjectExists(studioProjectId);
    const passphrase = this.getVaultPassphrase();
    this.vaultManager.setCredential(
      passphrase,
      'firebase',
      this.vaultKey(studioProjectId, 'service_account_email'),
      email,
    );
  }

  /** After SA key creation: vault JSON, connection metadata, and Firebase integration record. */
  recordProvisionerServiceAccountKey(
    studioProjectId: string,
    gcpProjectId: string,
    saEmail: string,
    saKeyJson: string,
  ): GcpProjectConnectionStatus {
    this.ensureProjectExists(studioProjectId);
    this.storeServiceAccountKey(studioProjectId, saKeyJson);
    const passphrase = this.getVaultPassphrase();
    const userEmail =
      this.vaultManager.getCredential(passphrase, 'firebase', this.vaultKey(studioProjectId, 'connected_by_email')) ??
      'unknown';
    const details: GcpConnectionDetails = {
      projectId: gcpProjectId,
      serviceAccountEmail: saEmail,
      userEmail,
      connectedAt: new Date().toISOString(),
    };
    this.storeConnectionDetails(studioProjectId, details);
    return this.syncProjectIntegration(studioProjectId, details);
  }

  getCapability(): {
    available: boolean;
    oauthConfigured: boolean;
    mode: 'project_bootstrap';
  } {
    const oauthConfigured =
      Boolean(this.oauthClientId.trim()) && Boolean(this.oauthClientSecret.trim());
    return {
      available: oauthConfigured,
      oauthConfigured,
      mode: 'project_bootstrap',
    };
  }

  async startProjectOAuthFlow(projectId: string): Promise<GcpOAuthSessionStart> {
    this.ensureOAuthConfigured();
    this.ensureProjectExists(projectId);

    const sessionId = crypto.randomUUID();
    const state = crypto.randomBytes(16).toString('hex');

    const server = http.createServer();
    await this.listenServer(server);

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to start OAuth loopback server.');
    }
    const redirectUri = `http://${LOOPBACK_HOST}:${address.port}`;

    const client = new OAuth2Client({
      clientId: this.oauthClientId,
      clientSecret: this.oauthClientSecret,
      redirectUri,
    });

    const authUrl = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: GCP_OAUTH_SCOPES,
      state,
    });

    let resolveCode!: (code: string) => void;
    let rejectCode!: (err: Error) => void;
    const codePromise = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });

    const status: GcpOAuthSessionStatus = {
      sessionId,
      projectId,
      phase: 'awaiting_user',
      connected: false,
      steps: [
        {
          id: 'oauth_consent',
          label: 'Sign in with Google and approve access',
          status: 'in_progress',
        },
      ],
    };

    const timeout = setTimeout(() => {
      const active = this.sessions.get(sessionId);
      if (!active) return;
      this.failSession(active, 'OAuth session timed out before user authorization.');
    }, OAUTH_TIMEOUT_MS);

    const session: InternalSession = {
      sessionId,
      projectId,
      state,
      client,
      server,
      codePromise,
      resolveCode,
      rejectCode,
      timeout,
      status,
    };

    server.on('request', (req, res) => {
      this.handleOAuthCallback(session, req, res);
    });

    this.sessions.set(sessionId, session);
    void this.runSession(sessionId);

    return {
      sessionId,
      authUrl,
      state,
      phase: 'awaiting_user',
      steps: this.cloneSteps(status.steps),
    };
  }

  getProjectOAuthStatus(projectId: string, sessionId: string): GcpOAuthSessionStatus {
    this.ensureProjectExists(projectId);
    const session = this.sessions.get(sessionId);
    if (!session || session.projectId !== projectId) {
      throw new Error('OAuth session not found for this project.');
    }
    return {
      ...session.status,
      steps: this.cloneSteps(session.status.steps),
    };
  }

  getProjectConnectionStatus(projectId: string): GcpProjectConnectionStatus {
    this.ensureProjectExists(projectId);
    const details = this.getStoredConnectionDetails(projectId);
    const integration = this.projectManager.getProject(projectId).integrations.firebase;

    if (details) {
      return {
        connected: true,
        details,
        integration,
      };
    }

    if (this.hasStoredUserOAuthRefreshToken(projectId)) {
      const passphrase = this.getVaultPassphrase();
      const userEmail =
        this.vaultManager.getCredential(passphrase, 'firebase', this.vaultKey(projectId, 'connected_by_email')) ??
        'unknown';
      return {
        connected: true,
        details: this.buildOAuthPreviewConnectionDetails(projectId, userEmail),
        integration,
      };
    }

    return { connected: false };
  }

  /**
   * Preview details after Google sign-in. Prefer a GCP project id already stored in the vault
   * (e.g. after discover) so the UI matches Cloud Console when Studio used a non-default id.
   */
  private buildOAuthPreviewConnectionDetails(studioProjectId: string, userEmail: string): GcpConnectionDetails {
    const gcpProjectId = this.getStoredGcpProjectId(studioProjectId) ?? buildStudioGcpProjectId(studioProjectId);
    return {
      projectId: gcpProjectId,
      serviceAccountEmail: `${GCP_PROVISIONER_SERVICE_ACCOUNT_ID}@${gcpProjectId}.iam.gserviceaccount.com`,
      userEmail,
      connectedAt: new Date().toISOString(),
    };
  }

  /**
   * Reconcile a Firebase provisioning graph step with live GCP + vault.
   * Each step is handled independently, checking only what that step produces.
   *
   * @returns `null` if this step key is not handled here.
   */
  async syncProvisioningFirebaseGraphStep(
    studioProjectId: string,
    stepKey: string,
  ): Promise<
    | { reconciled: true; resourcesProduced: Record<string, string> }
    | { reconciled: false; message: string; suggestsReauth?: boolean }
    | null
  > {
    const hasOAuth = this.hasStoredUserOAuthRefreshToken(studioProjectId);
    switch (stepKey) {
      case 'firebase:create-gcp-project':
        return this.syncStepCreateGcpProject(studioProjectId, hasOAuth);
      case 'firebase:enable-firebase':
        return this.syncStepEnableFirebase(studioProjectId);
      case 'firebase:create-provisioner-sa':
        return this.syncStepCreateProvisionerSa(studioProjectId, hasOAuth);
      case 'firebase:bind-provisioner-iam':
        return this.syncStepBindProvisionerIam(studioProjectId, hasOAuth);
      case 'firebase:generate-sa-key':
        return this.syncStepGenerateSaKey(studioProjectId, hasOAuth);
      default:
        return null;
    }
  }

  /**
   * Sync: `firebase:create-gcp-project`
   * Produces: `gcp_project_id` in vault.
   * A 403 on GET project means the project EXISTS in GCP — this step produced it.
   * Store the project ID and reconcile; downstream SA/key steps will fail independently if needed.
   */
  private async syncStepCreateGcpProject(
    studioProjectId: string,
    hasOAuth: boolean,
  ): Promise<
    | { reconciled: true; resourcesProduced: Record<string, string> }
    | { reconciled: false; message: string; suggestsReauth?: boolean }
  > {
    const userEmail = (): string =>
      this.vaultManager.getCredential(
        this.getVaultPassphrase(),
        'firebase',
        this.vaultKey(studioProjectId, 'connected_by_email'),
      ) ?? 'unknown';

    let gcpProjectId = this.getStoredGcpProjectId(studioProjectId);

    // No project ID in vault — try discover / create.
    if (!gcpProjectId) {
      if (!hasOAuth) {
        return {
          reconciled: false,
          message: 'No GCP project linked and no Google OAuth session. Connect with Google to create or discover the project.',
          suggestsReauth: true,
        };
      }

      const discover = await this.discoverStudioGcpProjectWithStoredOAuth(studioProjectId);
      console.log(`[studio-gcp] sync create-gcp-project: discover=${discover.outcome}: ${discover.message}`);

      if (discover.outcome === 'linked' || discover.outcome === 'already_linked') {
        gcpProjectId = discover.gcpProjectId!;
      } else if (discover.outcome === 'inaccessible' && discover.gcpProjectId) {
        // Only reachable when discoverStudioGcpProjectWithStoredOAuth had a stored vault ID
        // that returned 403 — meaning the project was previously linked but access was lost.
        // GCP 403 on an unknown expected ID now falls through to display-name search and
        // returns not_found (handled above), so this branch is only triggered for vault IDs.
        this.storeGcpProjectIdInVault(studioProjectId, discover.gcpProjectId);
        this.applyGcpProjectLinkedAfterOauth(studioProjectId, discover.gcpProjectId, userEmail());
        return {
          reconciled: false,
          message: `GCP project "${discover.gcpProjectId}" exists but the current Google credentials do not have access (403). Re-authenticating with Google to refresh access.`,
          suggestsReauth: true,
        };
      } else if (discover.outcome === 'not_found') {
        // Project does not exist — create it now.
        try {
          const token = await this.requireUserOAuthAccessToken(studioProjectId, 'sync:create-gcp-project');
          gcpProjectId = await this.ensureProjectForStudioProject(token, studioProjectId);
          await this.ensureRequiredProjectApis(token, gcpProjectId);
          this.applyGcpProjectLinkedAfterOauth(studioProjectId, gcpProjectId, userEmail());
        } catch (err) {
          return { reconciled: false, message: `Could not create GCP project: ${(err as Error).message}` };
        }
      } else {
        return { reconciled: false, message: discover.message };
      }
    } else {
      // Project ID is in vault — verify the project still exists in GCP.
      try {
        const token = await this.getAccessTokenForGcpOperations(studioProjectId, 'sync:verify-gcp-project');
        const summary = await this.fetchGcpProjectSummary(token, gcpProjectId);
        if (!summary.ok) {
          if (summary.reason === 'not_found') {
            return {
              reconciled: false,
              message: `GCP project "${gcpProjectId}" was not found in GCP. It may have been deleted. Revert this step to unlink it.`,
            };
          }
          // 403: project exists in GCP. The project ID is already in vault (so this is
          // not a first-time discovery). A persistent 403 after a prior OAuth means this
          // Google account genuinely lacks access — re-auth won't help, so DO NOT loop.
          // Reconcile the step (project exists = create-gcp-project is done) and let
          // the downstream SA/key steps fail with their own accurate permission errors.
          console.log(`[studio-gcp] sync create-gcp-project: project "${gcpProjectId}" is accessible by GCP (exists) but not by this token — reconciling step as done.`);
        }
      } catch (err) {
        return { reconciled: false, message: `Could not verify GCP project: ${(err as Error).message}` };
      }
    }

    return { reconciled: true, resourcesProduced: { gcp_project_id: gcpProjectId } };
  }

  /**
   * Sync: `firebase:enable-firebase`
   * Produces: `firebase_project_id` (same value as gcp_project_id for Studio projects).
   * This step's job is to activate Firebase on the GCP project. Sync just checks that
   * the project ID is available; actual API enablement is validated during provisioning.
   */
  private syncStepEnableFirebase(
    studioProjectId: string,
  ):
    | { reconciled: true; resourcesProduced: Record<string, string> }
    | { reconciled: false; message: string; suggestsReauth?: boolean }
    | null {
    const pid =
      this.getStoredConnectionDetails(studioProjectId)?.projectId ??
      this.getStoredGcpProjectId(studioProjectId);
    if (!pid) {
      // Blocked by create-gcp-project which hasn't run yet — return null so the
      // plan/sync dependency check handles it.
      return null;
    }
    return { reconciled: true, resourcesProduced: { firebase_project_id: pid } };
  }

  /**
   * Sync: `firebase:create-provisioner-sa`
   * Produces: `provisioner_sa_email` in vault.
   * Checks whether the SA exists in GCP IAM. If missing and OAuth is available, creates it only.
   */
  private async syncStepCreateProvisionerSa(
    studioProjectId: string,
    hasOAuth: boolean,
  ): Promise<
    | { reconciled: true; resourcesProduced: Record<string, string> }
    | { reconciled: false; message: string; suggestsReauth?: boolean }
  > {
    const gcpProjectId = this.getStoredGcpProjectId(studioProjectId);
    if (!gcpProjectId) {
      return { reconciled: false, message: 'GCP project id not in vault. Complete "Create GCP Project" first.' };
    }

    const passphrase = this.getVaultPassphrase();
    const storedSaEmail = this.vaultManager
      .getCredential(passphrase, 'firebase', this.vaultKey(studioProjectId, 'service_account_email'))
      ?.trim();

    const expectedSaEmail = `${GCP_PROVISIONER_SERVICE_ACCOUNT_ID}@${gcpProjectId}.iam.gserviceaccount.com`;

    // If we have a stored SA email, verify it exists in GCP IAM.
    if (storedSaEmail) {
      try {
        const token = await this.getAccessTokenForGcpOperations(studioProjectId, 'sync:verify-sa');
        await this.gcpRequest('GET', 'iam.googleapis.com', `/v1/projects/${gcpProjectId}/serviceAccounts/${encodeURIComponent(storedSaEmail)}`, token);
        return { reconciled: true, resourcesProduced: { provisioner_sa_email: storedSaEmail } };
      } catch (err) {
        if (err instanceof GcpHttpError && err.statusCode === 403) {
          // 403 on IAM GET = stale / wrong-account token.
          return {
            reconciled: false,
            message: 'Could not verify service account: Google credentials are invalid or expired. Re-authenticating.',
            suggestsReauth: true,
          };
        }
        if (!(err instanceof GcpHttpError) || err.statusCode !== 404) {
          return { reconciled: false, message: `Could not verify service account: ${(err as Error).message}` };
        }
        // SA was deleted — fall through to re-create.
      }
    }

    // SA not in vault or was deleted.
    if (!hasOAuth) {
      return {
        reconciled: false,
        message: 'Provisioner service account not found. Connect with Google to create it.',
        suggestsReauth: true,
      };
    }

    try {
      const token = await this.requireUserOAuthAccessToken(studioProjectId, 'sync:create-provisioner-sa');
      const saEmail = await this.ensureProvisionerServiceAccount(token, gcpProjectId);
      this.storeProvisionerServiceAccountEmail(studioProjectId, saEmail);
      return { reconciled: true, resourcesProduced: { provisioner_sa_email: saEmail } };
    } catch (err) {
      const is403 = err instanceof GcpHttpError && err.statusCode === 403;
      return {
        reconciled: false,
        message: `Could not create service account: ${(err as Error).message}`,
        suggestsReauth: is403 || undefined,
      };
    }
  }

  /**
   * Sync: `firebase:bind-provisioner-iam`
   * Produces: no vault artifact — checks IAM role bindings.
   * If roles are missing and OAuth is available, binds them.
   */
  private async syncStepBindProvisionerIam(
    studioProjectId: string,
    hasOAuth: boolean,
  ): Promise<
    | { reconciled: true; resourcesProduced: Record<string, string> }
    | { reconciled: false; message: string; suggestsReauth?: boolean }
  > {
    const gcpProjectId = this.getStoredGcpProjectId(studioProjectId);
    const passphrase = this.getVaultPassphrase();
    const saEmail = this.vaultManager
      .getCredential(passphrase, 'firebase', this.vaultKey(studioProjectId, 'service_account_email'))
      ?.trim();

    if (!gcpProjectId || !saEmail) {
      return { reconciled: false, message: 'GCP project or service account not set up. Run prior steps first.' };
    }

    const member = `serviceAccount:${saEmail}`;
    try {
      const token = await this.getAccessTokenForGcpOperations(studioProjectId, 'sync:check-iam');
      const missing = await this.findMissingProvisionerRoles(token, gcpProjectId, member);
      if (missing.length === 0) {
        return { reconciled: true, resourcesProduced: {} };
      }

      // Roles are missing — bind them if we have OAuth.
      if (!hasOAuth) {
        return {
          reconciled: false,
          message: `Missing IAM bindings: ${missing.join(', ')}. Connect with Google to grant them.`,
          suggestsReauth: true,
        };
      }

      const writeToken = await this.requireUserOAuthAccessToken(studioProjectId, 'sync:bind-iam');
      await this.sleep(2000);
      await this.grantProvisionerProjectRoles(writeToken, gcpProjectId, saEmail);
      return { reconciled: true, resourcesProduced: {} };
    } catch (err) {
      const is403 = err instanceof GcpHttpError && err.statusCode === 403;
      return {
        reconciled: false,
        message: `IAM check/bind failed: ${(err as Error).message}`,
        suggestsReauth: is403 || undefined,
      };
    }
  }

  /**
   * Sync: `firebase:generate-sa-key`
   * Produces: `service_account_json` in vault.
   * Checks vault for a valid SA key JSON. If missing and OAuth is available, generates a new key.
   */
  private async syncStepGenerateSaKey(
    studioProjectId: string,
    hasOAuth: boolean,
  ): Promise<
    | { reconciled: true; resourcesProduced: Record<string, string> }
    | { reconciled: false; message: string; suggestsReauth?: boolean }
  > {
    const passphrase = this.getVaultPassphrase();
    const raw = this.vaultManager.getCredential(
      passphrase,
      'firebase',
      this.vaultKey(studioProjectId, 'service_account_json'),
    );

    if (raw?.trim()) {
      try {
        const parsed = JSON.parse(raw) as { type?: string };
        if (parsed.type === 'service_account') {
          return { reconciled: true, resourcesProduced: { service_account_json: 'vaulted' } };
        }
      } catch {
        // corrupted — fall through to regenerate
      }
    }

    // Key missing or corrupted — generate a new one if we have OAuth + project + SA.
    const gcpProjectId = this.getStoredGcpProjectId(studioProjectId);
    const saEmail = this.vaultManager
      .getCredential(passphrase, 'firebase', this.vaultKey(studioProjectId, 'service_account_email'))
      ?.trim();

    if (!gcpProjectId || !saEmail) {
      return { reconciled: false, message: 'Cannot generate SA key: GCP project or service account not set up. Run prior steps first.' };
    }

    if (!hasOAuth) {
      return {
        reconciled: false,
        message: 'Service account key not in vault. Connect with Google to generate it.',
        suggestsReauth: true,
      };
    }

    try {
      const token = await this.requireUserOAuthAccessToken(studioProjectId, 'sync:generate-sa-key');
      const saKeyJson = await this.createServiceAccountKey(token, gcpProjectId, saEmail);
      this.recordProvisionerServiceAccountKey(studioProjectId, gcpProjectId, saEmail, saKeyJson);
      return { reconciled: true, resourcesProduced: { service_account_json: 'vaulted' } };
    } catch (err) {
      const is403 = err instanceof GcpHttpError && err.statusCode === 403;
      return {
        reconciled: false,
        message: `Could not generate SA key: ${(err as Error).message}`,
        suggestsReauth: is403 || undefined,
      };
    }
  }

  /**
   * Re-runs SA creation, IAM binding, and key generation using the stored
   * OAuth refresh token. No browser flow required — call when the SA was
   * deleted or the vault key is missing.
   */
  async reprovisionFirebaseSetup(studioProjectId: string): Promise<void> {
    const gcpProjectId = this.getStoredGcpProjectId(studioProjectId);
    if (!gcpProjectId) {
      throw new Error('No GCP project id in vault — complete "Create GCP Project" first.');
    }

    const prev = this.getStoredConnectionDetails(studioProjectId);
    const passphrase = this.getVaultPassphrase();
    const userEmail =
      prev?.userEmail ??
      this.vaultManager.getCredential(passphrase, 'firebase', this.vaultKey(studioProjectId, 'connected_by_email')) ??
      'unknown';
    const connectedAt = prev?.connectedAt ?? new Date().toISOString();

    const accessToken = await this.requireUserOAuthAccessToken(studioProjectId, 'reprovision');
    console.log(`[studio-gcp] reprovision: enabling required APIs on ${gcpProjectId}…`);
    await this.ensureRequiredProjectApis(accessToken, gcpProjectId);

    console.log(`[studio-gcp] reprovision: ensuring service account on ${gcpProjectId}…`);
    const saEmail = await this.ensureProvisionerServiceAccount(accessToken, gcpProjectId);

    console.log(`[studio-gcp] reprovision: waiting for SA propagation before IAM binding…`);
    await this.sleep(4000);

    console.log(`[studio-gcp] reprovision: granting IAM roles to ${saEmail}…`);
    await this.grantProvisionerProjectRoles(accessToken, gcpProjectId, saEmail);

    console.log(`[studio-gcp] reprovision: creating new SA key for ${saEmail}…`);
    const saKeyJson = await this.createServiceAccountKey(accessToken, gcpProjectId, saEmail);
    this.storeServiceAccountKey(studioProjectId, saKeyJson);

    const updatedDetails: GcpConnectionDetails = {
      projectId: gcpProjectId,
      serviceAccountEmail: saEmail,
      userEmail,
      connectedAt,
    };
    this.storeConnectionDetails(studioProjectId, updatedDetails);
    this.syncProjectIntegration(studioProjectId, updatedDetails);
    console.log(`[studio-gcp] reprovision: complete for ${studioProjectId} (SA: ${saEmail}).`);
  }

  connectProjectWithServiceAccountKey(
    projectId: string,
    saKeyJson: string,
  ): GcpProjectConnectionStatus {
    this.ensureProjectExists(projectId);
    let parsed: { project_id?: string; client_email?: string; type?: string };
    try {
      parsed = JSON.parse(saKeyJson);
    } catch {
      throw new Error('Invalid service account JSON: not valid JSON.');
    }

    if (parsed.type !== 'service_account') {
      throw new Error('Invalid service account JSON: "type" must be "service_account".');
    }
    if (!parsed.project_id || !parsed.client_email) {
      throw new Error('Invalid service account JSON: missing project_id or client_email.');
    }

    const details: GcpConnectionDetails = {
      projectId: parsed.project_id,
      serviceAccountEmail: parsed.client_email,
      userEmail: 'manual',
      connectedAt: new Date().toISOString(),
    };

    this.storeServiceAccountKey(projectId, saKeyJson);
    this.storeConnectionDetails(projectId, details);
    return this.syncProjectIntegration(projectId, details);
  }

  disconnectProject(projectId: string): GcpProjectConnectionStatus & { removed: boolean } {
    this.ensureProjectExists(projectId);
    const removed = this.deleteStoredCredentials(projectId);

    const project = this.projectManager.getProject(projectId);
    if (project.integrations.firebase) {
      this.projectManager.updateIntegration(projectId, 'firebase', {
        status: 'pending',
        notes: 'Firebase/GCP connection disabled for this project.',
        config: {
          gcp_project_id: '',
          service_account_email: '',
          connected_by: '',
          credential_scope: 'project',
        },
      });
    }

    return {
      removed,
      connected: false,
      integration: this.projectManager.getProject(projectId).integrations.firebase,
    };
  }

  /** Cascade revert order for bootstrap phases (IAM → SA → vault → OAuth metadata). */
  static getCascadeSteps(stepId: GcpBootstrapPhaseId): GcpBootstrapPhaseId[] {
    const ORDER: GcpBootstrapPhaseId[] = [
      'oauth_consent',
      'gcp_project',
      'service_account',
      'iam_binding',
      'vault',
    ];
    const idx = ORDER.indexOf(stepId);
    if (idx === -1) {
      throw new Error(`Unknown bootstrap phase: ${stepId}`);
    }
    return ORDER.slice(idx);
  }

  private static readonly OAUTH_CONSENT_LABEL = 'Sign in with Google and approve access';

  /**
   * OAuth session UI: only `oauth_consent`. Infra phases are validated via provisioning plan sync.
   */
  async syncOAuthPipelineFromLiveState(studioProjectId: string): Promise<GcpOAuthStep[]> {
    this.ensureProjectExists(studioProjectId);
    const result = await this.validateStep(studioProjectId, 'oauth_consent');
    return [
      {
        id: 'oauth_consent',
        label: GcpConnectionService.OAUTH_CONSENT_LABEL,
        status: result.valid ? 'completed' : 'failed',
        message: result.message,
      },
    ];
  }

  hasStoredUserOAuthRefreshToken(studioProjectId: string): boolean {
    try {
      const passphrase = this.getVaultPassphrase();
      const t = this.vaultManager.getCredential(
        passphrase,
        'firebase',
        this.vaultKey(studioProjectId, 'gcp_oauth_refresh_token'),
      );
      return Boolean(t?.trim());
    } catch {
      return false;
    }
  }

  /**
   * Uses the stored Google refresh token to find the Studio GCP project (expected project id or
   * display name `Studio <studioProjectId>`), write `gcp_project_id` to the vault when needed, and
   * refresh the Firebase integration. Call after OAuth or from "Discover project" in the UI.
   */
  async discoverStudioGcpProjectWithStoredOAuth(
    studioProjectId: string,
  ): Promise<GcpOAuthProjectDiscoverResult> {
    this.ensureProjectExists(studioProjectId);
    const expectedProjectId = buildStudioGcpProjectId(studioProjectId);
    const expectedDisplayName = `Studio ${studioProjectId}`;
    const token = await this.getUserOAuthAccessToken(studioProjectId);
    if (!token) {
      return {
        outcome: 'error',
        expectedProjectId,
        expectedDisplayName,
        message:
          'No Google OAuth session stored. Run Connect with Google first, then discover again.',
      };
    }
    return this.discoverStudioGcpProjectWithUserAccessToken(studioProjectId, token);
  }

  /**
   * Same as {@link discoverStudioGcpProjectWithStoredOAuth} but uses an access token from the
   * OAuth callback (avoids an extra refresh during sign-in).
   */
  async discoverStudioGcpProjectWithUserAccessToken(
    studioProjectId: string,
    userAccessToken: string,
  ): Promise<GcpOAuthProjectDiscoverResult> {
    const expectedProjectId = buildStudioGcpProjectId(studioProjectId);
    const expectedDisplayName = `Studio ${studioProjectId}`;
    const passphrase = this.getVaultPassphrase();
    const userEmail =
      this.vaultManager.getCredential(passphrase, 'firebase', this.vaultKey(studioProjectId, 'connected_by_email')) ??
      'unknown';

    try {
      const vaultId = this.getStoredGcpProjectId(studioProjectId);

      if (vaultId) {
        const summary = await this.fetchGcpProjectSummary(userAccessToken, vaultId);
        if (!summary.ok) {
          // When vault has a specific stored ID and it's 403, we know this ID was previously
          // created/linked — so 403 here is genuinely "exists but inaccessible", not enumeration noise.
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
            message: `Vault lists GCP project "${vaultId}" but it was not found in GCP. Update or clear the link and run "Create GCP Project" again.`,
          };
        }
        this.applyGcpProjectLinkedAfterOauth(studioProjectId, vaultId, userEmail);
        const nameNote =
          summary.name === expectedDisplayName
            ? `Display name matches "${expectedDisplayName}".`
            : `Note: display name is "${summary.name}" (expected "${expectedDisplayName}").`;
        return {
          outcome: 'already_linked',
          gcpProjectId: vaultId,
          expectedProjectId,
          expectedDisplayName,
          message: `GCP project "${vaultId}" is reachable. ${nameNote}`,
        };
      }

      const byId = await this.fetchGcpProjectSummary(userAccessToken, expectedProjectId);
      if (byId.ok) {
        this.storeGcpProjectIdInVault(studioProjectId, expectedProjectId);
        this.applyGcpProjectLinkedAfterOauth(studioProjectId, expectedProjectId, userEmail);
        const nameNote =
          byId.name === expectedDisplayName
            ? `Linked project "${expectedProjectId}" (display name "${expectedDisplayName}").`
            : `Linked project "${expectedProjectId}". Display name is "${byId.name}" (expected "${expectedDisplayName}").`;
        return {
          outcome: 'linked',
          gcpProjectId: expectedProjectId,
          expectedProjectId,
          expectedDisplayName,
          message: nameNote,
        };
      }

      // GCP returns 403 for both "project exists, no access" AND "project does not exist"
      // (to prevent project ID enumeration). Do NOT short-circuit on 403 — fall through to
      // the display-name list search which will confirm whether the project truly exists.

      const matches = await this.findAccessibleGcpProjectsByDisplayName(userAccessToken, expectedDisplayName);
      if (matches.length === 0) {
        return {
          outcome: 'not_found',
          expectedProjectId,
          expectedDisplayName,
          message: `No GCP project with id "${expectedProjectId}" or display name "${expectedDisplayName}". Run the provisioning step "Create GCP Project" (or create a project with that display name in Cloud Console).`,
        };
      }
      if (matches.length > 1) {
        return {
          outcome: 'ambiguous',
          expectedProjectId,
          expectedDisplayName,
          message: `Multiple GCP projects are named "${expectedDisplayName}". Rename or delete duplicates in Cloud Console, or link the correct project id in Studio.`,
        };
      }

      const chosen = matches[0]!;
      this.storeGcpProjectIdInVault(studioProjectId, chosen.projectId);
      this.applyGcpProjectLinkedAfterOauth(studioProjectId, chosen.projectId, userEmail);
      return {
        outcome: 'linked',
        gcpProjectId: chosen.projectId,
        expectedProjectId,
        expectedDisplayName,
        message: `Linked GCP project "${chosen.projectId}" (display name "${expectedDisplayName}").`,
      };
    } catch (err) {
      return {
        outcome: 'error',
        expectedProjectId,
        expectedDisplayName,
        message: (err as Error).message,
      };
    }
  }

  async validateStep(studioProjectId: string, stepId: GcpBootstrapPhaseId): Promise<GcpStepValidationResult> {
    this.ensureProjectExists(studioProjectId);
    const hasOAuth = this.hasStoredUserOAuthRefreshToken(studioProjectId);

    switch (stepId) {
      case 'oauth_consent': {
        if (this.hasStoredUserOAuthRefreshToken(studioProjectId)) {
          return { valid: true, message: 'Google OAuth refresh token is stored.' };
        }
        const d = this.getStoredConnectionDetails(studioProjectId);
        if (!d) {
          return { valid: false, message: 'No OAuth refresh token or service account connection. Sign in with Google or upload a service account key.' };
        }
        return {
          valid: true,
          message: `Connection recorded for GCP project ${d.projectId} (${d.serviceAccountEmail}).`,
        };
      }
      case 'gcp_project': {
        const details = this.getStoredConnectionDetails(studioProjectId);
        const projectId = details?.projectId ?? this.getStoredGcpProjectId(studioProjectId);
        if (!projectId) {
          return { valid: false, message: 'No GCP project id stored. Complete "Create GCP Project" first.' };
        }
        try {
          const token = await this.getAccessTokenForGcpOperations(studioProjectId, 'validate:gcp_project');
          const lookup = await this.getGcpProject(token, projectId);
          if (lookup === 'found') {
            return { valid: true, message: `Project "${projectId}" exists and is reachable.` };
          }
          if (lookup === 'not_found') {
            return { valid: false, message: `Project "${projectId}" was not found in GCP.` };
          }
          return { valid: false, message: `Project "${projectId}" exists but is not accessible with the provisioner key (403).` };
        } catch (err) {
          return { valid: false, message: (err as Error).message };
        }
      }
      case 'service_account': {
        const projectId = this.getStoredGcpProjectId(studioProjectId);
        const passphrase = this.getVaultPassphrase();
        const saEmail = this.vaultManager
          .getCredential(passphrase, 'firebase', this.vaultKey(studioProjectId, 'service_account_email'))
          ?.trim();
        if (!projectId || !saEmail) {
          return { valid: false, message: 'No service account email stored.' };
        }
        const saPath = `/v1/projects/${projectId}/serviceAccounts/${encodeURIComponent(saEmail)}`;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const token = await this.getAccessTokenForGcpOperations(studioProjectId, 'validate:service_account');
            await this.gcpRequest('GET', 'iam.googleapis.com', saPath, token);
            return { valid: true, message: `Service account ${saEmail} exists.` };
          } catch (err) {
            if (err instanceof GcpHttpError && err.statusCode === 404) {
              return { valid: false, message: `Service account not found in project.` };
            }
            const toEnable = parseDisabledApisServiceToEnable(err);
            if (toEnable && attempt === 0) {
              const token = await this.getAccessTokenForGcpOperations(studioProjectId, 'validate:service_account:enable-api');
              const enabled = await this.tryEnableProjectService(projectId, token, toEnable);
              if (enabled) {
                await this.sleep(4500);
                continue;
              }
            }
            const apiHelp = formatGcpApiDisabledHelp(projectId, err, hasOAuth);
            if (apiHelp) return { valid: false, message: apiHelp };
            return { valid: false, message: (err as Error).message };
          }
        }
        return {
          valid: false,
          message:
            'Service account check failed after attempting to enable required GCP APIs. Retry sync in a minute or enable IAM API manually.',
        };
      }
      case 'iam_binding': {
        const projectId = this.getStoredGcpProjectId(studioProjectId);
        const passphrase = this.getVaultPassphrase();
        const saEmail = this.vaultManager
          .getCredential(passphrase, 'firebase', this.vaultKey(studioProjectId, 'service_account_email'))
          ?.trim();
        if (!projectId || !saEmail) {
          return { valid: false, message: 'No connection metadata for IAM check.' };
        }
        const member = `serviceAccount:${saEmail}`;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const token = await this.getAccessTokenForGcpOperations(studioProjectId, 'validate:iam_binding');
            const missing = await this.findMissingProvisionerRoles(token, projectId, member);
            if (missing.length === 0) {
              return {
                valid: true,
                message: `All ${PROVISIONER_PROJECT_ROLES.length} provisioner roles are bound for ${member}.`,
              };
            }
            return {
              valid: false,
              message: `Missing IAM bindings: ${missing.join(', ')}`,
            };
          } catch (err) {
            const toEnable = parseDisabledApisServiceToEnable(err);
            if (toEnable && attempt === 0) {
              const token = await this.getAccessTokenForGcpOperations(studioProjectId, 'validate:iam_binding:enable-api');
              const enabled = await this.tryEnableProjectService(projectId, token, toEnable);
              if (enabled) {
                await this.sleep(4500);
                continue;
              }
            }
            const apiHelp = formatGcpApiDisabledHelp(projectId, err, hasOAuth);
            if (apiHelp) return { valid: false, message: apiHelp };
            return { valid: false, message: (err as Error).message };
          }
        }
        return {
          valid: false,
          message:
            'IAM policy check failed after attempting to enable required GCP APIs. Retry sync in a minute.',
        };
      }
      case 'vault': {
        const passphrase = this.getVaultPassphrase();
        const raw = this.vaultManager.getCredential(
          passphrase,
          'firebase',
          this.vaultKey(studioProjectId, 'service_account_json'),
        );
        if (!raw?.trim()) {
          return { valid: false, message: 'No service_account_json in vault.' };
        }
        try {
          const parsed = JSON.parse(raw) as { type?: string };
          if (parsed.type !== 'service_account') {
            return { valid: false, message: 'Vault payload is not a service account JSON (type !== service_account).' };
          }
          return { valid: true, message: 'Service account key JSON is present and well-formed.' };
        } catch {
          return { valid: false, message: 'Vault payload is not valid JSON.' };
        }
      }
      default: {
        return { valid: false, message: `Unknown step: ${String(stepId)}` };
      }
    }
  }

  async revertSteps(
    studioProjectId: string,
    cascadeStepIds: GcpBootstrapPhaseId[],
  ): Promise<GcpStepRevertResult[]> {
    this.ensureProjectExists(studioProjectId);
    const toRun = new Set(cascadeStepIds);
    const results: GcpStepRevertResult[] = [];

    let accessToken: string | null = null;
    let tokenError: string | null = null;
    const needsGcpToken =
      toRun.has('iam_binding') || toRun.has('service_account') || toRun.has('gcp_project');
    if (needsGcpToken) {
      try {
        // Prefer user OAuth for all write operations; SA fallback is acceptable for
        // IAM/SA ops (the SA has those roles) but will fail for API-enablement.
        accessToken = await this.getAccessTokenForGcpOperations(studioProjectId, 'revert');
      } catch (err) {
        tokenError = (err as Error).message;
      }
    }

    const details = this.getStoredConnectionDetails(studioProjectId);
    const passphrase = this.getVaultPassphrase();
    const revertProjectId = details?.projectId ?? this.getStoredGcpProjectId(studioProjectId);
    const revertSaEmail =
      details?.serviceAccountEmail ??
      this.vaultManager
        .getCredential(passphrase, 'firebase', this.vaultKey(studioProjectId, 'service_account_email'))
        ?.trim();

    if (toRun.has('iam_binding')) {
      if (!accessToken) {
        results.push({
          stepId: 'iam_binding',
          reverted: false,
          message: tokenError ?? 'No access token for IAM revert.',
        });
      } else if (!revertProjectId || !revertSaEmail) {
        results.push({ stepId: 'iam_binding', reverted: false, message: 'Missing connection metadata.' });
      } else {
        try {
          await this.removeProvisionerRolesFromIam(accessToken, revertProjectId, revertSaEmail);
          results.push({
            stepId: 'iam_binding',
            reverted: true,
            message: 'Removed provisioner role bindings from project IAM.',
          });
        } catch (err) {
          results.push({ stepId: 'iam_binding', reverted: false, message: (err as Error).message });
        }
      }
    }

    if (toRun.has('service_account')) {
      if (!accessToken) {
        results.push({
          stepId: 'service_account',
          reverted: false,
          message: tokenError ?? 'No access token for service account revert.',
        });
      } else if (!revertProjectId || !revertSaEmail) {
        results.push({ stepId: 'service_account', reverted: false, message: 'Missing connection metadata.' });
      } else {
        try {
          await this.gcpRequest(
            'DELETE',
            'iam.googleapis.com',
            `/v1/projects/${revertProjectId}/serviceAccounts/${encodeURIComponent(revertSaEmail)}`,
            accessToken,
          );
          results.push({
            stepId: 'service_account',
            reverted: true,
            message: `Deleted service account ${revertSaEmail}.`,
          });
        } catch (err) {
          if (err instanceof GcpHttpError && err.statusCode === 404) {
            results.push({ stepId: 'service_account', reverted: true, message: 'Service account already absent.' });
          } else {
            results.push({ stepId: 'service_account', reverted: false, message: (err as Error).message });
          }
        }
      }
    }

    if (toRun.has('gcp_project')) {
      results.push({
        stepId: 'gcp_project',
        reverted: false,
        message:
          'GCP project deletion is not performed via the provisioner. Delete the project in Google Cloud Console or use the teardown flow.',
      });
    }

    // Only wipe local credentials once all GCP API steps have actually succeeded.
    // If any API step (iam_binding, service_account) failed we keep the vault intact so
    // the caller can fix the problem (e.g. re-authenticate) and retry the revert.
    const gcpApiAttempted = results.filter(
      (r) => r.stepId === 'iam_binding' || r.stepId === 'service_account',
    );
    const gcpApiAllSucceeded = gcpApiAttempted.every((r) => r.reverted);

    const needsLocalCleanup =
      (toRun.has('vault') || toRun.has('oauth_consent')) && gcpApiAllSucceeded;
    if (needsLocalCleanup) {
      const removed = this.deleteStoredCredentials(studioProjectId);
      const project = this.projectManager.getProject(studioProjectId);
      if (project.integrations.firebase) {
        this.projectManager.updateIntegration(studioProjectId, 'firebase', {
          status: 'pending',
          notes: 'Firebase/GCP connection disabled for this project.',
          config: {
            gcp_project_id: '',
            service_account_email: '',
            connected_by: '',
            credential_scope: 'project',
          },
        });
      }
      const localMsg = removed
        ? 'Removed credentials from vault and reset Firebase integration.'
        : 'Reset Firebase integration (vault was already empty).';
      if (toRun.has('vault')) {
        results.push({ stepId: 'vault', reverted: true, message: localMsg });
      }
      if (toRun.has('oauth_consent')) {
        results.push({ stepId: 'oauth_consent', reverted: true, message: localMsg });
      }
    } else if (toRun.has('vault') || toRun.has('oauth_consent')) {
      // GCP API steps failed — credentials preserved for retry.
      const stepIds = [
        ...(toRun.has('vault') ? ['vault' as const] : []),
        ...(toRun.has('oauth_consent') ? ['oauth_consent' as const] : []),
      ];
      for (const stepId of stepIds) {
        results.push({
          stepId,
          reverted: false,
          message:
            'Credentials kept in vault because GCP resource cleanup did not fully succeed. Fix the errors above, then revert again.',
        });
      }
    }

    return results;
  }

  /**
   * Access token from the user's Google OAuth refresh token (offline access), if stored.
   * Same principal as the connect flow — typically Owner/Editor on the GCP project.
   */
  async hasGcpOAuthToken(studioProjectId: string): Promise<boolean> {
    const token = await this.getUserOAuthAccessToken(studioProjectId);
    return token !== null;
  }

  private async getUserOAuthAccessToken(studioProjectId: string): Promise<string | null> {
    try {
      const passphrase = this.getVaultPassphrase();
      const refresh = this.vaultManager.getCredential(
        passphrase,
        'firebase',
        this.vaultKey(studioProjectId, 'gcp_oauth_refresh_token'),
      );
      if (!refresh?.trim()) return null;
      this.ensureOAuthConfigured();
      const client = new OAuth2Client({
        clientId: this.oauthClientId,
        clientSecret: this.oauthClientSecret,
      });
      client.setCredentials({ refresh_token: refresh.trim() });
      const tokenResponse = await client.getAccessToken();
      const token = tokenResponse.token;
      return token ?? null;
    } catch {
      return null;
    }
  }

  private async getServiceAccountAccessToken(studioProjectId: string): Promise<string> {
    const passphrase = this.getVaultPassphrase();
    const saJson = this.vaultManager.getCredential(
      passphrase,
      'firebase',
      this.vaultKey(studioProjectId, 'service_account_json'),
    );
    if (!saJson?.trim()) {
      throw new Error('No service account key in vault. Cannot call GCP APIs for validate/revert.');
    }
    let credentials: Record<string, unknown>;
    try {
      credentials = JSON.parse(saJson) as Record<string, unknown>;
    } catch {
      throw new Error('Stored service account JSON is invalid.');
    }
    const auth = new GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    const client = await auth.getClient();
    const tokenResponse = await client.getAccessToken();
    const token = tokenResponse.token;
    if (!token) {
      throw new Error('Failed to obtain access token from service account credentials.');
    }
    return token;
  }

  /**
   * Token for validate / plan-sync Firebase reconciliation / revert against GCP.
   * Prefers the end-user OAuth refresh token when present so IAM and Resource Manager
   * calls use the same permissions as connect; falls back to the provisioner SA key.
   */
  private async getAccessTokenForGcpOperations(
    studioProjectId: string,
    context?: string,
  ): Promise<string> {
    const userToken = await this.getUserOAuthAccessToken(studioProjectId);
    if (userToken) {
      if (context) console.log(`[studio-gcp] ${context}: using user OAuth token.`);
      return userToken;
    }
    if (context)
      console.warn(
        `[studio-gcp] ${context}: no user OAuth token available — falling back to service account key.`,
      );
    return this.getServiceAccountAccessToken(studioProjectId);
  }

  /**
   * Like getAccessTokenForGcpOperations but throws if no user OAuth token is stored.
   * Use for write operations that require user-level project permissions (API enablement,
   * SA creation, IAM binding, SA deletion) — the provisioner SA key lacks some of those
   * roles and is invalid anyway if the SA was deleted.
   */
  /** User Google OAuth access token — required for SA key creation and some IAM operations. */
  async requireUserOAuthAccessToken(studioProjectId: string, context: string): Promise<string> {
    const userToken = await this.getUserOAuthAccessToken(studioProjectId);
    if (userToken) {
      console.log(`[studio-gcp] ${context}: using user OAuth token.`);
      return userToken;
    }
    throw new Error(
      'A Google OAuth session is required for this operation but no stored refresh token was found. ' +
        'Run "Connect with Google" to authenticate.',
    );
  }

  /**
   * Turn on a GCP API for the project via Service Usage (needs roles like serviceusage.services.enable).
   */
  private async tryEnableProjectService(
    gcpProjectId: string,
    accessToken: string,
    serviceName: string,
  ): Promise<boolean> {
    try {
      await this.gcpRequest(
        'POST',
        'serviceusage.googleapis.com',
        `/v1/projects/${encodeURIComponent(gcpProjectId)}/services/${encodeURIComponent(serviceName)}:enable`,
        accessToken,
        '{}',
      );
      console.log(`[studio-gcp] Service Usage enable requested for ${serviceName} on ${gcpProjectId}.`);
      return true;
    } catch (err) {
      if (err instanceof GcpHttpError) {
        const b = err.body;
        if (
          err.statusCode === 409 ||
          b.includes('already been enabled') ||
          b.includes('already enabled') ||
          b.includes('ALREADY_EXISTS') ||
          b.includes('already exists')
        ) {
          console.log(`[studio-gcp] ${serviceName} already enabled on ${gcpProjectId}.`);
          return true;
        }
        console.log(
          `[studio-gcp] Failed to enable ${serviceName} on ${gcpProjectId} (${err.statusCode}): ${b.slice(0, 300)}`,
        );
      } else {
        console.log(
          `[studio-gcp] Failed to enable ${serviceName} on ${gcpProjectId}: ${(err as Error).message}`,
        );
      }
      return false;
    }
  }

  async ensureRequiredProjectApis(accessToken: string, gcpProjectId: string): Promise<void> {
    const apis = [
      'serviceusage.googleapis.com',
      'iam.googleapis.com',
      'cloudresourcemanager.googleapis.com',
      'firebase.googleapis.com',
    ];
    let anyEnabled = false;
    for (const api of apis) {
      const ok = await this.tryEnableProjectService(gcpProjectId, accessToken, api);
      if (ok) anyEnabled = true;
    }
    if (anyEnabled) {
      console.log(`[studio-gcp] Waiting for API propagation on ${gcpProjectId}…`);
      await this.sleep(4000);
    }
  }

  private async findMissingProvisionerRoles(
    accessToken: string,
    gcpProjectId: string,
    member: string,
  ): Promise<string[]> {
    const getRes = await this.gcpRequest(
      'POST',
      'cloudresourcemanager.googleapis.com',
      `/v1/projects/${gcpProjectId}:getIamPolicy`,
      accessToken,
      JSON.stringify({}),
    );
    const currentPolicy = JSON.parse(getRes.body) as {
      bindings?: Array<{ role: string; members: string[] }>;
    };
    const bindings = currentPolicy.bindings ?? [];
    const missing: string[] = [];
    for (const role of PROVISIONER_PROJECT_ROLES) {
      const existing = bindings.find((b) => b.role === role);
      if (!existing || !existing.members.includes(member)) {
        missing.push(role);
      }
    }
    return missing;
  }

  private async removeProvisionerRolesFromIam(
    accessToken: string,
    gcpProjectId: string,
    saEmail: string,
  ): Promise<void> {
    const member = `serviceAccount:${saEmail}`;
    const getRes = await this.gcpRequest(
      'POST',
      'cloudresourcemanager.googleapis.com',
      `/v1/projects/${gcpProjectId}:getIamPolicy`,
      accessToken,
      JSON.stringify({}),
    );
    const currentPolicy = JSON.parse(getRes.body) as {
      bindings?: Array<{ role: string; members: string[] }>;
      etag?: string;
    };
    const bindings = (currentPolicy.bindings ?? []).map((b) => ({
      role: b.role,
      members: [...b.members],
    }));
    let policyChanged = false;
    for (const role of PROVISIONER_PROJECT_ROLES) {
      const existing = bindings.find((b) => b.role === role);
      if (existing && existing.members.includes(member)) {
        existing.members = existing.members.filter((m) => m !== member);
        policyChanged = true;
        if (existing.members.length === 0) {
          const idx = bindings.indexOf(existing);
          bindings.splice(idx, 1);
        }
      }
    }
    if (!policyChanged) {
      return;
    }
    await this.gcpRequest(
      'POST',
      'cloudresourcemanager.googleapis.com',
      `/v1/projects/${gcpProjectId}:setIamPolicy`,
      accessToken,
      JSON.stringify({
        policy: {
          bindings,
          etag: currentPolicy.etag,
        },
      }),
    );
  }

  private async runSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    try {
      const code = await session.codePromise;

      session.status.phase = 'processing';

      const { tokens } = await session.client.getToken(code);
      if (!tokens.access_token) {
        throw new Error('OAuth token exchange did not return an access token.');
      }
      session.client.setCredentials(tokens);

      if (tokens.refresh_token) {
        const passphrase = this.getVaultPassphrase();
        this.vaultManager.setCredential(
          passphrase,
          'firebase',
          this.vaultKey(session.projectId, 'gcp_oauth_refresh_token'),
          tokens.refresh_token,
        );
      }

      const tokenInfo = await this.fetchTokenInfo(tokens.access_token);
      const userEmail = tokenInfo.email ?? 'unknown';
      const grantedScopes = tokenInfo.scope ?? '';
      console.log(
        `[studio-gcp] OAuth token for ${userEmail}, granted scopes: ${grantedScopes}`,
      );

      if (!grantedScopes.includes('cloud-platform')) {
        throw new Error(
          'The Google OAuth token was not granted the cloud-platform scope. ' +
            'Ensure the OAuth consent screen includes this scope and the user approves it.',
        );
      }

      const passphrase = this.getVaultPassphrase();
      this.vaultManager.setCredential(
        passphrase,
        'firebase',
        this.vaultKey(session.projectId, 'connected_by_email'),
        userEmail,
      );

      this.markStep(session, 'oauth_consent', 'completed', `Signed in as ${userEmail}`);

      const discover = await this.discoverStudioGcpProjectWithUserAccessToken(
        session.projectId,
        tokens.access_token,
      );
      session.status.gcpProjectDiscover = discover;

      session.status.phase = 'completed';
      session.status.connected = true;
      session.status.details = this.buildOAuthPreviewConnectionDetails(session.projectId, userEmail);
    } catch (err) {
      this.failSession(session, (err as Error).message);
    } finally {
      clearTimeout(session.timeout);
      this.closeServer(session.server);
    }
  }

  private handleOAuthCallback(session: InternalSession, req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!req.url) {
      res.writeHead(400);
      res.end('Bad request');
      return;
    }

    const parsed = url.parse(req.url, true);
    const returnedState = parsed.query['state'] as string | undefined;
    const code = parsed.query['code'] as string | undefined;
    const error = parsed.query['error'] as string | undefined;

    if (session.status.phase !== 'awaiting_user') {
      res.writeHead(409, { 'Content-Type': 'text/html' });
      res.end(this.oauthResultPage(false, 'This OAuth session is no longer active.'));
      return;
    }

    if (error) {
      this.failSession(session, `Authorization denied: ${error}`);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(this.oauthResultPage(false, `Authorization denied: ${error}`));
      return;
    }

    if (returnedState !== session.state) {
      this.failSession(session, 'OAuth state mismatch. Please retry.');
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(this.oauthResultPage(false, 'Invalid state parameter.'));
      return;
    }

    if (!code) {
      this.failSession(session, 'No authorization code received from Google.');
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(this.oauthResultPage(false, 'No authorization code received.'));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(this.oauthResultPage(true, 'Authorization successful. You can close this tab.'));
    session.resolveCode(code);
  }

  private ensureOAuthConfigured(): void {
    if (!this.oauthClientId.trim() || !this.oauthClientSecret.trim()) {
      throw new Error(
        'Google OAuth is not configured. Set PLATFORM_GCP_OAUTH_CLIENT_ID and PLATFORM_GCP_OAUTH_CLIENT_SECRET.',
      );
    }
  }

  private ensureProjectExists(projectId: string): void {
    this.projectManager.getProject(projectId);
  }

  private syncProjectIntegration(
    projectId: string,
    details: GcpConnectionDetails,
  ): GcpProjectConnectionStatus {
    const module = this.projectManager.getProject(projectId);
    if (!module.integrations.firebase) {
      this.projectManager.addIntegration(projectId, 'firebase');
    }

    const updated = this.projectManager.updateIntegration(projectId, 'firebase', {
      status: 'configured',
      notes: `Connected via project-scoped provisioner SA (${details.serviceAccountEmail}).`,
      config: {
        gcp_project_id: details.projectId,
        service_account_email: details.serviceAccountEmail,
        connected_by: details.userEmail,
        connected_at: details.connectedAt,
        credential_scope: 'project',
        token_source: 'credential_vault',
      },
    });

    return {
      connected: true,
      details,
      integration: updated.integrations.firebase,
    };
  }

  private applyGcpProjectLinkedAfterOauth(
    studioProjectId: string,
    gcpProjectId: string,
    userEmail: string,
  ): void {
    const module = this.projectManager.getProject(studioProjectId);
    if (!module.integrations.firebase) {
      this.projectManager.addIntegration(studioProjectId, 'firebase');
    }
    const existing = this.projectManager.getProject(studioProjectId).integrations.firebase;
    if (!existing) {
      return;
    }

    const sa = existing.config['service_account_email']?.trim() ?? '';
    const status: 'configured' | 'in_progress' =
      existing.status === 'configured' && sa ? 'configured' : 'in_progress';
    const tokenSource =
      status === 'configured' && sa
        ? existing.config['token_source'] ?? 'credential_vault'
        : 'user_oauth';

    this.projectManager.updateIntegration(studioProjectId, 'firebase', {
      status,
      notes:
        status === 'configured'
          ? existing.notes
          : `GCP project "${gcpProjectId}" linked after Google sign-in. Run provisioning plan sync to reconcile Firebase steps, service account, and vault.`,
      config: {
        gcp_project_id: gcpProjectId,
        connected_by: userEmail,
        connected_at: existing.config['connected_at']?.trim() || new Date().toISOString(),
        credential_scope: 'project',
        token_source: tokenSource,
      },
    });
  }

  private getStoredConnectionDetails(projectId: string): GcpConnectionDetails | null {
    const passphrase = this.getVaultPassphrase();
    const gcpProjectId = this.vaultManager.getCredential(passphrase, 'firebase', this.vaultKey(projectId, 'gcp_project_id'));
    const saEmail = this.vaultManager.getCredential(passphrase, 'firebase', this.vaultKey(projectId, 'service_account_email'));
    const userEmail = this.vaultManager.getCredential(passphrase, 'firebase', this.vaultKey(projectId, 'connected_by_email'));
    const connectedAt = this.vaultManager.getCredential(passphrase, 'firebase', this.vaultKey(projectId, 'connected_at'));

    if (!gcpProjectId || !saEmail) {
      return null;
    }

    return {
      projectId: gcpProjectId,
      serviceAccountEmail: saEmail,
      userEmail: userEmail ?? 'unknown',
      connectedAt: connectedAt ?? new Date(0).toISOString(),
    };
  }

  private storeConnectionDetails(projectId: string, details: GcpConnectionDetails): void {
    const passphrase = this.getVaultPassphrase();
    this.vaultManager.setCredential(passphrase, 'firebase', this.vaultKey(projectId, 'gcp_project_id'), details.projectId);
    this.vaultManager.setCredential(passphrase, 'firebase', this.vaultKey(projectId, 'service_account_email'), details.serviceAccountEmail);
    this.vaultManager.setCredential(passphrase, 'firebase', this.vaultKey(projectId, 'connected_by_email'), details.userEmail);
    this.vaultManager.setCredential(passphrase, 'firebase', this.vaultKey(projectId, 'connected_at'), details.connectedAt);
  }

  private storeServiceAccountKey(projectId: string, saKeyJson: string): void {
    this.vaultManager.setCredential(
      this.getVaultPassphrase(),
      'firebase',
      this.vaultKey(projectId, 'service_account_json'),
      saKeyJson,
    );
  }

  private deleteStoredCredentials(projectId: string): boolean {
    const passphrase = this.getVaultPassphrase();
    const removed = this.vaultManager.deleteCredential(passphrase, 'firebase', this.vaultKey(projectId, 'service_account_json'));
    this.vaultManager.deleteCredential(passphrase, 'firebase', this.vaultKey(projectId, 'gcp_project_id'));
    this.vaultManager.deleteCredential(passphrase, 'firebase', this.vaultKey(projectId, 'service_account_email'));
    this.vaultManager.deleteCredential(passphrase, 'firebase', this.vaultKey(projectId, 'connected_by_email'));
    this.vaultManager.deleteCredential(passphrase, 'firebase', this.vaultKey(projectId, 'connected_at'));
    this.vaultManager.deleteCredential(passphrase, 'firebase', this.vaultKey(projectId, 'gcp_oauth_refresh_token'));
    return removed;
  }

  private vaultKey(projectId: string, key: string): string {
    return `${projectId}/${key}`;
  }

  private getVaultPassphrase(): string {
    const passphrase = process.env['STUDIO_VAULT_PASSPHRASE']?.trim();
    if (!passphrase) {
      throw new Error(
        'STUDIO_VAULT_PASSPHRASE is required to use Studio credential storage for GCP/Firebase.',
      );
    }
    return passphrase;
  }

  private markStep(
    session: InternalSession,
    id: GcpOAuthStep['id'],
    status: GcpStepStatus,
    message?: string,
  ): void {
    session.status.steps = session.status.steps.map((step) =>
      step.id === id ? { ...step, status, ...(message ? { message } : {}) } : step,
    );
  }

  private failSession(session: InternalSession, message: string): void {
    if (session.status.phase === 'completed' || session.status.phase === 'failed') {
      return;
    }

    const activeStep = session.status.steps.find((step) => step.status === 'in_progress');
    if (activeStep) {
      this.markStep(session, activeStep.id, 'failed');
    } else if (session.status.steps.every((step) => step.status === 'pending')) {
      this.markStep(session, 'oauth_consent', 'failed');
    }

    session.status.phase = 'failed';
    session.status.error = message;
    session.status.connected = false;

    clearTimeout(session.timeout);
    session.rejectCode(new Error(message));
    this.closeServer(session.server);
  }

  private cloneSteps(steps: GcpOAuthStep[]): GcpOAuthStep[] {
    return steps.map((step) => ({ ...step }));
  }

  private async listenServer(server: http.Server): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, LOOPBACK_HOST, () => {
        server.off('error', reject);
        resolve();
      });
    });
  }

  private closeServer(server: http.Server): void {
    try {
      server.close();
    } catch {
      // ignore close failures
    }
  }

  async ensureProjectForStudioProject(accessToken: string, studioProjectId: string): Promise<string> {
    const existingId = this.getStoredGcpProjectId(studioProjectId);
    const gcpProjectId = existingId ?? this.generateGcpProjectId(studioProjectId);

    if (existingId) {
      const lookupResult = await this.getGcpProject(accessToken, gcpProjectId);
      if (lookupResult === 'found') {
        return gcpProjectId;
      }
      throw new Error(
        `Previously connected GCP project "${gcpProjectId}" is no longer accessible (${lookupResult}). ` +
          'Disconnect the Firebase integration and reconnect to create a new project.',
      );
    }

    const createResult = await this.tryCreateGcpProject(accessToken, gcpProjectId, studioProjectId);
    if (createResult === 'created' || createResult === 'already_exists') {
      await this.waitForProjectActive(accessToken, gcpProjectId);
      this.storeGcpProjectIdInVault(studioProjectId, gcpProjectId);
      return gcpProjectId;
    }

    console.log(
      `[studio-gcp] Project ID "${gcpProjectId}" is taken (${createResult}), retrying with random suffix.`,
    );
    const retryId = this.generateGcpProjectIdWithEntropy(studioProjectId);
    await this.tryCreateGcpProject(accessToken, retryId, studioProjectId, true);
    await this.waitForProjectActive(accessToken, retryId);
    this.storeGcpProjectIdInVault(studioProjectId, retryId);
    return retryId;
  }

  private generateGcpProjectId(studioProjectId: string): string {
    return buildStudioGcpProjectId(studioProjectId);
  }

  private generateGcpProjectIdWithEntropy(studioProjectId: string): string {
    const base = studioProjectId
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project';

    const entropy = crypto.randomBytes(4).toString('hex');
    const maxBaseLength = 30 - 'st--'.length - entropy.length;
    const trimmedBase = base.slice(0, maxBaseLength).replace(/-+$/g, '');
    return `st-${trimmedBase}-${entropy}`;
  }

  private async fetchGcpProjectSummary(
    accessToken: string,
    gcpProjectId: string,
  ): Promise<
    | { ok: true; projectId: string; name: string; lifecycleState?: string }
    | { ok: false; reason: 'not_found' | 'inaccessible' }
  > {
    try {
      const res = await this.gcpRequest(
        'GET',
        'cloudresourcemanager.googleapis.com',
        `/v1/projects/${gcpProjectId}`,
        accessToken,
      );
      const payload = JSON.parse(res.body) as {
        projectId?: string;
        name?: string;
        lifecycleState?: string;
      };
      return {
        ok: true,
        projectId: payload.projectId ?? gcpProjectId,
        name: typeof payload.name === 'string' ? payload.name : '',
        lifecycleState: payload.lifecycleState,
      };
    } catch (err) {
      if (err instanceof GcpHttpError && err.statusCode === 404) {
        return { ok: false, reason: 'not_found' };
      }
      if (err instanceof GcpHttpError && err.statusCode === 403) {
        return { ok: false, reason: 'inaccessible' };
      }
      throw err;
    }
  }

  private async listAccessibleGcpProjectSummaries(
    accessToken: string,
  ): Promise<Array<{ projectId: string; name: string }>> {
    const out: Array<{ projectId: string; name: string }> = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 50; page += 1) {
      const path =
        pageToken !== undefined
          ? `/v1/projects?pageToken=${encodeURIComponent(pageToken)}`
          : '/v1/projects';
      const res = await this.gcpRequest('GET', 'cloudresourcemanager.googleapis.com', path, accessToken);
      const parsed = JSON.parse(res.body) as {
        projects?: Array<{ projectId?: string; name?: string }>;
        nextPageToken?: string;
      };
      for (const p of parsed.projects ?? []) {
        if (p.projectId && typeof p.name === 'string') {
          out.push({ projectId: p.projectId, name: p.name });
        }
      }
      pageToken = parsed.nextPageToken;
      if (!pageToken) {
        break;
      }
    }
    return out;
  }

  private async findAccessibleGcpProjectsByDisplayName(
    accessToken: string,
    displayName: string,
  ): Promise<Array<{ projectId: string; name: string }>> {
    const all = await this.listAccessibleGcpProjectSummaries(accessToken);
    return all.filter((p) => p.name === displayName);
  }

  private async getGcpProject(
    accessToken: string,
    projectId: string,
  ): Promise<'found' | 'not_found' | 'inaccessible'> {
    const s = await this.fetchGcpProjectSummary(accessToken, projectId);
    if (s.ok) {
      return 'found';
    }
    return s.reason;
  }

  private async tryCreateGcpProject(
    accessToken: string,
    projectId: string,
    studioProjectId: string,
    throwOnConflict = false,
  ): Promise<'created' | 'already_exists' | 'conflict'> {
    const payload = JSON.stringify({
      projectId,
      name: `Studio ${studioProjectId}`,
    });

    try {
      await this.gcpRequest(
        'POST',
        'cloudresourcemanager.googleapis.com',
        '/v1/projects',
        accessToken,
        payload,
      );
      return 'created';
    } catch (err) {
      if (err instanceof GcpHttpError && err.statusCode === 409) {
        const lookupResult = await this.getGcpProject(accessToken, projectId);
        if (lookupResult === 'found') {
          return 'already_exists';
        }
        if (throwOnConflict) {
          throw new Error(
            `GCP project ID "${projectId}" is already taken by another account. ` +
              'Try again or use a more unique Studio project name.',
          );
        }
        return 'conflict';
      }
      if (err instanceof GcpHttpError && err.statusCode === 403) {
        throw new Error(
          `Permission denied while creating GCP project "${projectId}". ` +
            'Grant the signed-in Google user project creation permissions (Project Creator or equivalent), then retry.',
        );
      }
      throw err;
    }
  }

  private async waitForProjectActive(
    accessToken: string,
    projectId: string,
  ): Promise<void> {
    const maxAttempts = 20;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const response = await this.gcpRequest(
          'GET',
          'cloudresourcemanager.googleapis.com',
          `/v1/projects/${projectId}`,
          accessToken,
        );
        const payload = JSON.parse(response.body) as { lifecycleState?: string };
        if (payload.lifecycleState === 'ACTIVE') {
          return;
        }
      } catch (err) {
        if (err instanceof GcpHttpError && (err.statusCode === 403 || err.statusCode === 404)) {
          // 403/404 on a just-created project is expected while permissions propagate
        } else {
          throw err;
        }
      }
      await this.sleep(1500);
    }
    throw new Error(`Timed out waiting for GCP project "${projectId}" to become ACTIVE.`);
  }

  private async fetchTokenInfo(accessToken: string): Promise<TokenInfo> {
    const res = await this.gcpRequest(
      'GET',
      'www.googleapis.com',
      `/oauth2/v1/tokeninfo?access_token=${accessToken}`,
    );
    return JSON.parse(res.body) as TokenInfo;
  }

  async ensureProvisionerServiceAccount(accessToken: string, gcpProjectId: string): Promise<string> {
    const saId = GCP_PROVISIONER_SERVICE_ACCOUNT_ID;
    const saEmail = `${saId}@${gcpProjectId}.iam.gserviceaccount.com`;

    try {
      await this.gcpRequest(
        'GET',
        'iam.googleapis.com',
        `/v1/projects/${gcpProjectId}/serviceAccounts/${encodeURIComponent(saEmail)}`,
        accessToken,
      );
      return saEmail;
    } catch (err) {
      if (!(err instanceof GcpHttpError) || err.statusCode !== 404) {
        throw err;
      }
    }

    const createPayload = JSON.stringify({
      accountId: saId,
      serviceAccount: {
        displayName: 'Platform Provisioner',
        description: 'Auto-created by Studio for project-scoped infrastructure provisioning.',
      },
    });

    try {
      const res = await this.gcpRequest(
        'POST',
        'iam.googleapis.com',
        `/v1/projects/${gcpProjectId}/serviceAccounts`,
        accessToken,
        createPayload,
      );

      const created = JSON.parse(res.body) as { email?: string };
      if (!created.email) {
        throw new Error(`Failed to create provisioner service account: ${res.body}`);
      }

      return created.email;
    } catch (err) {
      if (err instanceof GcpHttpError && err.statusCode === 409) {
        // SA already exists (created by a previous partially-completed flow) — use it as-is.
        return saEmail;
      }
      throw err;
    }
  }

  async grantProvisionerProjectRoles(accessToken: string, gcpProjectId: string, saEmail: string): Promise<void> {
    const member = `serviceAccount:${saEmail}`;

    let currentPolicy: { bindings?: Array<{ role: string; members: string[] }>; etag?: string };
    try {
      const getRes = await this.gcpRequest(
        'POST',
        'cloudresourcemanager.googleapis.com',
        `/v1/projects/${gcpProjectId}:getIamPolicy`,
        accessToken,
        JSON.stringify({}),
      );
      currentPolicy = JSON.parse(getRes.body) as typeof currentPolicy;
    } catch (err) {
      if (err instanceof GcpHttpError && err.statusCode === 403) {
        throw new Error(
          `Permission denied while reading IAM policy for project "${gcpProjectId}". ` +
            'The signed-in user needs resourcemanager.projects.getIamPolicy permission (e.g. Project IAM Admin role).',
        );
      }
      throw err;
    }

    const bindings = currentPolicy.bindings ?? [];
    let policyChanged = false;

    for (const role of PROVISIONER_PROJECT_ROLES) {
      const existing = bindings.find((b) => b.role === role);
      if (existing) {
        if (!existing.members.includes(member)) {
          existing.members.push(member);
          policyChanged = true;
        }
      } else {
        bindings.push({ role, members: [member] });
        policyChanged = true;
      }
    }

    if (!policyChanged) {
      return;
    }

    const setPayload = JSON.stringify({
      policy: {
        bindings,
        etag: currentPolicy.etag,
      },
    });

    // GCP IAM can return 400 "does not exist" for a newly-created SA due to propagation delay.
    // Retry a few times with backoff before giving up.
    const MAX_IAM_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_IAM_ATTEMPTS; attempt++) {
      try {
        await this.gcpRequest(
          'POST',
          'cloudresourcemanager.googleapis.com',
          `/v1/projects/${gcpProjectId}:setIamPolicy`,
          accessToken,
          setPayload,
        );
        return;
      } catch (err) {
        if (err instanceof GcpHttpError && err.statusCode === 403) {
          throw new Error(
            `Permission denied while setting IAM policy for project "${gcpProjectId}". ` +
              'The signed-in user needs resourcemanager.projects.setIamPolicy permission (e.g. Project IAM Admin role).',
          );
        }
        const isSaPropagationError =
          err instanceof GcpHttpError &&
          err.statusCode === 400 &&
          err.message.includes('does not exist');
        if (isSaPropagationError && attempt < MAX_IAM_ATTEMPTS) {
          const waitMs = attempt * 3000;
          console.log(
            `[studio-gcp] SA not yet propagated for IAM binding (attempt ${attempt}/${MAX_IAM_ATTEMPTS}), waiting ${waitMs}ms…`,
          );
          await this.sleep(waitMs);
          continue;
        }
        throw err;
      }
    }
  }

  async createServiceAccountKey(accessToken: string, gcpProjectId: string, saEmail: string): Promise<string> {
    const res = await this.gcpRequest(
      'POST',
      'iam.googleapis.com',
      `/v1/projects/${gcpProjectId}/serviceAccounts/${encodeURIComponent(saEmail)}/keys`,
      accessToken,
      JSON.stringify({ privateKeyType: 'TYPE_GOOGLE_CREDENTIALS_FILE' }),
    );

    const keyResponse = JSON.parse(res.body) as ServiceAccountKeyResponse;
    if (!keyResponse.privateKeyData) {
      throw new Error(`Failed to create service account key: ${res.body}`);
    }

    return Buffer.from(keyResponse.privateKeyData, 'base64').toString('utf8');
  }

  private gcpRequest(
    method: string,
    hostname: string,
    path: string,
    accessToken?: string,
    body?: string,
  ): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {
        'User-Agent': 'platform-studio',
      };
      if (accessToken) {
        headers['Authorization'] = `Bearer ${accessToken}`;
      }
      if (body) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(body).toString();
      }

      const request = https.request(
        { method, hostname, path, headers },
        (response) => {
          let data = '';
          response.on('data', (chunk: Buffer) => {
            data += chunk.toString();
          });
          response.on('end', () => {
            const statusCode = response.statusCode ?? 0;
            if (statusCode < 200 || statusCode >= 300) {
              reject(
                new GcpHttpError(
                  `GCP API ${method} ${hostname}${path} failed (${statusCode}): ${data.slice(0, 500)}`,
                  statusCode,
                  data,
                ),
              );
              return;
            }
            resolve({ statusCode, body: data });
          });
        },
      );
      request.on('error', (error) => {
        reject(new Error(`GCP API request failed: ${error.message}`));
      });
      if (body) {
        request.write(body);
      }
      request.end();
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private oauthResultPage(success: boolean, message: string): string {
    const color = success ? '#22c55e' : '#ef4444';
    const icon = success ? '&#10003;' : '&#10007;';
    return `<!DOCTYPE html>
<html>
<head><title>Studio - GCP Authorization</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0a;color:#fafafa;">
  <div style="text-align:center;max-width:400px;padding:2rem;">
    <div style="font-size:3rem;color:${color};margin-bottom:1rem;">${icon}</div>
    <h1 style="font-size:1.25rem;font-weight:700;margin-bottom:0.5rem;">${success ? 'Connected' : 'Failed'}</h1>
    <p style="color:#a1a1aa;font-size:0.875rem;">${message}</p>
  </div>
</body>
</html>`;
  }
}
