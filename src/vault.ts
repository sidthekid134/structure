/**
 * VaultManager — encrypted vault file storage.
 *
 * The vault is stored as a single AES-256-GCM encrypted JSON file at the
 * path supplied by the caller (typically ~/.platform/credentials.enc).
 *
 * Atomic writes:
 *   1. Serialize and encrypt vault data.
 *   2. Write to a temp file in the same directory.
 *   3. fsync the temp file descriptor.
 *   4. Rename (atomic on POSIX) to the final path.
 *
 * This guarantees the vault file is never left in a partial/corrupt state.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  VAULT_SCHEMA_VERSION,
  VaultData,
  CredentialSchema,
  VaultError,
  LoggingCallback,
} from './types.js';
import { deriveKey, encrypt, decrypt } from './encryption.js';
import { InputValidator } from './validation.js';
import { createOperationLogger } from './logger.js';

export class VaultManager {
  private readonly vaultPath: string;
  private readonly logger: ReturnType<typeof createOperationLogger>;
  private readonly loggingCallback: LoggingCallback | undefined;

  constructor(vaultPath: string, loggingCallback?: LoggingCallback) {
    InputValidator.validateVaultPath(vaultPath);
    this.vaultPath = vaultPath;
    this.loggingCallback = loggingCallback;
    this.logger = createOperationLogger('VaultManager', loggingCallback);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Loads and decrypts the vault file.
   *
   * @param passphrase  Master passphrase used for key derivation.
   * @returns           Parsed VaultData.
   */
  loadVault(passphrase: string): VaultData {
    InputValidator.validatePassphrase(passphrase);

    this.logger.info('Loading vault', { vaultPath: this.vaultPath });

    if (!fs.existsSync(this.vaultPath)) {
      this.logger.info('Vault file not found — returning empty vault', {
        vaultPath: this.vaultPath,
      });
      return this.emptyVault();
    }

    let raw: string;
    try {
      raw = fs.readFileSync(this.vaultPath, 'utf8');
    } catch (err) {
      throw new VaultError(
        `Failed to read vault file: ${(err as NodeJS.ErrnoException).message}`,
        'loadVault',
        this.vaultPath,
        err,
      );
    }

    const key = deriveKey(passphrase, this.vaultPath);
    const plaintext = decrypt(raw.trim(), key, { logger: this.loggingCallback });

    let data: VaultData;
    try {
      data = JSON.parse(plaintext) as VaultData;
    } catch (err) {
      throw new VaultError(
        'Vault file contains invalid JSON after decryption',
        'loadVault',
        this.vaultPath,
        err,
      );
    }

    this.logger.info('Vault loaded successfully', {
      entryCount: Object.keys(data.entries).length,
    });
    return data;
  }

  /**
   * Encrypts and atomically writes the vault to disk.
   *
   * @param passphrase  Master passphrase used for key derivation.
   * @param data        VaultData to persist.
   */
  saveVault(passphrase: string, data: VaultData): void {
    InputValidator.validatePassphrase(passphrase);

    this.logger.info('Saving vault', {
      vaultPath: this.vaultPath,
      entryCount: Object.keys(data.entries).length,
    });

    // Ensure parent directory exists
    const dir = path.dirname(this.vaultPath);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      throw new VaultError(
        `Failed to create vault directory: ${(err as NodeJS.ErrnoException).message}`,
        'saveVault',
        this.vaultPath,
        err,
      );
    }

    const updated: VaultData = { ...data, updatedAt: Date.now() };
    const plaintext = JSON.stringify(updated);
    const key = deriveKey(passphrase, this.vaultPath);
    const ciphertext = encrypt(plaintext, key, { logger: this.loggingCallback });

    this.atomicWrite(ciphertext);

    this.logger.info('Vault saved successfully');
  }

  /**
   * Retrieves a single credential value from the vault.
   *
   * @param passphrase  Master passphrase.
   * @param providerId  Provider identifier (e.g., 'eas', 'github').
   * @param key         Credential field name.
   * @returns           The credential value, or undefined if not found.
   */
  getCredential(
    passphrase: string,
    providerId: string,
    key: string,
  ): string | undefined {
    InputValidator.validateProviderId(providerId);
    const data = this.loadVault(passphrase);
    return data.entries[providerId]?.credentials[key];
  }

  /**
   * Sets a credential value in the vault, then saves the vault atomically.
   *
   * @param passphrase  Master passphrase.
   * @param providerId  Provider identifier.
   * @param key         Credential field name.
   * @param value       Credential value (never logged).
   */
  setCredential(
    passphrase: string,
    providerId: string,
    key: string,
    value: string,
  ): void {
    InputValidator.validateCredentialInput(providerId, key, value);

    this.logger.info('Setting credential', { providerId, key });

    const data = this.loadVault(passphrase);

    const existing: CredentialSchema = data.entries[providerId] ?? {
      providerId,
      credentials: {},
      encryptedAt: Date.now(),
      version: VAULT_SCHEMA_VERSION,
    };

    const updated: CredentialSchema = {
      ...existing,
      credentials: { ...existing.credentials, [key]: value },
      encryptedAt: Date.now(),
    };

    const updatedData: VaultData = {
      ...data,
      entries: { ...data.entries, [providerId]: updated },
    };

    this.saveVault(passphrase, updatedData);
    this.logger.info('Credential set successfully', { providerId, key });
  }

  /**
   * Deletes a credential key from a provider entry.
   *
   * @returns true when a credential was removed, false when key/provider did not exist.
   */
  deleteCredential(
    passphrase: string,
    providerId: string,
    key: string,
  ): boolean {
    InputValidator.validatePassphrase(passphrase);
    InputValidator.validateProviderId(providerId);
    if (typeof key !== 'string' || key.trim().length === 0) {
      throw new VaultError('Credential key must be a non-empty string', 'deleteCredential', this.vaultPath);
    }

    const data = this.loadVault(passphrase);
    const existing = data.entries[providerId];
    if (!existing || !(key in existing.credentials)) {
      return false;
    }

    this.logger.info('Deleting credential', { providerId, key });
    const credentials = { ...existing.credentials };
    delete credentials[key];

    const entries = { ...data.entries };
    if (Object.keys(credentials).length === 0) {
      delete entries[providerId];
    } else {
      entries[providerId] = {
        ...existing,
        credentials,
        encryptedAt: Date.now(),
      };
    }

    this.saveVault(passphrase, { ...data, entries });
    this.logger.info('Credential deleted successfully', { providerId, key });
    return true;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private emptyVault(): VaultData {
    const now = Date.now();
    return {
      schemaVersion: VAULT_SCHEMA_VERSION,
      entries: {},
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Writes content to a temp file, fsyncs, then renames to the target path.
   * This is an atomic operation on POSIX file systems.
   */
  private atomicWrite(content: string): void {
    const dir = path.dirname(this.vaultPath);
    const tmpPath = path.join(dir, `.vault-tmp-${process.pid}-${Date.now()}.enc`);

    let fd: number | undefined;
    try {
      fd = fs.openSync(tmpPath, 'w', 0o600);
      fs.writeSync(fd, content, 0, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;

      fs.renameSync(tmpPath, this.vaultPath);
    } catch (err) {
      // Clean up temp file if rename failed
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }

      throw new VaultError(
        `Atomic write failed: ${(err as NodeJS.ErrnoException).message}`,
        'atomicWrite',
        this.vaultPath,
        err,
      );
    }
  }
}
