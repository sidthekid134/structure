/**
 * GCP / Google Cloud OAuth provider.
 *
 * Implements OAuthProvider for the `google-auth-library` loopback flow using PKCE
 * (RFC 7636).
 *
 * Requires PLATFORM_GCP_OAUTH_CLIENT_ID and PLATFORM_GCP_OAUTH_CLIENT_SECRET env vars
 * (set at build time for binaries; see BUILDING.md). Alternatively, callers can pass
 * a clientId + clientSecret directly to the constructor.
 */

import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library';
import type { CredentialService } from '../../services/credential-service.js';
import type { OAuthProvider, OAuthTokens, TokenValidation, AuthUrlResult } from '../oauth-manager.js';
import { fetchGoogleTokenInfo } from './gcp-api-client.js';
import { createOperationLogger } from '../../logger.js';
import { BUNDLED_GCP_CLIENT_ID, BUNDLED_GCP_CLIENT_SECRET } from './gcp-oauth-credentials.js';

const log = createOperationLogger('gcp-oauth');

export const GCP_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
];

export class GcpOAuthProvider implements OAuthProvider {
  readonly id = 'gcp';
  readonly requiredScopes = GCP_OAUTH_SCOPES;

  private readonly clientId: string;
  private readonly clientSecret: string;

  constructor(clientId?: string, clientSecret?: string) {
    this.clientId = clientId?.trim() || BUNDLED_GCP_CLIENT_ID;
    this.clientSecret = clientSecret?.trim() || BUNDLED_GCP_CLIENT_SECRET;
  }

  async buildAuthUrl(redirectUri: string, state: string): Promise<AuthUrlResult> {
    const client = new OAuth2Client({ clientId: this.clientId, redirectUri });
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const authUrl = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'select_account consent',
      scope: this.requiredScopes,
      state,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
    });
    const u = new URL(authUrl);
    log.debug('auth URL built', {
      hasCodeChallenge: u.searchParams.has('code_challenge'),
      hasRedirectUri: u.searchParams.has('redirect_uri'),
      codeChallengeMethod: u.searchParams.get('code_challenge_method'),
      redirectUri: u.searchParams.get('redirect_uri'),
    });
    return { authUrl, codeVerifier };
  }

  async exchangeCode(code: string, redirectUri: string, codeVerifier?: string): Promise<OAuthTokens> {
    if (!codeVerifier) throw new Error('PKCE code verifier is required for GCP OAuth.');
    log.debug('exchanging authorization code', { codeLen: code.length, verifierLen: codeVerifier.length, redirectUri });
    const client = new OAuth2Client({ clientId: this.clientId, clientSecret: this.clientSecret, redirectUri });
    try {
      const { tokens } = await client.getToken({ code, codeVerifier });
      if (!tokens.access_token) throw new Error('OAuth token exchange did not return an access token.');
      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? undefined,
      };
    } catch (err) {
      const data = (err as any)?.response?.data;
      log.error('token exchange failed', { errorCode: data?.error, errorDescription: data?.error_description, message: (err as Error).message });
      throw err;
    }
  }

  async validateToken(accessToken: string): Promise<TokenValidation> {
    const info = await fetchGoogleTokenInfo(accessToken);
    const scopes = info.scope ?? '';
    const valid = scopes.includes('cloud-platform');
    log.info('token validated', { valid, hasEmail: Boolean(info.email) });
    return { valid, email: info.email, scopes };
  }

  storeRefreshToken(credentialService: CredentialService, projectId: string, refreshToken: string): void {
    credentialService.storeCredential({ project_id: projectId, credential_type: 'gcp_oauth_refresh_token', value: refreshToken });
  }

  getStoredRefreshToken(credentialService: CredentialService, projectId: string): string | null {
    return credentialService.retrieveCredential(projectId, 'gcp_oauth_refresh_token') ?? null;
  }

  async getAccessToken(credentialService: CredentialService, projectId: string): Promise<string | null> {
    const refresh = this.getStoredRefreshToken(credentialService, projectId);
    if (!refresh) return null;
    try {
      const client = new OAuth2Client({ clientId: this.clientId, clientSecret: this.clientSecret });
      client.setCredentials({ refresh_token: refresh });
      const { token } = await client.getAccessToken();
      return token ?? null;
    } catch (err) {
      log.warn('getAccessToken failed', { error: (err as Error).message });
      return null;
    }
  }

  revokeStoredTokens(credentialService: CredentialService, projectId: string): void {
    credentialService.deleteCredentialByType(projectId, 'gcp_oauth_refresh_token');
  }

  /** Store the email of the Google account that completed OAuth (used for display). */
  storeConnectedEmail(credentialService: CredentialService, projectId: string, email: string): void {
    credentialService.storeCredential({ project_id: projectId, credential_type: 'gcp_connected_by_email', value: email });
  }

  /** Read the stored Google account email. */
  getConnectedEmail(credentialService: CredentialService, projectId: string): string {
    return credentialService.retrieveCredential(projectId, 'gcp_connected_by_email') ?? 'unknown';
  }

  isConfigured(): boolean {
    return Boolean(this.clientId.trim()) && Boolean(this.clientSecret.trim());
  }
}
