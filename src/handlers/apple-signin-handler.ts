/**
 * Apple Sign-In Handler
 *
 * Handles:
 *   - Configuring Apple Sign-In as a Firebase Auth OIDC provider
 *   - Validating and storing Apple .p8 keys (for both APNs and Sign In with Apple)
 *   - Uploading APNs keys to Firebase Cloud Messaging
 */

import { validateAppleP8Key } from '../validators/apple-key-validator.js';
import { configureAppleSignInProvider } from '../core/gcp/gcp-api-client.js';
import type { CredentialStore } from '../services/credential-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppleSignInConfigureInput {
  project_id: string;
  gcp_project_id: string;
  team_id: string;
  key_id: string;
  service_id: string;
  access_token: string;
}

export interface AppleKeyUploadInput {
  project_id: string;
  p8_file_buffer: Buffer;
  key_id: string;
  team_id: string;
  key_purpose: 'apns' | 'sign_in';
}

export interface AppleKeyUploadResult {
  credential_id: string;
  key_id: string;
  team_id: string;
  key_purpose: string;
  credential_hash: string;
}

// ---------------------------------------------------------------------------
// Handler: upload and validate Apple .p8 key
// ---------------------------------------------------------------------------

/**
 * Validates an Apple .p8 key, checks for duplicates, and stores it encrypted
 * in the credential store.
 *
 * Returns the stored credential record ID and hash.
 * Throws CredentialError if the key is invalid or already uploaded.
 */
export async function handleAppleKeyUpload(
  input: AppleKeyUploadInput,
  credentialStore: CredentialStore,
): Promise<AppleKeyUploadResult> {
  const validation = validateAppleP8Key(input.p8_file_buffer);

  const credentialData = {
    pem: validation.pem,
    key_id: input.key_id,
    team_id: input.team_id,
    key_purpose: input.key_purpose,
  };

  if (
    credentialStore.isDuplicateCredential(
      input.project_id,
      input.key_purpose === 'apns' ? 'apns_key' : 'apple_sign_in',
      credentialData,
    )
  ) {
    throw new Error(
      'This Apple key has already been uploaded. ' +
        'If you need to replace it, revoke the existing key in Apple Developer Portal and create a new one.',
    );
  }

  const stored = credentialStore.storeProviderCredential({
    project_id: input.project_id,
    provider_type: input.key_purpose === 'apns' ? 'apns_key' : 'apple_sign_in',
    credential_data: credentialData,
  });

  return {
    credential_id: stored.id,
    key_id: input.key_id,
    team_id: input.team_id,
    key_purpose: input.key_purpose,
    credential_hash: stored.credential_hash,
  };
}

// ---------------------------------------------------------------------------
// Handler: configure Apple Sign-In in Firebase
// ---------------------------------------------------------------------------

/**
 * Configures Apple as an OIDC provider in Firebase Identity Toolkit.
 * Requires a valid Apple Service ID, Team ID, and Key ID.
 */
export async function configureAppleSignIn(
  input: AppleSignInConfigureInput,
  credentialStore: CredentialStore,
): Promise<{ success: boolean; message: string }> {
  if (!input.team_id || !/^[A-Z0-9]{10}$/.test(input.team_id)) {
    throw new Error(
      `Invalid Apple Team ID: "${input.team_id}". ` +
        'Team ID must be 10 uppercase alphanumeric characters (found in Apple Developer account settings).',
    );
  }

  if (!input.key_id || !/^[A-Z0-9]{10}$/.test(input.key_id)) {
    throw new Error(
      `Invalid Apple Key ID: "${input.key_id}". ` +
        'Key ID must be 10 uppercase alphanumeric characters (found in Apple Developer Portal → Keys).',
    );
  }

  if (!input.service_id || input.service_id.trim().length === 0) {
    throw new Error(
      'Apple Service ID is required for Sign In with Apple. ' +
        'Create a Services ID in Apple Developer Portal → Certificates, Identifiers & Profiles → Identifiers → Services IDs.',
    );
  }

  await configureAppleSignInProvider(
    input.access_token,
    input.gcp_project_id,
    input.team_id,
    input.key_id,
    input.service_id,
  );

  credentialStore.storeProviderCredential({
    project_id: input.project_id,
    provider_type: 'apple_sign_in',
    credential_data: {
      team_id: input.team_id,
      key_id: input.key_id,
      service_id: input.service_id,
      configured_at: Date.now(),
    },
  });

  return {
    success: true,
    message: `Apple Sign-In configured successfully for Firebase project "${input.gcp_project_id}".`,
  };
}
