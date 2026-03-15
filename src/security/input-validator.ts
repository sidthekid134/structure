/**
 * Security-focused input validation for encryption operations and provider
 * configurations.
 *
 * Rules enforced:
 *   - Encryption inputs: plaintext must be string/Buffer (not null), key must be 32-byte Buffer
 *   - Provider configs: all required fields present, no null values, no shell metacharacters
 *   - Secret values: non-empty string, no null bytes
 */

import type { ProviderConfig, ProviderType } from '../providers/types.js';

const SHELL_META_RE = /[;&|`$<>\\]/;
const NULL_BYTE_RE = /\x00/;

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

export interface InputValidationError {
  field: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Encryption input validation
// ---------------------------------------------------------------------------

export const KEY_LENGTH_BYTES = 32;

/**
 * Validates inputs to encrypt() / decrypt() before the crypto operation runs.
 * Throws with a descriptive message on any violation.
 */
export function validateEncryptionInput(
  plaintext: unknown,
  key: unknown,
): void {
  if (
    plaintext === null ||
    plaintext === undefined ||
    (typeof plaintext !== 'string' && !Buffer.isBuffer(plaintext))
  ) {
    throw new Error(
      'Encryption input validation failed: plaintext must be a non-null string or Buffer',
    );
  }

  if (typeof plaintext === 'string' && plaintext.length === 0) {
    throw new Error('Encryption input validation failed: plaintext must not be empty');
  }

  if (Buffer.isBuffer(plaintext) && plaintext.length === 0) {
    throw new Error('Encryption input validation failed: plaintext buffer must not be empty');
  }

  if (!Buffer.isBuffer(key)) {
    throw new Error(
      'Encryption input validation failed: key must be a Buffer',
    );
  }

  if ((key as Buffer).length !== KEY_LENGTH_BYTES) {
    throw new Error(
      `Encryption input validation failed: key must be exactly ${KEY_LENGTH_BYTES} bytes, ` +
        `got ${(key as Buffer).length}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Provider config validation
// ---------------------------------------------------------------------------

/**
 * Validates a provider config object for security concerns:
 *   - No null/undefined required fields
 *   - No shell metacharacters in string values
 *   - No null bytes in any string value
 *
 * Returns an array of validation errors (empty = valid).
 */
export function validateProviderConfig(
  config: ProviderConfig,
): InputValidationError[] {
  const errors: InputValidationError[] = [];
  const obj = config as unknown as Record<string, unknown>;

  for (const [key, value] of Object.entries(obj)) {
    if (key === 'provider') continue; // discriminant field, skip

    if (value === null || value === undefined) {
      errors.push({ field: key, message: `Field "${key}" must not be null or undefined` });
      continue;
    }

    if (typeof value === 'string') {
      if (NULL_BYTE_RE.test(value)) {
        errors.push({ field: key, message: `Field "${key}" contains null bytes` });
      }
      if (SHELL_META_RE.test(value)) {
        errors.push({
          field: key,
          message: `Field "${key}" contains suspicious shell metacharacters`,
        });
      }
    }

    // Recurse into nested objects (e.g. branch_protection_rules)
    if (typeof value === 'object' && !Array.isArray(value) && value !== null) {
      const nested = validateProviderConfig(value as ProviderConfig);
      errors.push(...nested.map(e => ({ ...e, field: `${key}.${e.field}` })));
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Generic manifest/options validation
// ---------------------------------------------------------------------------

/**
 * Validates the top-level Orchestrator.provision() inputs.
 */
export function validateOrchestrationInputs(
  manifest: unknown,
  appId: unknown,
  resume: unknown,
): void {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('manifest must be a non-null object');
  }

  if (typeof appId !== 'string' || !(appId as string).trim()) {
    throw new Error('app_id must be a non-empty string');
  }

  if (resume !== undefined && typeof resume !== 'boolean') {
    throw new Error('options.resume must be a boolean');
  }
}
