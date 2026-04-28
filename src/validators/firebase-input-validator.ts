/**
 * Firebase / OAuth input validators.
 *
 * All functions throw CredentialError with a specific validation failure reason.
 * Callers are expected to catch and return 400 responses.
 */

import { CredentialError } from '../types.js';

// ---------------------------------------------------------------------------
// Project ID
// ---------------------------------------------------------------------------

/**
 * Validates a GCP project ID.
 * Rules: 6–30 chars, lowercase letters, digits, hyphens; must start with a letter.
 */
export function validateProjectId(projectId: string): void {
  if (!projectId || typeof projectId !== 'string') {
    throw new CredentialError('project_id must not be empty.', 'validateProjectId');
  }
  const clean = projectId.trim();
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(clean)) {
    throw new CredentialError(
      `Invalid project_id "${clean}". ` +
        'Project IDs must be 6–30 characters, start with a lowercase letter, ' +
        'and contain only lowercase letters, digits, and hyphens.',
      'validateProjectId',
    );
  }
}

// ---------------------------------------------------------------------------
// Redirect URI
// ---------------------------------------------------------------------------

/**
 * Validates a single redirect URI — must be HTTPS or http://localhost.
 */
export function validateRedirectUri(uri: string): void {
  if (!uri || typeof uri !== 'string') {
    throw new CredentialError('Redirect URI must not be empty.', 'validateRedirectUri');
  }
  try {
    const url = new URL(uri);
    const isHttps = url.protocol === 'https:';
    const isLocalhost =
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
    if (!isHttps && !isLocalhost) {
      throw new CredentialError(
        `Redirect URI "${uri}" must use HTTPS or be a localhost URL (http://localhost/...).`,
        'validateRedirectUri',
      );
    }
  } catch (err) {
    if (err instanceof CredentialError) throw err;
    throw new CredentialError(
      `Redirect URI "${uri}" is not a valid URL.`,
      'validateRedirectUri',
    );
  }
}

// ---------------------------------------------------------------------------
// Client secret
// ---------------------------------------------------------------------------

/**
 * Validates an OAuth client secret — must be at least 20 characters.
 */
export function validateClientSecret(secret: string): void {
  if (!secret || typeof secret !== 'string') {
    throw new CredentialError('client_secret must not be empty.', 'validateClientSecret');
  }
  if (secret.length < 20) {
    throw new CredentialError(
      `client_secret is too short (${secret.length} chars). ` +
        'OAuth client secrets from Google Cloud are typically longer than 20 characters.',
      'validateClientSecret',
    );
  }
}

// ---------------------------------------------------------------------------
// Apple Team ID
// ---------------------------------------------------------------------------

/**
 * Validates an Apple Team ID — must be exactly 10 uppercase alphanumeric characters.
 */
export function validateTeamId(teamId: string): void {
  if (!teamId || typeof teamId !== 'string') {
    throw new CredentialError('team_id must not be empty.', 'validateTeamId');
  }
  if (!/^[A-Z0-9]{10}$/.test(teamId.trim())) {
    throw new CredentialError(
      `Invalid team_id "${teamId}". ` +
        'Apple Team IDs are exactly 10 uppercase alphanumeric characters (e.g. ABCD123456). ' +
        'Find your Team ID at: https://developer.apple.com/account → Membership.',
      'validateTeamId',
    );
  }
}

// ---------------------------------------------------------------------------
// Apple Key ID
// ---------------------------------------------------------------------------

/**
 * Validates an Apple Key ID — must be exactly 10 uppercase alphanumeric characters.
 */
export function validateKeyId(keyId: string): void {
  if (!keyId || typeof keyId !== 'string') {
    throw new CredentialError('key_id must not be empty.', 'validateKeyId');
  }
  if (!/^[A-Z0-9]{10}$/.test(keyId.trim())) {
    throw new CredentialError(
      `Invalid key_id "${keyId}". ` +
        'Apple Key IDs are exactly 10 uppercase alphanumeric characters (e.g. ABCD123456). ' +
        'Find your Key ID at: Apple Developer Portal → Certificates, Identifiers & Profiles → Keys.',
      'validateKeyId',
    );
  }
}

// ---------------------------------------------------------------------------
// OAuth Provider
// ---------------------------------------------------------------------------

/**
 * Validates that the provider is one of the supported OAuth providers.
 */
export function validateOAuthProvider(provider: string): asserts provider is 'google' | 'apple' {
  if (provider !== 'google' && provider !== 'apple') {
    throw new CredentialError(
      `Invalid OAuth provider "${provider}". Must be "google" or "apple".`,
      'validateOAuthProvider',
    );
  }
}

// ---------------------------------------------------------------------------
// GCP OAuth Client ID
// ---------------------------------------------------------------------------

/**
 * Validates a Google Cloud OAuth2 client ID.
 * Google OAuth client IDs end with .apps.googleusercontent.com.
 */
export function validateGoogleClientId(clientId: string): void {
  if (!clientId || typeof clientId !== 'string') {
    throw new CredentialError('client_id must not be empty.', 'validateGoogleClientId');
  }
  if (!clientId.endsWith('.apps.googleusercontent.com')) {
    throw new CredentialError(
      `Invalid Google client_id "${clientId}". ` +
        'Google OAuth client IDs must end with .apps.googleusercontent.com. ' +
        'Find your client ID in Google Cloud Console → APIs & Services → Credentials.',
      'validateGoogleClientId',
    );
  }
}
