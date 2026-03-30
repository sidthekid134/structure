/**
 * GCP / Google Cloud OAuth provider.
 *
 * Implements OAuthProvider for the `google-auth-library` loopback flow.
 * Vault keys stay backward-compatible with the original gcp-connection.ts format.
 */

import { OAuth2Client } from 'google-auth-library';
import type { VaultManager } from '../../vault.js';
import type { OAuthProvider, OAuthTokens, TokenValidation } from '../oauth-manager.js';
import { fetchGoogleTokenInfo } from './gcp-api-client.js';

export const GCP_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
];

/** Vault key suffix for the GCP OAuth refresh token (namespace: 'firebase'). */
const REFRESH_TOKEN_KEY_SUFFIX = 'gcp_oauth_refresh_token';
const EMAIL_KEY_SUFFIX = 'connected_by_email';

export class GcpOAuthProvider implements OAuthProvider {
  readonly id = 'gcp';
  readonly requiredScopes = GCP_OAUTH_SCOPES;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  buildAuthUrl(redirectUri: string, state: string): string {
    const client = new OAuth2Client({ clientId: this.clientId, clientSecret: this.clientSecret, redirectUri });
    return client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'select_account consent',
      scope: this.requiredScopes,
      state,
    });
  }

  async exchangeCode(code: string, redirectUri: string): Promise<OAuthTokens> {
    const client = new OAuth2Client({ clientId: this.clientId, clientSecret: this.clientSecret, redirectUri });
    const { tokens } = await client.getToken(code);
    if (!tokens.access_token) throw new Error('OAuth token exchange did not return an access token.');
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? undefined,
    };
  }

  async validateToken(accessToken: string): Promise<TokenValidation> {
    const info = await fetchGoogleTokenInfo(accessToken);
    const scopes = info.scope ?? '';
    const valid = scopes.includes('cloud-platform');
    if (info.email) {
      console.log(`[gcp-oauth] Signed in as: ${info.email}`);
    }
    return { valid, email: info.email, scopes };
  }

  storeRefreshToken(vaultManager: VaultManager, passphrase: string, projectId: string, refreshToken: string): void {
    vaultManager.setCredential(passphrase, 'firebase', this.vaultKey(projectId, REFRESH_TOKEN_KEY_SUFFIX), refreshToken);
  }

  getStoredRefreshToken(vaultManager: VaultManager, passphrase: string, projectId: string): string | null {
    const t = vaultManager.getCredential(passphrase, 'firebase', this.vaultKey(projectId, REFRESH_TOKEN_KEY_SUFFIX));
    return t?.trim() || null;
  }

  async getAccessToken(vaultManager: VaultManager, passphrase: string, projectId: string): Promise<string | null> {
    const refresh = this.getStoredRefreshToken(vaultManager, passphrase, projectId);
    if (!refresh) return null;
    try {
      const client = new OAuth2Client({ clientId: this.clientId, clientSecret: this.clientSecret });
      client.setCredentials({ refresh_token: refresh });
      const { token } = await client.getAccessToken();
      return token ?? null;
    } catch {
      return null;
    }
  }

  revokeStoredTokens(vaultManager: VaultManager, passphrase: string, projectId: string): void {
    vaultManager.deleteCredential(passphrase, 'firebase', this.vaultKey(projectId, REFRESH_TOKEN_KEY_SUFFIX));
  }

  /** Store the email of the Google account that completed OAuth (used for display). */
  storeConnectedEmail(vaultManager: VaultManager, passphrase: string, projectId: string, email: string): void {
    vaultManager.setCredential(passphrase, 'firebase', this.vaultKey(projectId, EMAIL_KEY_SUFFIX), email);
  }

  /** Read the stored Google account email. */
  getConnectedEmail(vaultManager: VaultManager, passphrase: string, projectId: string): string {
    return vaultManager.getCredential(passphrase, 'firebase', this.vaultKey(projectId, EMAIL_KEY_SUFFIX)) ?? 'unknown';
  }

  isConfigured(): boolean {
    return Boolean(this.clientId.trim()) && Boolean(this.clientSecret.trim());
  }

  private vaultKey(projectId: string, suffix: string): string {
    return `${projectId}/${suffix}`;
  }
}
