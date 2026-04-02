/**
 * AppleSigningHandler — handles file uploads and credential storage
 * for the Apple Signing guided flow.
 *
 * Works alongside GuidedFlowService to process .p8 file uploads
 * and store Apple signing credentials in the credential store.
 */

import { validateAppleP8Key } from '../validators/apple-key-validator.js';
import type { GuidedFlowService } from '../services/guided-flow-service.js';
import type { CredentialService } from '../services/credential-service.js';
import { GuidedFlowError } from '../models/guided-flow.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppleCredentials {
  project_id: string;
  team_id: string;
  bundle_id: string;
  p8_upload_id: string;
  key_id: string;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export class AppleSigningHandler {
  constructor(
    private readonly guidedFlowService: GuidedFlowService,
    private readonly credentialService: CredentialService,
  ) {}

  /**
   * Validates and stores a .p8 key file upload for an Apple signing step.
   * Returns the file upload ID for reference.
   */
  async handleP8Upload(
    stepId: string,
    fileBuffer: Buffer,
    fileName: string,
    keyId: string,
    teamId: string,
  ): Promise<{ upload_id: string; credential_hash: string; key_id: string; team_id: string }> {
    const validation = validateAppleP8Key(fileBuffer);

    const upload = await this.guidedFlowService.recordFileUpload(
      stepId,
      fileName,
      'application/pkcs8',
      fileBuffer,
      'valid',
    );

    this.credentialService.storeCredential({
      project_id: stepId,
      credential_type: 'apple_p8',
      value: validation.pem,
      metadata: {
        key_id: keyId,
        team_id: teamId,
        credential_hash: validation.credential_hash,
        upload_id: upload.id,
      },
    });

    return {
      upload_id: upload.id,
      credential_hash: validation.credential_hash,
      key_id: keyId,
      team_id: teamId,
    };
  }

  /**
   * Validates that all required Apple signing credentials are present.
   * Returns null if valid, or an error message listing what's missing.
   */
  validateAppleSetup(
    projectId: string,
    requiredFields: { team_id: string; bundle_id: string; upload_id: string },
  ): string | null {
    const missing: string[] = [];
    if (!requiredFields.team_id) missing.push('Apple Team ID');
    if (!requiredFields.bundle_id) missing.push('Bundle ID');
    if (!requiredFields.upload_id) missing.push('.p8 Key File');

    const hasP8 = this.credentialService.getCredentialSummary(projectId, 'apple_p8') !== null;
    if (!hasP8) missing.push('.p8 Key File (not uploaded yet)');

    return missing.length > 0
      ? `Missing required Apple signing fields: ${missing.join(', ')}.`
      : null;
  }
}
