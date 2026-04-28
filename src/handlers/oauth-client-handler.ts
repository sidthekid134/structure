/**
 * OAuth Client Handler — creates and manages OAuth2 client configurations
 * in Firebase Identity Toolkit (OAuth IdP configs).
 *
 * This covers:
 *   - Creating / updating OAuth clients for Google and Apple providers
 *   - Validating redirect URIs (must be HTTPS or localhost)
 *   - Storing encrypted client credentials via CredentialStore
 */

import { GcpHttpError } from '../core/gcp/gcp-api-client.js';
import { configureFirebaseOAuthProvider } from '../core/gcp/gcp-api-client.js';
import type { CredentialStore } from '../services/credential-store.js';
import type { OAuthClientPublic, OAuthProvider } from '../models/firebase-auth-config.js';

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Validates that every URI in the list is HTTPS or a localhost URL.
 * Throws an error listing invalid URIs.
 */
export function validateRedirectUris(uris: string[]): void {
  const invalid: string[] = [];
  for (const uri of uris) {
    try {
      const url = new URL(uri);
      const isHttps = url.protocol === 'https:';
      const isLocalhost =
        url.protocol === 'http:' &&
        (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
      if (!isHttps && !isLocalhost) invalid.push(uri);
    } catch {
      invalid.push(uri);
    }
  }
  if (invalid.length > 0) {
    throw new GcpHttpError(
      `Redirect URIs must be HTTPS or localhost. Invalid URIs: ${invalid.join(', ')}`,
      400,
      '',
    );
  }
}

/**
 * Validates a client secret is non-trivially long and non-empty.
 */
export function validateClientSecret(secret: string): void {
  if (!secret || secret.length < 20) {
    throw new GcpHttpError(
      'client_secret must be at least 20 characters long.',
      400,
      '',
    );
  }
}

/**
 * Validates a client_id matches GCP's typical format.
 * GCP OAuth2 client IDs end with .apps.googleusercontent.com for Google,
 * or are service IDs for Apple.
 */
export function validateClientId(clientId: string, provider: OAuthProvider): void {
  if (!clientId || clientId.trim().length === 0) {
    throw new GcpHttpError('client_id must not be empty.', 400, '');
  }
  if (provider === 'google' && !clientId.endsWith('.apps.googleusercontent.com')) {
    throw new GcpHttpError(
      'Google OAuth client_id must end with .apps.googleusercontent.com',
      400,
      '',
    );
  }
  if (provider === 'apple' && !/^[A-Za-z0-9.-]+\.[A-Za-z0-9.-]+$/.test(clientId)) {
    throw new GcpHttpError(
      'Apple Service ID must look like a reverse-domain identifier (for example: com.example.signin).',
      400,
      '',
    );
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export interface CreateOAuthClientInput {
  firebase_config_id: string;
  provider: OAuthProvider;
  client_id: string;
  client_secret: string;
  redirect_uris: string[];
  gcp_project_id: string;
  access_token: string;
}

/**
 * Creates an OAuth client entry:
 *   1. Validates redirect URIs and credential format.
 *   2. Configures the provider in Firebase Auth via Identity Toolkit API.
 *   3. Stores encrypted credentials in CredentialStore.
 *   4. Returns the public (masked) client record.
 */
export async function createOAuthClientHandler(
  input: CreateOAuthClientInput,
  credentialStore: CredentialStore,
): Promise<OAuthClientPublic> {
  validateRedirectUris(input.redirect_uris);
  validateClientSecret(input.client_secret);
  validateClientId(input.client_id, input.provider);

  const gcpProvider = input.provider === 'google' ? 'google.com' : 'apple.com';
  await configureFirebaseOAuthProvider(
    input.access_token,
    input.gcp_project_id,
    gcpProvider,
    input.client_id,
    input.client_secret,
  );

  const record = credentialStore.createOAuthClient({
    firebase_config_id: input.firebase_config_id,
    provider: input.provider,
    client_id: input.client_id,
    client_secret: input.client_secret,
    redirect_uris: input.redirect_uris,
  });

  return record;
}

/**
 * Lists all OAuth clients for a Firebase config (masked secrets).
 */
export function listOAuthClients(
  firebaseConfigId: string,
  credentialStore: CredentialStore,
): OAuthClientPublic[] {
  return credentialStore.listOAuthClients(firebaseConfigId);
}
