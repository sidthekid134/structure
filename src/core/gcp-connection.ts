import * as http from 'http';
import * as https from 'https';
import * as url from 'url';
import * as crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { VaultManager } from '../vault.js';
import {
  ProjectManager,
  IntegrationConfigRecord,
} from '../studio/project-manager.js';

export type GcpStepStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface GcpOAuthStep {
  id: 'oauth_consent' | 'gcp_project' | 'service_account' | 'iam_binding' | 'vault';
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

export interface GcpOAuthSessionStatus {
  sessionId: string;
  projectId: string;
  phase: 'awaiting_user' | 'processing' | 'completed' | 'failed' | 'expired';
  steps: GcpOAuthStep[];
  connected: boolean;
  details?: GcpConnectionDetails;
  error?: string;
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

export class GcpConnectionService {
  private readonly sessions = new Map<string, InternalSession>();

  constructor(
    private readonly vaultManager: VaultManager,
    private readonly projectManager: ProjectManager,
    private readonly oauthClientId: string,
    private readonly oauthClientSecret: string,
  ) {}

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
        {
          id: 'gcp_project',
          label: 'Create or resolve GCP project',
          status: 'pending',
        },
        {
          id: 'service_account',
          label: 'Create platform-provisioner service account',
          status: 'pending',
        },
        {
          id: 'iam_binding',
          label: 'Grant provisioner project-level roles',
          status: 'pending',
        },
        {
          id: 'vault',
          label: 'Generate key and save credentials',
          status: 'pending',
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

    if (!details) {
      return { connected: false };
    }

    const integration = this.projectManager.getProject(projectId).integrations.firebase;
    return {
      connected: true,
      details,
      integration,
    };
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

  private async runSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    try {
      const code = await session.codePromise;

      this.markStep(session, 'oauth_consent', 'completed');
      session.status.phase = 'processing';

      const { tokens } = await session.client.getToken(code);
      if (!tokens.access_token) {
        throw new Error('OAuth token exchange did not return an access token.');
      }
      session.client.setCredentials(tokens);

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

      this.markStep(session, 'gcp_project', 'in_progress');
      const gcpProjectId = await this.ensureProjectForStudioProject(
        tokens.access_token,
        session.projectId,
      );
      this.markStep(session, 'gcp_project', 'completed', gcpProjectId);

      this.markStep(session, 'service_account', 'in_progress');
      const saEmail = await this.ensureProvisionerServiceAccount(tokens.access_token, gcpProjectId);
      this.markStep(session, 'service_account', 'completed', saEmail);

      this.markStep(session, 'iam_binding', 'in_progress');
      await this.grantProvisionerProjectRoles(tokens.access_token, gcpProjectId, saEmail);
      this.markStep(session, 'iam_binding', 'completed');

      this.markStep(session, 'vault', 'in_progress');
      const saKeyJson = await this.createServiceAccountKey(tokens.access_token, gcpProjectId, saEmail);
      const details: GcpConnectionDetails = {
        projectId: gcpProjectId,
        serviceAccountEmail: saEmail,
        userEmail,
        connectedAt: new Date().toISOString(),
      };
      this.storeServiceAccountKey(session.projectId, saKeyJson);
      this.storeConnectionDetails(session.projectId, details);
      this.syncProjectIntegration(session.projectId, details);
      this.markStep(session, 'vault', 'completed');

      session.status.phase = 'completed';
      session.status.connected = true;
      session.status.details = details;
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

  private async ensureProjectForStudioProject(
    accessToken: string,
    studioProjectId: string,
  ): Promise<string> {
    const existing = this.getStoredConnectionDetails(studioProjectId);
    const gcpProjectId = existing?.projectId ?? this.generateGcpProjectId(studioProjectId);

    if (existing?.projectId) {
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
      return gcpProjectId;
    }

    console.log(
      `[studio-gcp] Project ID "${gcpProjectId}" is taken (${createResult}), retrying with random suffix.`,
    );
    const retryId = this.generateGcpProjectIdWithEntropy(studioProjectId);
    await this.tryCreateGcpProject(accessToken, retryId, studioProjectId, true);
    await this.waitForProjectActive(accessToken, retryId);
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

  private async getGcpProject(
    accessToken: string,
    projectId: string,
  ): Promise<'found' | 'not_found' | 'inaccessible'> {
    try {
      await this.gcpRequest(
        'GET',
        'cloudresourcemanager.googleapis.com',
        `/v1/projects/${projectId}`,
        accessToken,
      );
      return 'found';
    } catch (err) {
      if (err instanceof GcpHttpError && err.statusCode === 404) {
        return 'not_found';
      }
      if (err instanceof GcpHttpError && err.statusCode === 403) {
        return 'inaccessible';
      }
      throw err;
    }
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

  private async ensureProvisionerServiceAccount(
    accessToken: string,
    gcpProjectId: string,
  ): Promise<string> {
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
  }

  private async grantProvisionerProjectRoles(
    accessToken: string,
    gcpProjectId: string,
    saEmail: string,
  ): Promise<void> {
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

    try {
      await this.gcpRequest(
        'POST',
        'cloudresourcemanager.googleapis.com',
        `/v1/projects/${gcpProjectId}:setIamPolicy`,
        accessToken,
        setPayload,
      );
    } catch (err) {
      if (err instanceof GcpHttpError && err.statusCode === 403) {
        throw new Error(
          `Permission denied while setting IAM policy for project "${gcpProjectId}". ` +
            'The signed-in user needs resourcemanager.projects.setIamPolicy permission (e.g. Project IAM Admin role).',
        );
      }
      throw err;
    }
  }

  private async createServiceAccountKey(
    accessToken: string,
    gcpProjectId: string,
    saEmail: string,
  ): Promise<string> {
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
