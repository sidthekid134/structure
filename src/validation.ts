/**
 * Input validation for the credential vault system.
 *
 * All methods throw {@link ValidationError} with descriptive messages on
 * invalid input so callers can surface actionable errors to users.
 */

import * as path from 'path';
import { ValidationError } from './types.js';

/** Minimum passphrase length — enforces basic strength. */
const MIN_PASSPHRASE_LENGTH = 12;

/** AES-256 key length in bytes. */
const REQUIRED_KEY_BYTES = 32;

/** Allowed characters in a provider ID (alphanumeric + hyphen + underscore). */
const PROVIDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Allowed characters in a credential key name. */
const CREDENTIAL_KEY_RE = /^[A-Za-z0-9_./-]{1,128}$/;

export class InputValidator {
  /**
   * Validates a credential input (providerId + key + value).
   *
   * Rules:
   *  - providerId must be non-empty alphanumeric/hyphen/underscore, max 64 chars
   *  - key must match allowed characters, max 128 chars
   *  - value must be a non-empty string
   */
  static validateCredentialInput(
    providerId: string,
    key: string,
    value: string,
  ): void {
    const op = 'validateCredentialInput';

    if (!providerId || !PROVIDER_ID_RE.test(providerId)) {
      throw new ValidationError(
        `Invalid providerId "${providerId}" — must be 1-64 alphanumeric characters, hyphens, or underscores`,
        op,
        'providerId',
      );
    }

    if (!key || !CREDENTIAL_KEY_RE.test(key)) {
      throw new ValidationError(
        `Invalid credential key "${key}" — must be 1-128 characters (alphanumeric, _, ., /, -)`,
        op,
        'key',
      );
    }

    if (typeof value !== 'string' || value.length === 0) {
      throw new ValidationError(
        'Credential value must be a non-empty string',
        op,
        'value',
      );
    }
  }

  /**
   * Validates a vault file path.
   *
   * Rules:
   *  - Must be an absolute path
   *  - Must end with .enc
   *  - Must not contain path traversal sequences
   */
  static validateVaultPath(vaultPath: string): void {
    const op = 'validateVaultPath';

    if (!vaultPath || typeof vaultPath !== 'string') {
      throw new ValidationError('Vault path must be a non-empty string', op, 'vaultPath');
    }

    if (!path.isAbsolute(vaultPath)) {
      throw new ValidationError(
        `Vault path must be absolute, got: "${vaultPath}"`,
        op,
        'vaultPath',
      );
    }

    const normalized = path.normalize(vaultPath);
    if (normalized !== vaultPath) {
      throw new ValidationError(
        'Vault path must not contain path traversal sequences',
        op,
        'vaultPath',
      );
    }

    if (!vaultPath.endsWith('.enc')) {
      throw new ValidationError(
        'Vault path must end with .enc',
        op,
        'vaultPath',
      );
    }
  }

  /**
   * Validates an encryption key (must be a 32-byte Buffer).
   */
  static validateEncryptionKey(key: Buffer): void {
    const op = 'validateEncryptionKey';

    if (!Buffer.isBuffer(key)) {
      throw new ValidationError('Encryption key must be a Buffer', op, 'key');
    }

    if (key.length !== REQUIRED_KEY_BYTES) {
      throw new ValidationError(
        `Encryption key must be exactly ${REQUIRED_KEY_BYTES} bytes, got ${key.length}`,
        op,
        'key',
      );
    }
  }

  /**
   * Validates a passphrase for use in key derivation.
   *
   * Rules:
   *  - Minimum length enforced (12 characters)
   *  - Must not be composed entirely of whitespace
   */
  static validatePassphrase(passphrase: string): void {
    const op = 'validatePassphrase';

    if (typeof passphrase !== 'string' || passphrase.length === 0) {
      throw new ValidationError('Passphrase must be a non-empty string', op, 'passphrase');
    }

    if (passphrase.trim().length === 0) {
      throw new ValidationError(
        'Passphrase must not consist entirely of whitespace',
        op,
        'passphrase',
      );
    }

    if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
      throw new ValidationError(
        `Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters long`,
        op,
        'passphrase',
      );
    }
  }

  /**
   * Validates a provider ID in isolation (used by provider-registry in later phases).
   */
  static validateProviderId(providerId: string): void {
    const op = 'validateProviderId';
    if (!providerId || !PROVIDER_ID_RE.test(providerId)) {
      throw new ValidationError(
        `Invalid providerId "${providerId}" — must be 1-64 alphanumeric characters, hyphens, or underscores`,
        op,
        'providerId',
      );
    }
  }
}
