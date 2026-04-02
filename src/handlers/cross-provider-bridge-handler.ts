/**
 * Cross-Provider Bridge Handler
 *
 * Bridges credentials from one provider into Firebase configuration:
 *   - APNs key (Apple) → Firebase Cloud Messaging (iOS push notifications)
 *   - Play signing fingerprint (Google Play) → Firebase Android app SHA-1
 *
 * Both operations retrieve encrypted credentials from CredentialStore,
 * decrypt them on-demand, and call the respective Firebase APIs.
 */

import { uploadApnsKeyToFirebase, addSha1FingerprintToFirebase } from '../core/gcp/gcp-api-client.js';
import { validatePlayFingerprint } from '../validators/play-fingerprint-validator.js';
import type { CredentialStore } from '../services/credential-store.js';

// ---------------------------------------------------------------------------
// APNs → Firebase bridge
// ---------------------------------------------------------------------------

export interface BridgeApnsResult {
  success: boolean;
  key_id: string;
  team_id: string;
  message: string;
}

/**
 * Retrieves an encrypted APNs key from CredentialStore and uploads it to
 * Firebase Cloud Messaging to enable iOS push notifications.
 */
export async function bridgeApnsKeyToFirebase(
  projectId: string,
  gcpProjectId: string,
  accessToken: string,
  credentialStore: CredentialStore,
): Promise<BridgeApnsResult> {
  const credential = credentialStore.getProviderCredentialByType(projectId, 'apns_key');
  if (!credential) {
    throw new Error(
      'No APNs key found for this project. ' +
        'Upload an APNs key first via POST /integrations/firebase/apple/upload-key.',
    );
  }

  const data = credentialStore.decryptProviderCredential(credential.id);
  if (!data) {
    throw new Error('Failed to decrypt APNs key. The credential may be corrupted.');
  }

  const pem = data['pem'] as string;
  const keyId = data['key_id'] as string;
  const teamId = data['team_id'] as string;

  if (!pem || !keyId || !teamId) {
    throw new Error('APNs key credential is incomplete. Re-upload the .p8 key file.');
  }

  await uploadApnsKeyToFirebase(accessToken, gcpProjectId, pem, keyId, teamId);

  credentialStore.updateFirebaseAuthConfig(projectId, { apns_configured: true });

  return {
    success: true,
    key_id: keyId,
    team_id: teamId,
    message: `APNs key successfully bridged to Firebase project "${gcpProjectId}".`,
  };
}

// ---------------------------------------------------------------------------
// Play fingerprint → Firebase bridge
// ---------------------------------------------------------------------------

export interface BridgeFingerprintResult {
  success: boolean;
  normalized_fingerprint: string;
  message: string;
}

/**
 * Validates a Google Play signing fingerprint and adds it to the Firebase
 * Android app's allowed SHA-1 certificate hashes.
 */
export async function bridgePlayFingerprintToFirebase(
  projectId: string,
  gcpProjectId: string,
  androidAppId: string,
  fingerprintRaw: string,
  accessToken: string,
  credentialStore: CredentialStore,
): Promise<BridgeFingerprintResult> {
  const { normalized, raw_hex } = validatePlayFingerprint(fingerprintRaw);

  await addSha1FingerprintToFirebase(accessToken, gcpProjectId, androidAppId, raw_hex);

  credentialStore.storeProviderCredential({
    project_id: projectId,
    provider_type: 'play_fingerprint',
    credential_data: {
      fingerprint: normalized,
      raw_hex,
      android_app_id: androidAppId,
      gcp_project_id: gcpProjectId,
      added_at: Date.now(),
    },
  });

  credentialStore.updateFirebaseAuthConfig(projectId, { play_fingerprint_configured: true });

  return {
    success: true,
    normalized_fingerprint: normalized,
    message: `Google Play SHA-1 fingerprint "${normalized}" added to Firebase Android app "${androidAppId}".`,
  };
}
