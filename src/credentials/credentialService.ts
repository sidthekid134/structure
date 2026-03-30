/**
 * Credential Service — encrypted storage for provider credentials.
 *
 * Encryption: AES-256-GCM with a unique IV per credential.
 * Key:        Per-credential key derived from master key + projectId + credentialType.
 * Storage:    SQLite via better-sqlite3; IV and auth tag live in the metadata JSON column.
 *
 * Security invariants:
 *  - Plaintext never appears in logs, error messages, or DB queries.
 *  - Only one credential of each type per project (unique constraint).
 *  - Soft-delete overwrites ciphertext with random bytes before marking deleted_at.
 *  - Decryption only happens on-demand via retrieveCredential().
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { createOperationLogger } from '../logger.js';
import { CredentialError, ValidationError } from '../types.js';
import type { LoggingCallback } from '../types.js';

// ---------------------------------------------------------------------------
// Credential types
// ---------------------------------------------------------------------------

export const CREDENTIAL_TYPES = [
  'github_pat',
  'cloudflare_token',
  'apple_p8',
  'apple_team_id',
  'google_play_key',
  'expo_token',
  'domain_name',
] as const;

export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

// ---------------------------------------------------------------------------
// Encryption constants — AES-256-GCM
// ---------------------------------------------------------------------------

const ALGORITHM = 'aes-256-gcm' as const;
const KEY_LENGTH = 32; // bytes (AES-256)
const IV_LENGTH = 16;  // bytes

// ---------------------------------------------------------------------------
// Metadata stored alongside each credential
// ---------------------------------------------------------------------------

export interface CredentialMetadata {
  /** Hex-encoded 16-byte IV used during encryption. */
  iv: string;
  /** Hex-encoded 16-byte GCM authentication tag. */
  authTag: string;
  /** SHA-256 hash of file content (used for Apple .p8 uploads). */
  fileHash?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Database row shape returned by better-sqlite3
// ---------------------------------------------------------------------------

interface CredentialRow {
  id: string;
  project_id: string;
  credential_type: CredentialType;
  encrypted_value: Buffer;
  metadata: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

// ---------------------------------------------------------------------------
// Type-specific validators
// ---------------------------------------------------------------------------

function validateGitHubPAT(value: string): void {
  // Fine-grained PATs start with github_pat_; classic tokens are 40 hex chars;
  // OAuth / server tokens start with gho_, ghs_, ghu_, or ghp_.
  const finegrained = /^github_pat_[A-Za-z0-9_]{20,}$/;
  const classic = /^[0-9a-fA-F]{40}$/;
  const prefixed = /^gh[opsu]_[A-Za-z0-9_]{36,}$/;

  if (!finegrained.test(value) && !classic.test(value) && !prefixed.test(value)) {
    throw new ValidationError(
      'Invalid GitHub PAT format — expected a fine-grained token (github_pat_…), ' +
        'a classic 40-char hex token, or a prefixed token (ghp_…/gho_…/ghu_…/ghs_…)',
      'validateGitHubPAT',
      'value',
    );
  }
}

function validateCloudflareToken(value: string): void {
  // Cloudflare API tokens are 40-char base64url strings
  if (!/^[A-Za-z0-9_-]{40}$/.test(value)) {
    throw new ValidationError(
      'Invalid Cloudflare token format — expected a 40-character alphanumeric/base64url token',
      'validateCloudflareToken',
      'value',
    );
  }
}

function validateAppleP8(value: string): void {
  // Apple .p8 keys are PEM-encoded EC private keys
  if (
    !value.includes('-----BEGIN PRIVATE KEY-----') &&
    !value.includes('-----BEGIN EC PRIVATE KEY-----')
  ) {
    throw new ValidationError(
      'Invalid Apple .p8 key — must contain a PEM-encoded private key block ' +
        '(-----BEGIN PRIVATE KEY----- or -----BEGIN EC PRIVATE KEY-----)',
      'validateAppleP8',
      'value',
    );
  }
}

function validateAppleTeamId(value: string): void {
  // Apple Team IDs are exactly 10 uppercase alphanumeric characters
  if (!/^[A-Z0-9]{10}$/.test(value)) {
    throw new ValidationError(
      'Invalid Apple Team ID — must be exactly 10 uppercase alphanumeric characters',
      'validateAppleTeamId',
      'value',
    );
  }
}

function validateGooglePlayKey(value: string): void {
  // Google Play service account JSON must have type, private_key, and client_email
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(value) as Record<string, unknown>;
  } catch {
    throw new ValidationError(
      'Invalid Google Play key — must be valid JSON',
      'validateGooglePlayKey',
      'value',
    );
  }

  if (
    parsed['type'] !== 'service_account' ||
    typeof parsed['private_key'] !== 'string' ||
    typeof parsed['client_email'] !== 'string'
  ) {
    throw new ValidationError(
      'Invalid Google Play key — service account JSON must contain type="service_account", private_key, and client_email',
      'validateGooglePlayKey',
      'value',
    );
  }
}

function validateExpoToken(value: string): void {
  // Expo access tokens: start with expo_ or are ≥32-char alphanumeric strings
  if (!/^expo_[A-Za-z0-9_-]{30,}$/.test(value) && !/^[A-Za-z0-9._-]{32,}$/.test(value)) {
    throw new ValidationError(
      'Invalid Expo token format — expected a token starting with expo_ (≥30 chars) or a ≥32-char access token',
      'validateExpoToken',
      'value',
    );
  }
}

function validateDomainName(value: string): void {
  // RFC-1123 hostname pattern with at least one dot and a valid TLD
  const domainRe = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
  if (!domainRe.test(value)) {
    throw new ValidationError(
      `Invalid domain name "${value}" — must be a valid fully-qualified domain name`,
      'validateDomainName',
      'value',
    );
  }
}

// ---------------------------------------------------------------------------
// CredentialService
// ---------------------------------------------------------------------------

export class CredentialService {
  private readonly db: Database.Database;
  private readonly log: ReturnType<typeof createOperationLogger>;
  private readonly masterKey: Buffer;

  /**
   * @param dbPath          Absolute path to the SQLite database file.
   * @param masterPassphrase Master passphrase used to derive per-credential keys.
   * @param loggingCallback Optional structured logging callback.
   */
  constructor(dbPath: string, masterPassphrase: string, loggingCallback?: LoggingCallback) {
    this.log = createOperationLogger('CredentialService', loggingCallback);
    this.masterKey = this.deriveMasterKey(masterPassphrase, dbPath);

    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.runMigrations();
  }

  // ---------------------------------------------------------------------------
  // Schema migration (idempotent)
  // ---------------------------------------------------------------------------

  private runMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS credentials (
        id              TEXT PRIMARY KEY,
        project_id      TEXT NOT NULL,
        credential_type TEXT NOT NULL CHECK (
          credential_type IN (
            'github_pat', 'cloudflare_token', 'apple_p8',
            'apple_team_id', 'google_play_key', 'expo_token', 'domain_name'
          )
        ),
        encrypted_value BLOB NOT NULL,
        metadata        TEXT NOT NULL DEFAULT '{}',
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        deleted_at      TEXT,
        UNIQUE (project_id, credential_type)
      );
      CREATE INDEX IF NOT EXISTS idx_credentials_project_type
        ON credentials (project_id, credential_type);
      CREATE INDEX IF NOT EXISTS idx_credentials_deleted_at
        ON credentials (deleted_at);
    `);
  }

  // ---------------------------------------------------------------------------
  // Key derivation
  // ---------------------------------------------------------------------------

  /**
   * Derives the master key from the passphrase and DB path.
   * SHA-256(passphrase + ":" + dbPath) → 32 bytes.
   */
  private deriveMasterKey(passphrase: string, dbPath: string): Buffer {
    return crypto
      .createHash('sha256')
      .update(`${passphrase}:${dbPath}`, 'utf8')
      .digest();
  }

  /**
   * Derives a per-credential AES key by hashing the master key with the
   * project ID and credential type so each credential is encrypted under a
   * distinct key.
   */
  private deriveCredentialKey(projectId: string, credentialType: CredentialType): Buffer {
    return crypto
      .createHash('sha256')
      .update(
        Buffer.concat([
          this.masterKey,
          Buffer.from(`:${projectId}:${credentialType}`, 'utf8'),
        ]),
      )
      .digest();
  }

  // ---------------------------------------------------------------------------
  // Encrypt / Decrypt — AES-256-GCM
  // IV and auth tag are returned separately so callers can store them in metadata.
  // ---------------------------------------------------------------------------

  /**
   * Encrypts a plaintext string using AES-256-GCM.
   * Returns the raw ciphertext buffer plus the hex-encoded IV and auth tag
   * that must be stored in the metadata column (not alongside the ciphertext).
   *
   * Plaintext is never returned or logged by this method.
   */
  encrypt(
    value: string,
    projectId: string,
    credentialType: CredentialType,
  ): { ciphertext: Buffer; iv: string; authTag: string } {
    if (!value) {
      throw new CredentialError('Value must not be empty', 'encrypt');
    }

    const key = this.deriveCredentialKey(projectId, credentialType);
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      ciphertext,
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex'),
    };
  }

  /**
   * Decrypts a credential ciphertext using the IV and auth tag from metadata.
   * Called only on-demand when the plaintext is needed for an API call.
   */
  decrypt(
    ciphertext: Buffer,
    iv: string,
    authTag: string,
    projectId: string,
    credentialType: CredentialType,
  ): string {
    const key = this.deriveCredentialKey(projectId, credentialType);
    try {
      const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'));
      decipher.setAuthTag(Buffer.from(authTag, 'hex'));
      return decipher.update(ciphertext).toString('utf8') + decipher.final().toString('utf8');
    } catch {
      throw new CredentialError(
        'Decryption failed — wrong passphrase or corrupted credential',
        'decrypt',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  /**
   * Validates a credential value for a given type.
   * Throws {@link ValidationError} with a descriptive message on failure.
   */
  validateCredential(type: CredentialType, value: string): void {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new ValidationError(
        'Credential value must be a non-empty string',
        'validateCredential',
        'value',
      );
    }

    switch (type) {
      case 'github_pat':       validateGitHubPAT(value);       break;
      case 'cloudflare_token': validateCloudflareToken(value);  break;
      case 'apple_p8':         validateAppleP8(value);          break;
      case 'apple_team_id':    validateAppleTeamId(value);      break;
      case 'google_play_key':  validateGooglePlayKey(value);    break;
      case 'expo_token':       validateExpoToken(value);        break;
      case 'domain_name':      validateDomainName(value);       break;
      default: {
        const exhaustive: never = type;
        throw new ValidationError(`Unknown credential type: ${exhaustive}`, 'validateCredential', 'type');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Store
  // ---------------------------------------------------------------------------

  /**
   * Validates, encrypts, and persists a credential.
   * If an active credential of the same type already exists for the project,
   * it is updated in place (unique constraint allows only one per project+type).
   *
   * @returns The credential ID (UUID). Plaintext is never returned.
   */
  storeCredential(
    projectId: string,
    type: CredentialType,
    value: string,
    extraMetadata: Record<string, unknown> = {},
  ): string {
    this.validateCredential(type, value);

    const { ciphertext, iv, authTag } = this.encrypt(value, projectId, type);
    const now = new Date().toISOString();
    const metadata: CredentialMetadata = { iv, authTag, ...extraMetadata };
    const metadataJson = JSON.stringify(metadata);

    // Check for an existing active credential first
    const existingActive = this.db
      .prepare(
        'SELECT id FROM credentials WHERE project_id = ? AND credential_type = ? AND deleted_at IS NULL',
      )
      .get(projectId, type) as { id: string } | undefined;

    if (existingActive) {
      this.db
        .prepare(
          'UPDATE credentials SET encrypted_value = ?, metadata = ?, updated_at = ? WHERE id = ?',
        )
        .run(ciphertext, metadataJson, now, existingActive.id);

      this.log.info('Credential updated', { projectId, credentialType: type });
      return existingActive.id;
    }

    // Remove any soft-deleted row for the same (project, type) pair so the
    // UNIQUE constraint doesn't block the fresh insert below.
    this.db
      .prepare(
        'DELETE FROM credentials WHERE project_id = ? AND credential_type = ? AND deleted_at IS NOT NULL',
      )
      .run(projectId, type);

    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO credentials
           (id, project_id, credential_type, encrypted_value, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, projectId, type, ciphertext, metadataJson, now, now);

    this.log.info('Credential stored', { projectId, credentialType: type });
    return id;
  }

  // ---------------------------------------------------------------------------
  // Retrieve
  // ---------------------------------------------------------------------------

  /**
   * Decrypts and returns a credential value on-demand.
   * Access is audit-logged (credential ID and type only — no plaintext).
   *
   * @throws {@link CredentialError} if the credential does not exist or is deleted.
   */
  retrieveCredential(credentialId: string): string {
    const row = this.db
      .prepare('SELECT * FROM credentials WHERE id = ? AND deleted_at IS NULL')
      .get(credentialId) as CredentialRow | undefined;

    if (!row) {
      throw new CredentialError(
        `Credential not found or has been deleted: ${credentialId}`,
        'retrieveCredential',
      );
    }

    const meta = JSON.parse(row.metadata) as CredentialMetadata;
    const plaintext = this.decrypt(
      row.encrypted_value,
      meta.iv,
      meta.authTag,
      row.project_id,
      row.credential_type,
    );

    // Audit log: only IDs and types, never plaintext
    this.log.info('Credential accessed', {
      credentialId,
      credentialType: row.credential_type,
      projectId: row.project_id,
    });

    return plaintext;
  }

  // ---------------------------------------------------------------------------
  // Delete (soft-delete with ciphertext overwrite)
  // ---------------------------------------------------------------------------

  /**
   * Soft-deletes a credential.
   *
   * Before setting deleted_at, the encrypted_value column is overwritten with
   * cryptographically random bytes of the same length so the original ciphertext
   * cannot be recovered even from a database snapshot taken after this call.
   *
   * Hard deletion (removing the row entirely) should be scheduled ≥30 days after
   * deleted_at to preserve the audit trail.
   *
   * @throws {@link CredentialError} if the credential does not exist or is already deleted.
   */
  deleteCredential(credentialId: string): void {
    const row = this.db
      .prepare('SELECT id, credential_type, encrypted_value FROM credentials WHERE id = ? AND deleted_at IS NULL')
      .get(credentialId) as Pick<CredentialRow, 'id' | 'credential_type' | 'encrypted_value'> | undefined;

    if (!row) {
      throw new CredentialError(
        `Credential not found or already deleted: ${credentialId}`,
        'deleteCredential',
      );
    }

    const now = new Date().toISOString();
    // Overwrite with random bytes of the same length (or 32 bytes minimum)
    const originalLen = Buffer.isBuffer(row.encrypted_value) ? row.encrypted_value.length : 32;
    const randomBytes = crypto.randomBytes(Math.max(originalLen, 32));

    this.db
      .prepare(
        'UPDATE credentials SET encrypted_value = ?, deleted_at = ?, updated_at = ? WHERE id = ?',
      )
      .run(randomBytes, now, now, credentialId);

    this.log.info('Credential soft-deleted', {
      credentialId,
      credentialType: row.credential_type,
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Purges credentials that were soft-deleted more than {@link daysOld} days ago.
   * Call from a scheduled job to enforce the 30-day hard-delete policy.
   */
  purgeExpiredCredentials(daysOld = 30): number {
    const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db
      .prepare('DELETE FROM credentials WHERE deleted_at IS NOT NULL AND deleted_at <= ?')
      .run(cutoff);
    const count = result.changes;

    if (count > 0) {
      this.log.info('Purged expired credentials', { count, cutoffDate: cutoff });
    }

    return count;
  }

  /**
   * Returns true if an active (non-deleted) credential of the given type exists
   * for the specified project. Used by dependency checking logic.
   */
  hasCredential(projectId: string, type: CredentialType): boolean {
    const row = this.db
      .prepare(
        'SELECT id FROM credentials WHERE project_id = ? AND credential_type = ? AND deleted_at IS NULL',
      )
      .get(projectId, type);
    return row !== undefined;
  }

  /**
   * Returns the credential ID for an active credential of the given type, or
   * undefined if none exists. Used for file-hash duplicate detection.
   */
  findCredentialMetadata(
    projectId: string,
    type: CredentialType,
  ): { id: string; metadata: string } | undefined {
    return this.db
      .prepare(
        'SELECT id, metadata FROM credentials WHERE project_id = ? AND credential_type = ? AND deleted_at IS NULL',
      )
      .get(projectId, type) as { id: string; metadata: string } | undefined;
  }

  /** Closes the underlying SQLite connection. */
  close(): void {
    this.db.close();
  }
}
