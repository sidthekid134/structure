/**
 * Apple .p8 Key Validator
 *
 * Validates Apple private key files (.p8 format) used for:
 *   - APNs (Apple Push Notification service) keys
 *   - Sign in with Apple keys
 *
 * A valid Apple .p8 key is a PEM-encoded PKCS#8 EC private key.
 */

import * as crypto from 'crypto';
import { CredentialError } from '../types.js';

export interface AppleKeyValidationResult {
  valid: boolean;
  key_type: 'apns' | 'sign_in_with_apple' | 'unknown';
  credential_hash: string;
  pem: string;
}

/**
 * Validates an Apple .p8 private key file.
 *
 * Checks:
 *   1. File starts and ends with correct PEM markers.
 *   2. Contains exactly one key block.
 *   3. Base64 content is parseable as a DER-encoded private key.
 *   4. Returns a SHA-256 hash of the key content for duplicate detection.
 *
 * Throws CredentialError with instructions for regeneration if invalid.
 */
export function validateAppleP8Key(fileBuffer: Buffer): AppleKeyValidationResult {
  const content = fileBuffer.toString('utf8').trim();

  const BEGIN_MARKER = '-----BEGIN PRIVATE KEY-----';
  const END_MARKER = '-----END PRIVATE KEY-----';

  if (!content.startsWith(BEGIN_MARKER)) {
    throw new CredentialError(
      'Invalid Apple .p8 key: file must start with "-----BEGIN PRIVATE KEY-----". ' +
        'To regenerate: go to Apple Developer Portal → Certificates, Identifiers & Profiles → Keys → + → create a new key.',
      'validateAppleP8Key',
    );
  }

  if (!content.includes(END_MARKER)) {
    throw new CredentialError(
      'Invalid Apple .p8 key: file must end with "-----END PRIVATE KEY-----". ' +
        'The file appears truncated. Download the key again from Apple Developer Portal — ' +
        'note that Apple keys can only be downloaded once.',
      'validateAppleP8Key',
    );
  }

  const blockCount = (content.match(/-----BEGIN PRIVATE KEY-----/g) ?? []).length;
  if (blockCount !== 1) {
    throw new CredentialError(
      `Invalid Apple .p8 key: file must contain exactly one key block, found ${blockCount}. ` +
        'Ensure you are uploading a single .p8 file from Apple Developer Portal.',
      'validateAppleP8Key',
    );
  }

  // Extract and validate the base64 content between markers
  const pemBody = content
    .replace(BEGIN_MARKER, '')
    .replace(END_MARKER, '')
    .replace(/\s+/g, '');

  try {
    const der = Buffer.from(pemBody, 'base64');
    if (der.length < 64) {
      throw new CredentialError(
        'Invalid Apple .p8 key: key content is too short to be a valid EC private key. ' +
          'Ensure the file has not been truncated.',
        'validateAppleP8Key',
      );
    }

    // Attempt to parse as a private key object to confirm validity
    crypto.createPrivateKey({ key: content, format: 'pem', type: 'pkcs8' });
  } catch (err) {
    if (err instanceof CredentialError) throw err;
    throw new CredentialError(
      'Invalid Apple .p8 key: could not parse as a valid PKCS#8 private key. ' +
        'Ensure you are uploading the original .p8 file from Apple Developer Portal without modification. ' +
        'If you have lost the key, revoke it and create a new one at: ' +
        'https://developer.apple.com/account/resources/authkeys/list',
      'validateAppleP8Key',
      undefined,
    );
  }

  const credential_hash = crypto
    .createHash('sha256')
    .update(content, 'utf8')
    .digest('hex');

  // Apple keys don't declare their type in the PEM — we use 'unknown' and
  // let the upload context (APNs vs Sign In) determine the actual type.
  return {
    valid: true,
    key_type: 'unknown',
    credential_hash,
    pem: content,
  };
}
