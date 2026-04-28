/**
 * TypeScript models for Firebase Auth, OAuth clients, and provider credentials.
 *
 * Storage: SQLite via CredentialStore (src/services/credential-store.ts).
 * Sensitive fields are always stored encrypted; plaintext never persisted.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export type OAuthProvider = 'google' | 'apple' | 'github';

export type ProviderCredentialType =
  | 'apns_key'
  | 'play_fingerprint'
  | 'oauth_client'
  | 'apple_sign_in'
  | 'firebase_auth_config';

// ---------------------------------------------------------------------------
// Firebase Auth Config
// ---------------------------------------------------------------------------

export interface FirebaseAuthConfig {
  id: string;
  project_id: string;
  identity_toolkit_enabled: boolean;
  /** JSONB-serialised Identity Toolkit settings stored encrypted */
  encrypted_config: string | null;
  apns_configured: boolean;
  play_fingerprint_configured: boolean;
  created_at: number;
  updated_at: number;
}

export interface FirebaseAuthConfigCreate {
  project_id: string;
  identity_toolkit_enabled?: boolean;
}

export interface FirebaseAuthConfigUpdate {
  identity_toolkit_enabled?: boolean;
  encrypted_config?: string;
  apns_configured?: boolean;
  play_fingerprint_configured?: boolean;
}

// ---------------------------------------------------------------------------
// OAuth Client
// ---------------------------------------------------------------------------

export interface OAuthClient {
  id: string;
  firebase_config_id: string;
  provider: OAuthProvider;
  client_id: string;
  /** Stored encrypted; never returned in plaintext from API */
  encrypted_client_secret: string;
  redirect_uris: string[];
  created_at: number;
  updated_at: number;
}

export interface OAuthClientCreate {
  firebase_config_id: string;
  provider: OAuthProvider;
  client_id: string;
  client_secret: string;
  redirect_uris: string[];
}

/** Safe view — no secret */
export interface OAuthClientPublic {
  id: string;
  firebase_config_id: string;
  provider: OAuthProvider;
  client_id: string;
  masked_client_secret: string;
  redirect_uris: string[];
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Provider Credential
// ---------------------------------------------------------------------------

export interface ProviderCredential {
  id: string;
  project_id: string;
  provider_type: ProviderCredentialType;
  /** AES-256-GCM encrypted JSON blob of credential data */
  encrypted_credential_data: string;
  /** SHA-256 hex of plaintext for duplicate detection without decryption */
  credential_hash: string;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ProviderCredentialCreate {
  project_id: string;
  provider_type: ProviderCredentialType;
  credential_data: Record<string, unknown>;
  expires_at?: number;
}

// ---------------------------------------------------------------------------
// OAuth Session State
// ---------------------------------------------------------------------------

export interface OAuthSessionState {
  id: string;
  project_id: string;
  provider: OAuthProvider;
  state_token: string;
  redirect_uri: string;
  expires_at: number;
  completed: boolean;
  access_token: string | null;
  created_at: number;
}
