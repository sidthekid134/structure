/**
 * Firebase Auth Handler — enables Firebase Identity Toolkit and manages
 * Firebase Auth configuration for a GCP project.
 *
 * Substeps are streamed over WebSocket by the caller; this module performs
 * the underlying GCP API calls.
 */

import { GcpHttpError } from '../core/gcp/gcp-api-client.js';
import {
  enableIdentityToolkit,
  getFirebaseAuthConfig,
  addFirebaseAuthorizedDomain,
} from '../core/gcp/gcp-api-client.js';
import type { CredentialStore } from '../services/credential-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EnableIdentityToolkitResult {
  success: boolean;
  project_id: string;
  identity_toolkit_enabled: boolean;
  message: string;
}

export interface FirebaseAuthStatusResult {
  project_id: string;
  identity_toolkit_enabled: boolean;
  authorized_domains: string[];
}

export type ProgressCallback = (substep: string, status: 'in-progress' | 'complete' | 'error') => void;

// ---------------------------------------------------------------------------
// Handler functions
// ---------------------------------------------------------------------------

/**
 * Enables Firebase Identity Toolkit for a GCP project.
 * Streams progress via the optional callback.
 */
export async function enableFirebaseIdentityToolkit(
  projectId: string,
  gcpProjectId: string,
  accessToken: string,
  credentialStore: CredentialStore,
  onProgress?: ProgressCallback,
): Promise<EnableIdentityToolkitResult> {
  onProgress?.('Validating GCP project...', 'in-progress');

  if (!gcpProjectId || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(gcpProjectId)) {
    onProgress?.('Validating GCP project...', 'error');
    throw new GcpHttpError(`Invalid GCP project ID format: "${gcpProjectId}"`, 400, '');
  }

  onProgress?.('Validating GCP project...', 'complete');
  onProgress?.('Enabling Firebase Identity Toolkit...', 'in-progress');

  await enableIdentityToolkit(accessToken, gcpProjectId);

  onProgress?.('Enabling Firebase Identity Toolkit...', 'complete');
  onProgress?.('Configuring permissions...', 'in-progress');

  credentialStore.upsertFirebaseAuthConfig({
    project_id: projectId,
    identity_toolkit_enabled: true,
  });
  credentialStore.updateFirebaseAuthConfig(projectId, { identity_toolkit_enabled: true });

  onProgress?.('Configuring permissions...', 'complete');

  return {
    success: true,
    project_id: projectId,
    identity_toolkit_enabled: true,
    message: 'Firebase Identity Toolkit enabled successfully.',
  };
}

/**
 * Returns the current Firebase Auth configuration for a project.
 */
export async function getFirebaseAuthStatus(
  gcpProjectId: string,
  accessToken: string,
): Promise<FirebaseAuthStatusResult> {
  const config = await getFirebaseAuthConfig(accessToken, gcpProjectId);
  const authorizedDomains = Array.isArray(config['authorizedDomains'])
    ? (config['authorizedDomains'] as string[])
    : [];
  const signIn = config['signIn'] as Record<string, unknown> | undefined;
  const emailConfig = signIn?.['email'] as Record<string, unknown> | undefined;
  const identityToolkitEnabled = emailConfig?.['enabled'] === true;

  return {
    project_id: gcpProjectId,
    identity_toolkit_enabled: identityToolkitEnabled,
    authorized_domains: authorizedDomains,
  };
}

/**
 * Adds a redirect domain to Firebase Auth authorized domains.
 */
export async function addAuthorizedDomain(
  gcpProjectId: string,
  domain: string,
  accessToken: string,
): Promise<void> {
  await addFirebaseAuthorizedDomain(accessToken, gcpProjectId, domain);
}
