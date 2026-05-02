/**
 * GCP credential storage helpers.
 *
 * All vault reads/writes for GCP connection details, service account JSON,
 * and connection metadata live here. Uses 'firebase' as the vault provider
 * namespace to stay backward-compatible with existing encrypted stores.
 */

import type { VaultManager } from '../../vault.js';
import type { ProjectManager, IntegrationConfigRecord } from '../../studio/project-manager.js';
import { GCP_PROVISIONER_SA_ID, provisionerSaEmail } from './gcp-api-client.js';

// ---------------------------------------------------------------------------
// Connection types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Vault key helpers
// ---------------------------------------------------------------------------

function vaultKeyPath(projectId: string, key: string): string {
  return `${projectId}/${key}`;
}

// ---------------------------------------------------------------------------
// GCP project ID naming
// ---------------------------------------------------------------------------

import * as crypto from 'crypto';

export function buildStudioGcpProjectId(studioProjectId: string): string {
  const base = studioProjectId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  const hash = crypto.createHash('sha1').update(studioProjectId).digest('hex').slice(0, 6);
  const maxBaseLength = 30 - 'st--'.length - hash.length;
  const trimmedBase = (base || 'project').slice(0, maxBaseLength).replace(/-+$/g, '');
  return `st-${trimmedBase}-${hash}`;
}

export function buildGcpProjectIdWithEntropy(studioProjectId: string): string {
  const base =
    studioProjectId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  const entropy = crypto.randomBytes(4).toString('hex');
  const maxBaseLength = 30 - 'st--'.length - entropy.length;
  return `st-${base.slice(0, maxBaseLength).replace(/-+$/g, '')}-${entropy}`;
}

// ---------------------------------------------------------------------------
// Credential reads and writes
// ---------------------------------------------------------------------------

export function getStoredGcpProjectId(
  vaultManager: VaultManager,
  vaultKey: Buffer,
  studioProjectId: string,
): string | null {
  const id = vaultManager.getCredential(vaultKey, 'firebase', vaultKeyPath(studioProjectId, 'gcp_project_id'));
  return id?.trim() || null;
}

export function storeGcpProjectId(
  vaultManager: VaultManager,
  vaultKey: Buffer,
  studioProjectId: string,
  gcpProjectId: string,
): void {
  vaultManager.setCredential(vaultKey, 'firebase', vaultKeyPath(studioProjectId, 'gcp_project_id'), gcpProjectId);
}

export function getStoredSaEmail(
  vaultManager: VaultManager,
  vaultKey: Buffer,
  studioProjectId: string,
): string | null {
  return vaultManager.getCredential(vaultKey, 'firebase', vaultKeyPath(studioProjectId, 'service_account_email'))?.trim() || null;
}

export function storeSaEmail(
  vaultManager: VaultManager,
  vaultKey: Buffer,
  studioProjectId: string,
  email: string,
): void {
  vaultManager.setCredential(vaultKey, 'firebase', vaultKeyPath(studioProjectId, 'service_account_email'), email);
}

export function getStoredSaKeyJson(
  vaultManager: VaultManager,
  vaultKey: Buffer,
  studioProjectId: string,
): string | null {
  return vaultManager.getCredential(vaultKey, 'firebase', vaultKeyPath(studioProjectId, 'service_account_json'))?.trim() || null;
}

export function storeSaKeyJson(
  vaultManager: VaultManager,
  vaultKey: Buffer,
  studioProjectId: string,
  json: string,
): void {
  vaultManager.setCredential(vaultKey, 'firebase', vaultKeyPath(studioProjectId, 'service_account_json'), json);
}

export function getStoredConnectionDetails(
  vaultManager: VaultManager,
  vaultKey: Buffer,
  studioProjectId: string,
): GcpConnectionDetails | null {
  const gcpProjectId = vaultManager.getCredential(vaultKey, 'firebase', vaultKeyPath(studioProjectId, 'gcp_project_id'));
  const saEmail = vaultManager.getCredential(vaultKey, 'firebase', vaultKeyPath(studioProjectId, 'service_account_email'));
  if (!gcpProjectId || !saEmail) return null;
  return {
    projectId: gcpProjectId,
    serviceAccountEmail: saEmail,
    userEmail: vaultManager.getCredential(vaultKey, 'firebase', vaultKeyPath(studioProjectId, 'connected_by_email')) ?? 'unknown',
    connectedAt: vaultManager.getCredential(vaultKey, 'firebase', vaultKeyPath(studioProjectId, 'connected_at')) ?? new Date(0).toISOString(),
  };
}

export function storeConnectionDetails(
  vaultManager: VaultManager,
  vaultKey: Buffer,
  studioProjectId: string,
  details: GcpConnectionDetails,
): void {
  vaultManager.setCredential(vaultKey, 'firebase', vaultKeyPath(studioProjectId, 'gcp_project_id'), details.projectId);
  vaultManager.setCredential(vaultKey, 'firebase', vaultKeyPath(studioProjectId, 'service_account_email'), details.serviceAccountEmail);
  vaultManager.setCredential(vaultKey, 'firebase', vaultKeyPath(studioProjectId, 'connected_by_email'), details.userEmail);
  vaultManager.setCredential(vaultKey, 'firebase', vaultKeyPath(studioProjectId, 'connected_at'), details.connectedAt);
}

/** Delete only the SA key JSON from vault (leaves project ID and SA email for other handlers). */
export function deleteSaKeyJson(
  vaultManager: VaultManager,
  vaultKey: Buffer,
  studioProjectId: string,
): void {
  vaultManager.deleteCredential(vaultKey, 'firebase', vaultKeyPath(studioProjectId, 'service_account_json'));
}

/** Delete all GCP-related vault entries. Returns true if SA JSON was present. */
export function deleteGcpCredentials(
  vaultManager: VaultManager,
  vaultKey: Buffer,
  studioProjectId: string,
): boolean {
  const removed = vaultManager.deleteCredential(vaultKey, 'firebase', vaultKeyPath(studioProjectId, 'service_account_json'));
  vaultManager.deleteCredential(vaultKey, 'firebase', vaultKeyPath(studioProjectId, 'gcp_project_id'));
  vaultManager.deleteCredential(vaultKey, 'firebase', vaultKeyPath(studioProjectId, 'service_account_email'));
  vaultManager.deleteCredential(vaultKey, 'firebase', vaultKeyPath(studioProjectId, 'connected_by_email'));
  vaultManager.deleteCredential(vaultKey, 'firebase', vaultKeyPath(studioProjectId, 'connected_at'));
  vaultManager.deleteCredential(vaultKey, 'firebase', vaultKeyPath(studioProjectId, 'gcp_oauth_refresh_token'));
  return removed;
}

// ---------------------------------------------------------------------------
// Preview details (before SA key is generated)
// ---------------------------------------------------------------------------

export function buildOAuthPreviewDetails(
  studioProjectId: string,
  vaultManager: VaultManager,
  vaultKey: Buffer,
  userEmail: string,
): GcpConnectionDetails {
  const gcpProjectId = getStoredGcpProjectId(vaultManager, vaultKey, studioProjectId) ?? buildStudioGcpProjectId(studioProjectId);
  return {
    projectId: gcpProjectId,
    serviceAccountEmail: `${GCP_PROVISIONER_SA_ID}@${gcpProjectId}.iam.gserviceaccount.com`,
    userEmail,
    connectedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Project integration sync
// ---------------------------------------------------------------------------

/** Update the ProjectManager Firebase integration record after GCP provisioning. */
export function syncFirebaseIntegration(
  projectManager: ProjectManager,
  projectId: string,
  details: GcpConnectionDetails,
): GcpProjectConnectionStatus {
  const module = projectManager.getProject(projectId);
  if (!module.integrations.firebase) {
    projectManager.addIntegration(projectId, 'firebase');
  }
  const updated = projectManager.updateIntegration(projectId, 'firebase', {
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
  return { connected: true, details, integration: updated.integrations.firebase };
}

/** Update the Firebase integration after GCP project is linked via OAuth (before SA is created). */
export function applyGcpProjectLinked(
  projectManager: ProjectManager,
  studioProjectId: string,
  gcpProjectId: string,
  userEmail: string,
): void {
  const module = projectManager.getProject(studioProjectId);
  if (!module.integrations.firebase) {
    projectManager.addIntegration(studioProjectId, 'firebase');
  }
  const existing = projectManager.getProject(studioProjectId).integrations.firebase;
  if (!existing) return;

  const sa = existing.config['service_account_email']?.trim() ?? '';
  const status: 'configured' | 'in_progress' = existing.status === 'configured' && sa ? 'configured' : 'in_progress';
  const tokenSource = status === 'configured' && sa
    ? (existing.config['token_source'] ?? 'credential_vault')
    : 'user_oauth';

  projectManager.updateIntegration(studioProjectId, 'firebase', {
    status,
    notes: status === 'configured'
      ? existing.notes
      : `GCP project "${gcpProjectId}" linked after Google sign-in. Run provisioning plan sync to reconcile.`,
    config: {
      gcp_project_id: gcpProjectId,
      connected_by: userEmail,
      connected_at: existing.config['connected_at']?.trim() || new Date().toISOString(),
      credential_scope: 'project',
      token_source: tokenSource,
    },
  });
}

/** Store SA key in vault and update all connection metadata + Firebase integration. */
export function recordProvisionerServiceAccountKey(
  vaultManager: VaultManager,
  vaultKey: Buffer,
  projectManager: ProjectManager,
  studioProjectId: string,
  gcpProjectId: string,
  saEmail: string,
  saKeyJson: string,
): GcpProjectConnectionStatus {
  storeSaKeyJson(vaultManager, vaultKey, studioProjectId, saKeyJson);
  const userEmail =
    vaultManager.getCredential(vaultKey, 'firebase', `${studioProjectId}/connected_by_email`) ?? 'unknown';
  const details: GcpConnectionDetails = {
    projectId: gcpProjectId,
    serviceAccountEmail: saEmail,
    userEmail,
    connectedAt: new Date().toISOString(),
  };
  storeConnectionDetails(vaultManager, vaultKey, studioProjectId, details);
  return syncFirebaseIntegration(projectManager, studioProjectId, details);
}

// ---------------------------------------------------------------------------
// Firebase app ID storage (set by register-ios-app / register-android-app)
// ---------------------------------------------------------------------------

export function getStoredFirebaseIosAppId(
  vaultManager: VaultManager,
  vaultKey: Buffer,
  studioProjectId: string,
): string | null {
  return vaultManager.getCredential(vaultKey, 'firebase', vaultKeyPath(studioProjectId, 'firebase_ios_app_id'))?.trim() || null;
}

export function storeFirebaseIosAppId(
  vaultManager: VaultManager,
  vaultKey: Buffer,
  studioProjectId: string,
  appId: string,
): void {
  vaultManager.setCredential(vaultKey, 'firebase', vaultKeyPath(studioProjectId, 'firebase_ios_app_id'), appId);
}

export function getStoredFirebaseAndroidAppId(
  vaultManager: VaultManager,
  vaultKey: Buffer,
  studioProjectId: string,
): string | null {
  return vaultManager.getCredential(vaultKey, 'firebase', vaultKeyPath(studioProjectId, 'firebase_android_app_id'))?.trim() || null;
}

export function storeFirebaseAndroidAppId(
  vaultManager: VaultManager,
  vaultKey: Buffer,
  studioProjectId: string,
  appId: string,
): void {
  vaultManager.setCredential(vaultKey, 'firebase', vaultKeyPath(studioProjectId, 'firebase_android_app_id'), appId);
}

// ---------------------------------------------------------------------------
// Firestore database storage
// ---------------------------------------------------------------------------

export function getStoredFirestoreDatabaseId(
  vaultManager: VaultManager,
  vaultKey: Buffer,
  studioProjectId: string,
): string | null {
  return vaultManager.getCredential(vaultKey, 'firebase', vaultKeyPath(studioProjectId, 'firestore_database_id'))?.trim() || null;
}

export function storeFirestoreDatabaseId(
  vaultManager: VaultManager,
  vaultKey: Buffer,
  studioProjectId: string,
  databaseId: string,
): void {
  vaultManager.setCredential(vaultKey, 'firebase', vaultKeyPath(studioProjectId, 'firestore_database_id'), databaseId);
}

export function getStoredFirestoreLocation(
  vaultManager: VaultManager,
  vaultKey: Buffer,
  studioProjectId: string,
): string | null {
  return vaultManager.getCredential(vaultKey, 'firebase', vaultKeyPath(studioProjectId, 'firestore_location'))?.trim() || null;
}

export function storeFirestoreLocation(
  vaultManager: VaultManager,
  vaultKey: Buffer,
  studioProjectId: string,
  location: string,
): void {
  vaultManager.setCredential(vaultKey, 'firebase', vaultKeyPath(studioProjectId, 'firestore_location'), location);
}

export function deleteFirestoreCredentials(
  vaultManager: VaultManager,
  vaultKey: Buffer,
  studioProjectId: string,
): void {
  vaultManager.deleteCredential(vaultKey, 'firebase', vaultKeyPath(studioProjectId, 'firestore_database_id'));
  vaultManager.deleteCredential(vaultKey, 'firebase', vaultKeyPath(studioProjectId, 'firestore_location'));
}

export { GCP_PROVISIONER_SA_ID, provisionerSaEmail };
