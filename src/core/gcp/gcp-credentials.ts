/**
 * GCP credential storage helpers.
 *
 * All credential reads/writes for GCP connection details, service account JSON,
 * and connection metadata live here. Uses the unified CredentialService (SQLite)
 * for all storage.
 */

import type { CredentialService } from '../../services/credential-service.js';
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
  credentialService: CredentialService,
  studioProjectId: string,
): string | null {
  return credentialService.retrieveCredential(studioProjectId, 'gcp_project_id')?.trim() || null;
}

export function storeGcpProjectId(
  credentialService: CredentialService,
  studioProjectId: string,
  gcpProjectId: string,
): void {
  credentialService.storeCredential({ project_id: studioProjectId, credential_type: 'gcp_project_id', value: gcpProjectId });
}

export function getStoredSaEmail(
  credentialService: CredentialService,
  studioProjectId: string,
): string | null {
  return credentialService.retrieveCredential(studioProjectId, 'gcp_service_account_email')?.trim() || null;
}

export function storeSaEmail(
  credentialService: CredentialService,
  studioProjectId: string,
  email: string,
): void {
  credentialService.storeCredential({ project_id: studioProjectId, credential_type: 'gcp_service_account_email', value: email });
}

export function getStoredSaKeyJson(
  credentialService: CredentialService,
  studioProjectId: string,
): string | null {
  return credentialService.retrieveCredential(studioProjectId, 'gcp_service_account_json')?.trim() || null;
}

export function storeSaKeyJson(
  credentialService: CredentialService,
  studioProjectId: string,
  json: string,
): void {
  credentialService.storeCredential({ project_id: studioProjectId, credential_type: 'gcp_service_account_json', value: json });
}

export function getStoredConnectionDetails(
  credentialService: CredentialService,
  studioProjectId: string,
): GcpConnectionDetails | null {
  const gcpProjectId = credentialService.retrieveCredential(studioProjectId, 'gcp_project_id');
  const saEmail = credentialService.retrieveCredential(studioProjectId, 'gcp_service_account_email');
  if (!gcpProjectId || !saEmail) return null;
  return {
    projectId: gcpProjectId,
    serviceAccountEmail: saEmail,
    userEmail: credentialService.retrieveCredential(studioProjectId, 'gcp_connected_by_email') ?? 'unknown',
    connectedAt: credentialService.retrieveCredential(studioProjectId, 'gcp_connected_at') ?? new Date(0).toISOString(),
  };
}

export function storeConnectionDetails(
  credentialService: CredentialService,
  studioProjectId: string,
  details: GcpConnectionDetails,
): void {
  credentialService.storeCredential({ project_id: studioProjectId, credential_type: 'gcp_project_id', value: details.projectId });
  credentialService.storeCredential({ project_id: studioProjectId, credential_type: 'gcp_service_account_email', value: details.serviceAccountEmail });
  credentialService.storeCredential({ project_id: studioProjectId, credential_type: 'gcp_connected_by_email', value: details.userEmail });
  credentialService.storeCredential({ project_id: studioProjectId, credential_type: 'gcp_connected_at', value: details.connectedAt });
}

/** Delete only the SA key JSON (leaves project ID and SA email for other handlers). */
export function deleteSaKeyJson(
  credentialService: CredentialService,
  studioProjectId: string,
): void {
  credentialService.deleteCredentialByType(studioProjectId, 'gcp_service_account_json');
}

/** Delete all GCP-related credential entries. Returns true if SA JSON was present. */
export function deleteGcpCredentials(
  credentialService: CredentialService,
  studioProjectId: string,
): boolean {
  const hadSaJson = credentialService.getCredentialSummary(studioProjectId, 'gcp_service_account_json') !== null;
  credentialService.deleteCredentialByType(studioProjectId, 'gcp_service_account_json');
  credentialService.deleteCredentialByType(studioProjectId, 'gcp_project_id');
  credentialService.deleteCredentialByType(studioProjectId, 'gcp_service_account_email');
  credentialService.deleteCredentialByType(studioProjectId, 'gcp_connected_by_email');
  credentialService.deleteCredentialByType(studioProjectId, 'gcp_connected_at');
  credentialService.deleteCredentialByType(studioProjectId, 'gcp_oauth_refresh_token');
  return hadSaJson;
}

// ---------------------------------------------------------------------------
// Preview details (before SA key is generated)
// ---------------------------------------------------------------------------

export function buildOAuthPreviewDetails(
  studioProjectId: string,
  credentialService: CredentialService,
  userEmail: string,
): GcpConnectionDetails {
  const gcpProjectId = getStoredGcpProjectId(credentialService, studioProjectId) ?? buildStudioGcpProjectId(studioProjectId);
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

/** Store SA key and update all connection metadata + Firebase integration. */
export function recordProvisionerServiceAccountKey(
  credentialService: CredentialService,
  projectManager: ProjectManager,
  studioProjectId: string,
  gcpProjectId: string,
  saEmail: string,
  saKeyJson: string,
): GcpProjectConnectionStatus {
  storeSaKeyJson(credentialService, studioProjectId, saKeyJson);
  const userEmail = credentialService.retrieveCredential(studioProjectId, 'gcp_connected_by_email') ?? 'unknown';
  const details: GcpConnectionDetails = {
    projectId: gcpProjectId,
    serviceAccountEmail: saEmail,
    userEmail,
    connectedAt: new Date().toISOString(),
  };
  storeConnectionDetails(credentialService, studioProjectId, details);
  return syncFirebaseIntegration(projectManager, studioProjectId, details);
}

// ---------------------------------------------------------------------------
// Firebase app ID storage (set by register-ios-app / register-android-app)
// ---------------------------------------------------------------------------

export function getStoredFirebaseIosAppId(
  credentialService: CredentialService,
  studioProjectId: string,
): string | null {
  return credentialService.retrieveCredential(studioProjectId, 'firebase_ios_app_id')?.trim() || null;
}

export function storeFirebaseIosAppId(
  credentialService: CredentialService,
  studioProjectId: string,
  appId: string,
): void {
  credentialService.storeCredential({ project_id: studioProjectId, credential_type: 'firebase_ios_app_id', value: appId });
}

export function getStoredFirebaseAndroidAppId(
  credentialService: CredentialService,
  studioProjectId: string,
): string | null {
  return credentialService.retrieveCredential(studioProjectId, 'firebase_android_app_id')?.trim() || null;
}

export function storeFirebaseAndroidAppId(
  credentialService: CredentialService,
  studioProjectId: string,
  appId: string,
): void {
  credentialService.storeCredential({ project_id: studioProjectId, credential_type: 'firebase_android_app_id', value: appId });
}

// ---------------------------------------------------------------------------
// Firestore database storage
// ---------------------------------------------------------------------------

export function getStoredFirestoreDatabaseId(
  credentialService: CredentialService,
  studioProjectId: string,
): string | null {
  return credentialService.retrieveCredential(studioProjectId, 'firestore_database_id')?.trim() || null;
}

export function storeFirestoreDatabaseId(
  credentialService: CredentialService,
  studioProjectId: string,
  databaseId: string,
): void {
  credentialService.storeCredential({ project_id: studioProjectId, credential_type: 'firestore_database_id', value: databaseId });
}

export function getStoredFirestoreLocation(
  credentialService: CredentialService,
  studioProjectId: string,
): string | null {
  return credentialService.retrieveCredential(studioProjectId, 'firestore_location')?.trim() || null;
}

export function storeFirestoreLocation(
  credentialService: CredentialService,
  studioProjectId: string,
  location: string,
): void {
  credentialService.storeCredential({ project_id: studioProjectId, credential_type: 'firestore_location', value: location });
}

export function deleteFirestoreCredentials(
  credentialService: CredentialService,
  studioProjectId: string,
): void {
  credentialService.deleteCredentialByType(studioProjectId, 'firestore_database_id');
  credentialService.deleteCredentialByType(studioProjectId, 'firestore_location');
}

export { GCP_PROVISIONER_SA_ID, provisionerSaEmail };
