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

export function buildStructureGcpProjectId(structureProjectId: string): string {
  const base = structureProjectId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  const hash = crypto.createHash('sha1').update(structureProjectId).digest('hex').slice(0, 6);
  const maxBaseLength = 30 - 'st--'.length - hash.length;
  const trimmedBase = (base || 'project').slice(0, maxBaseLength).replace(/-+$/g, '');
  return `st-${trimmedBase}-${hash}`;
}

export function buildGcpProjectIdWithEntropy(structureProjectId: string): string {
  const base =
    structureProjectId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  const entropy = crypto.randomBytes(4).toString('hex');
  const maxBaseLength = 30 - 'st--'.length - entropy.length;
  return `st-${base.slice(0, maxBaseLength).replace(/-+$/g, '')}-${entropy}`;
}

// ---------------------------------------------------------------------------
// Credential reads and writes
// ---------------------------------------------------------------------------

export function getStoredGcpProjectId(
  credentialService: CredentialService,
  structureProjectId: string,
): string | null {
  return credentialService.retrieveCredential(structureProjectId, 'gcp_project_id')?.trim() || null;
}

export function storeGcpProjectId(
  credentialService: CredentialService,
  structureProjectId: string,
  gcpProjectId: string,
): void {
  credentialService.storeCredential({ project_id: structureProjectId, credential_type: 'gcp_project_id', value: gcpProjectId });
}

export function getStoredSaEmail(
  credentialService: CredentialService,
  structureProjectId: string,
): string | null {
  return credentialService.retrieveCredential(structureProjectId, 'gcp_service_account_email')?.trim() || null;
}

export function storeSaEmail(
  credentialService: CredentialService,
  structureProjectId: string,
  email: string,
): void {
  credentialService.storeCredential({ project_id: structureProjectId, credential_type: 'gcp_service_account_email', value: email });
}

export function getStoredSaKeyJson(
  credentialService: CredentialService,
  structureProjectId: string,
): string | null {
  return credentialService.retrieveCredential(structureProjectId, 'gcp_service_account_json')?.trim() || null;
}

export function storeSaKeyJson(
  credentialService: CredentialService,
  structureProjectId: string,
  json: string,
): void {
  credentialService.storeCredential({ project_id: structureProjectId, credential_type: 'gcp_service_account_json', value: json });
}

export function getStoredConnectionDetails(
  credentialService: CredentialService,
  structureProjectId: string,
): GcpConnectionDetails | null {
  const gcpProjectId = credentialService.retrieveCredential(structureProjectId, 'gcp_project_id');
  const saEmail = credentialService.retrieveCredential(structureProjectId, 'gcp_service_account_email');
  if (!gcpProjectId || !saEmail) return null;
  return {
    projectId: gcpProjectId,
    serviceAccountEmail: saEmail,
    userEmail: credentialService.retrieveCredential(structureProjectId, 'gcp_connected_by_email') ?? 'unknown',
    connectedAt: credentialService.retrieveCredential(structureProjectId, 'gcp_connected_at') ?? new Date(0).toISOString(),
  };
}

export function storeConnectionDetails(
  credentialService: CredentialService,
  structureProjectId: string,
  details: GcpConnectionDetails,
): void {
  credentialService.storeCredential({ project_id: structureProjectId, credential_type: 'gcp_project_id', value: details.projectId });
  credentialService.storeCredential({ project_id: structureProjectId, credential_type: 'gcp_service_account_email', value: details.serviceAccountEmail });
  credentialService.storeCredential({ project_id: structureProjectId, credential_type: 'gcp_connected_by_email', value: details.userEmail });
  credentialService.storeCredential({ project_id: structureProjectId, credential_type: 'gcp_connected_at', value: details.connectedAt });
}

/** Delete only the SA key JSON (leaves project ID and SA email for other handlers). */
export function deleteSaKeyJson(
  credentialService: CredentialService,
  structureProjectId: string,
): void {
  credentialService.deleteCredentialByType(structureProjectId, 'gcp_service_account_json');
}

/** Delete all GCP-related credential entries. Returns true if SA JSON was present. */
export function deleteGcpCredentials(
  credentialService: CredentialService,
  structureProjectId: string,
): boolean {
  const hadSaJson = credentialService.getCredentialSummary(structureProjectId, 'gcp_service_account_json') !== null;
  credentialService.deleteCredentialByType(structureProjectId, 'gcp_service_account_json');
  credentialService.deleteCredentialByType(structureProjectId, 'gcp_project_id');
  credentialService.deleteCredentialByType(structureProjectId, 'gcp_service_account_email');
  credentialService.deleteCredentialByType(structureProjectId, 'gcp_connected_by_email');
  credentialService.deleteCredentialByType(structureProjectId, 'gcp_connected_at');
  credentialService.deleteCredentialByType(structureProjectId, 'gcp_oauth_refresh_token');
  return hadSaJson;
}

// ---------------------------------------------------------------------------
// Preview details (before SA key is generated)
// ---------------------------------------------------------------------------

export function buildOAuthPreviewDetails(
  structureProjectId: string,
  credentialService: CredentialService,
  userEmail: string,
): GcpConnectionDetails {
  const gcpProjectId = getStoredGcpProjectId(credentialService, structureProjectId) ?? buildStructureGcpProjectId(structureProjectId);
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
  structureProjectId: string,
  gcpProjectId: string,
  userEmail: string,
): void {
  const module = projectManager.getProject(structureProjectId);
  if (!module.integrations.firebase) {
    projectManager.addIntegration(structureProjectId, 'firebase');
  }
  const existing = projectManager.getProject(structureProjectId).integrations.firebase;
  if (!existing) return;

  const sa = existing.config['service_account_email']?.trim() ?? '';
  const status: 'configured' | 'in_progress' = existing.status === 'configured' && sa ? 'configured' : 'in_progress';
  const tokenSource = status === 'configured' && sa
    ? (existing.config['token_source'] ?? 'credential_vault')
    : 'user_oauth';

  projectManager.updateIntegration(structureProjectId, 'firebase', {
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
  structureProjectId: string,
  gcpProjectId: string,
  saEmail: string,
  saKeyJson: string,
): GcpProjectConnectionStatus {
  storeSaKeyJson(credentialService, structureProjectId, saKeyJson);
  const userEmail = credentialService.retrieveCredential(structureProjectId, 'gcp_connected_by_email') ?? 'unknown';
  const details: GcpConnectionDetails = {
    projectId: gcpProjectId,
    serviceAccountEmail: saEmail,
    userEmail,
    connectedAt: new Date().toISOString(),
  };
  storeConnectionDetails(credentialService, structureProjectId, details);
  return syncFirebaseIntegration(projectManager, structureProjectId, details);
}

// ---------------------------------------------------------------------------
// Firebase app ID storage (set by register-ios-app / register-android-app)
// ---------------------------------------------------------------------------

export function getStoredFirebaseIosAppId(
  credentialService: CredentialService,
  structureProjectId: string,
): string | null {
  return credentialService.retrieveCredential(structureProjectId, 'firebase_ios_app_id')?.trim() || null;
}

export function storeFirebaseIosAppId(
  credentialService: CredentialService,
  structureProjectId: string,
  appId: string,
): void {
  credentialService.storeCredential({ project_id: structureProjectId, credential_type: 'firebase_ios_app_id', value: appId });
}

export function getStoredFirebaseAndroidAppId(
  credentialService: CredentialService,
  structureProjectId: string,
): string | null {
  return credentialService.retrieveCredential(structureProjectId, 'firebase_android_app_id')?.trim() || null;
}

export function storeFirebaseAndroidAppId(
  credentialService: CredentialService,
  structureProjectId: string,
  appId: string,
): void {
  credentialService.storeCredential({ project_id: structureProjectId, credential_type: 'firebase_android_app_id', value: appId });
}

// ---------------------------------------------------------------------------
// Firestore database storage
// ---------------------------------------------------------------------------

export function getStoredFirestoreDatabaseId(
  credentialService: CredentialService,
  structureProjectId: string,
): string | null {
  return credentialService.retrieveCredential(structureProjectId, 'firestore_database_id')?.trim() || null;
}

export function storeFirestoreDatabaseId(
  credentialService: CredentialService,
  structureProjectId: string,
  databaseId: string,
): void {
  credentialService.storeCredential({ project_id: structureProjectId, credential_type: 'firestore_database_id', value: databaseId });
}

export function getStoredFirestoreLocation(
  credentialService: CredentialService,
  structureProjectId: string,
): string | null {
  return credentialService.retrieveCredential(structureProjectId, 'firestore_location')?.trim() || null;
}

export function storeFirestoreLocation(
  credentialService: CredentialService,
  structureProjectId: string,
  location: string,
): void {
  credentialService.storeCredential({ project_id: structureProjectId, credential_type: 'firestore_location', value: location });
}

export function deleteFirestoreCredentials(
  credentialService: CredentialService,
  structureProjectId: string,
): void {
  credentialService.deleteCredentialByType(structureProjectId, 'firestore_database_id');
  credentialService.deleteCredentialByType(structureProjectId, 'firestore_location');
}

export { GCP_PROVISIONER_SA_ID, provisionerSaEmail };
