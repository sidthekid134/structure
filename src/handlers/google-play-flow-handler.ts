/**
 * GooglePlayHandler — handles file uploads and credential storage
 * for the Google Play guided flow.
 *
 * Works alongside GuidedFlowService to process service account JSON uploads
 * and record the initial AAB upload confirmation.
 */

import { validateGooglePlayKey } from '../validators/credential-validators.js';
import type { GuidedFlowService } from '../services/guided-flow-service.js';
import type { CredentialService } from '../services/credential-service.js';

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export class GooglePlayHandler {
  constructor(
    private readonly guidedFlowService: GuidedFlowService,
    private readonly credentialService: CredentialService,
  ) {}

  /**
   * Validates and stores a Google Play service account JSON key upload.
   */
  async handleServiceAccountUpload(
    stepId: string,
    projectId: string,
    fileBuffer: Buffer,
    fileName: string,
  ): Promise<{
    upload_id: string;
    project_id_from_key: string | null;
    client_email: string | null;
    file_hash: string;
  }> {
    const validation = validateGooglePlayKey(fileBuffer);
    const meta = validation.metadata;

    const upload = await this.guidedFlowService.recordFileUpload(
      stepId,
      fileName,
      'application/json',
      fileBuffer,
      'valid',
    );

    this.credentialService.storeCredential({
      project_id: projectId,
      credential_type: 'google_play_key',
      value: fileBuffer.toString('base64'),
      metadata: {
        upload_id: upload.id,
        project_id_from_key: meta['project_id'] ?? null,
        client_email: meta['client_email'] ?? null,
        file_hash: meta['file_hash'] ?? null,
      },
    });

    return {
      upload_id: upload.id,
      project_id_from_key: (meta['project_id'] as string | undefined) ?? null,
      client_email: (meta['client_email'] as string | undefined) ?? null,
      file_hash: (meta['file_hash'] as string | undefined) ?? upload.file_hash,
    };
  }

  /**
   * Validates the service account JSON structure.
   * Can be called directly for format-only validation before upload.
   */
  validateServiceAccountKey(jsonBuffer: Buffer): { valid: boolean; metadata: Record<string, unknown> } {
    return validateGooglePlayKey(jsonBuffer);
  }

  /**
   * Records that the initial AAB upload to Play Console has been completed manually.
   */
  storeGooglePlayCredentials(
    projectId: string,
    serviceAccountUploadId: string,
    appId: string,
  ): void {
    const existing = this.credentialService.getCredentialSummary(projectId, 'google_play_key');
    if (!existing) {
      throw new Error(
        'No Google Play service account key found. Upload the service account JSON first.',
      );
    }

    this.credentialService.storeCredential({
      project_id: projectId,
      credential_type: 'google_play_key',
      value: serviceAccountUploadId,
      metadata: {
        app_id: appId,
        aab_uploaded: true,
        service_account_upload_id: serviceAccountUploadId,
        confirmed_at: Date.now(),
      },
    });
  }
}
