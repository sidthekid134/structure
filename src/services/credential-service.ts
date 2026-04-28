/**
 * CredentialService — unified credential storage, validation, and retrieval.
 *
 * Wraps CredentialStore with high-level methods for collecting, validating,
 * and managing credentials across all provider types.
 *
 * Key behaviors:
 *   - Plaintext values are never logged or returned from public methods.
 *   - Each credential type has exactly one active record per project
 *     (soft-delete via deletedAt; unique enforcement in application layer).
 *   - Decryption happens on-demand only when the credential is needed for an API call.
 */

import * as crypto from 'crypto';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { encrypt, decrypt, deriveKey } from '../encryption.js';
import { CredentialError } from '../types.js';

// ---------------------------------------------------------------------------
// Credential types
// ---------------------------------------------------------------------------

export type CredentialType =
  | 'github_pat'
  | 'cloudflare_token'
  | 'apple_p8'
  | 'apple_team_id'
  | 'google_play_key'
  | 'expo_token'
  | 'domain_name'
  // LLM provider API keys — one credential per (project, kind). Multi-instance
  // support (multiple keys per kind) lives on the per-instance provider ID
  // path in the SecretStore; this enum tracks the simple "one OpenAI per
  // project, one Anthropic per project" UX.
  | 'llm_openai_api_key'
  | 'llm_anthropic_api_key'
  | 'llm_gemini_api_key'
  | 'llm_custom_api_key';

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export interface StoredCredential {
  id: string;
  project_id: string;
  credential_type: CredentialType;
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface StoreCredentialInput {
  project_id: string;
  credential_type: CredentialType;
  value: string;
  metadata?: Record<string, unknown>;
}

export interface CredentialSummary {
  id: string;
  project_id: string;
  credential_type: CredentialType;
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// CredentialService
// ---------------------------------------------------------------------------

export class CredentialService {
  private readonly db: Database.Database;
  private readonly masterPassphrase: string;

  constructor(storeDir: string, masterPassphrase: string) {
    fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
    const dbPath = path.join(storeDir, 'project-credentials.db');
    this.db = new Database(dbPath);
    try { fs.chmodSync(dbPath, 0o600); } catch { /* best-effort */ }
    this.masterPassphrase = masterPassphrase;
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initSchema();
  }

  // ---------------------------------------------------------------------------
  // Schema
  // ---------------------------------------------------------------------------

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_credentials (
        id              TEXT PRIMARY KEY,
        project_id      TEXT NOT NULL,
        credential_type TEXT NOT NULL,
        encrypted_value TEXT NOT NULL,
        metadata_json   TEXT NOT NULL DEFAULT '{}',
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        deleted_at      INTEGER
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_project_cred_active
        ON project_credentials(project_id, credential_type)
        WHERE deleted_at IS NULL;

      CREATE INDEX IF NOT EXISTS idx_project_cred_project
        ON project_credentials(project_id);

      CREATE INDEX IF NOT EXISTS idx_project_cred_deleted
        ON project_credentials(deleted_at);
    `);
  }

  // ---------------------------------------------------------------------------
  // Encryption helpers
  // ---------------------------------------------------------------------------

  private encryptValue(value: string, credentialId: string): string {
    const key = deriveKey(this.masterPassphrase, `credential:${credentialId}`);
    return encrypt(value, key);
  }

  private decryptValue(encrypted: string, credentialId: string): string {
    const key = deriveKey(this.masterPassphrase, `credential:${credentialId}`);
    return decrypt(encrypted, key);
  }

  // ---------------------------------------------------------------------------
  // Store
  // ---------------------------------------------------------------------------

  /**
   * Encrypts and persists a credential for a project.
   * Soft-deletes any existing active credential of the same type first.
   */
  storeCredential(input: StoreCredentialInput): CredentialSummary {
    if (!input.value || input.value.trim().length === 0) {
      throw new CredentialError(
        'Credential value must not be empty.',
        'storeCredential',
      );
    }

    const now = Date.now();
    const id = crypto.randomUUID();
    const metadata = input.metadata ?? {};

    const existing = this.getActiveCredential(input.project_id, input.credential_type);
    if (existing) {
      this.db
        .prepare('UPDATE project_credentials SET deleted_at = ? WHERE id = ?')
        .run(now, existing.id);
    }

    const encryptedValue = this.encryptValue(input.value, id);

    this.db.prepare(`
      INSERT INTO project_credentials
        (id, project_id, credential_type, encrypted_value, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.project_id, input.credential_type, encryptedValue, JSON.stringify(metadata), now, now);

    return this.toSummary(id, input.project_id, input.credential_type, metadata, now, now);
  }

  // ---------------------------------------------------------------------------
  // Retrieve
  // ---------------------------------------------------------------------------

  /**
   * Retrieves the plaintext value of an active credential.
   * Only call when the value is immediately needed for an API call.
   * Returns null if no active credential exists for this type.
   */
  retrieveCredential(projectId: string, credentialType: CredentialType): string | null {
    const row = this.getActiveCredentialRow(projectId, credentialType);
    if (!row) return null;
    try {
      return this.decryptValue(row.encrypted_value, row.id);
    } catch {
      throw new CredentialError(
        `Failed to decrypt ${credentialType} credential for project ${projectId}. The credential may be corrupted — re-upload it.`,
        'retrieveCredential',
      );
    }
  }

  /**
   * Returns the summary (no plaintext) of an active credential.
   */
  getCredentialSummary(projectId: string, credentialType: CredentialType): CredentialSummary | null {
    const row = this.getActiveCredentialRow(projectId, credentialType);
    if (!row) return null;
    return this.toSummary(
      row.id,
      row.project_id,
      row.credential_type as CredentialType,
      JSON.parse(row.metadata_json) as Record<string, unknown>,
      row.created_at,
      row.updated_at,
    );
  }

  /**
   * Lists summaries of all active credentials for a project.
   */
  listCredentials(projectId: string): CredentialSummary[] {
    const rows = this.db
      .prepare('SELECT * FROM project_credentials WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at ASC')
      .all(projectId) as RawRow[];
    return rows.map((r) =>
      this.toSummary(
        r.id,
        r.project_id,
        r.credential_type as CredentialType,
        JSON.parse(r.metadata_json) as Record<string, unknown>,
        r.created_at,
        r.updated_at,
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------------------

  /**
   * Soft-deletes a credential by setting deleted_at.
   * The encrypted value is overwritten with random bytes before the record
   * is hard-deleted after 30 days.
   */
  deleteCredential(credentialId: string): void {
    const now = Date.now();
    const row = this.db
      .prepare('SELECT id FROM project_credentials WHERE id = ? AND deleted_at IS NULL')
      .get(credentialId) as { id: string } | undefined;

    if (!row) {
      throw new CredentialError(`Credential "${credentialId}" not found or already deleted.`, 'deleteCredential');
    }

    const randomBytes = crypto.randomBytes(64).toString('hex');
    this.db.prepare(`
      UPDATE project_credentials
         SET deleted_at = ?, encrypted_value = ?, updated_at = ?
       WHERE id = ?
    `).run(now, randomBytes, now, credentialId);
  }

  /**
   * Hard-deletes credentials that were soft-deleted more than 30 days ago.
   * Returns the number of records purged.
   */
  purgeOldDeletedCredentials(): number {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const result = this.db
      .prepare('DELETE FROM project_credentials WHERE deleted_at IS NOT NULL AND deleted_at < ?')
      .run(cutoff) as { changes: number };
    return result.changes;
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  /**
   * Validates a credential value according to type-specific rules.
   * Throws CredentialError with an actionable message if invalid.
   */
  validateCredential(type: CredentialType, value: string): void {
    switch (type) {
      case 'github_pat':
        this.validateGitHubPat(value);
        break;
      case 'cloudflare_token':
        this.validateCloudflareToken(value);
        break;
      case 'expo_token':
        this.validateExpoToken(value);
        break;
      case 'apple_team_id':
        this.validateAppleTeamId(value);
        break;
      case 'domain_name':
        this.validateDomainName(value);
        break;
      case 'apple_p8':
      case 'google_play_key':
        break;
      case 'llm_openai_api_key':
      case 'llm_anthropic_api_key':
      case 'llm_gemini_api_key':
      case 'llm_custom_api_key':
        this.validateLlmApiKey(type, value);
        break;
    }
  }

  private validateLlmApiKey(type: CredentialType, value: string): void {
    const trimmed = value.trim();
    if (trimmed.length < 10) {
      throw new CredentialError(
        `${type} appears too short. Paste the complete API key without surrounding whitespace.`,
        'validateLlmApiKey',
      );
    }
    if (trimmed.length > 4096) {
      throw new CredentialError(
        `${type} exceeds the 4KB limit; double-check you pasted only the key, not a JSON document.`,
        'validateLlmApiKey',
      );
    }
  }

  private validateGitHubPat(token: string): void {
    if (!token.startsWith('ghp_') && !token.startsWith('github_pat_')) {
      throw new CredentialError(
        'GitHub PAT must start with "ghp_" or "github_pat_". ' +
          'Generate a token at: https://github.com/settings/tokens',
        'validateGitHubPat',
      );
    }
    if (token.length < 40) {
      throw new CredentialError(
        'GitHub PAT appears too short. Ensure you copied the full token.',
        'validateGitHubPat',
      );
    }
  }

  private validateCloudflareToken(token: string): void {
    if (token.length < 30) {
      throw new CredentialError(
        'Cloudflare API token appears too short. ' +
          'Generate a token at: https://dash.cloudflare.com/profile/api-tokens',
        'validateCloudflareToken',
      );
    }
  }

  private validateExpoToken(token: string): void {
    if (token.length < 10) {
      throw new CredentialError(
        'Expo token appears too short. ' +
          'Get your token at: https://expo.dev/accounts/[account]/settings/access-tokens',
        'validateExpoToken',
      );
    }
  }

  private validateAppleTeamId(teamId: string): void {
    if (!/^[A-Z0-9]{10}$/.test(teamId.trim())) {
      throw new CredentialError(
        `Invalid Apple Team ID "${teamId}". Must be 10 uppercase alphanumeric characters.`,
        'validateAppleTeamId',
      );
    }
  }

  private validateDomainName(domain: string): void {
    const domainRegex = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
    if (!domainRegex.test(domain.trim())) {
      throw new CredentialError(
        `Invalid domain name "${domain}". Must be a valid hostname (e.g., example.com).`,
        'validateDomainName',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Cross-provider dependency check
  // ---------------------------------------------------------------------------

  /**
   * Checks that all required credential types exist for a project.
   * Returns an array of missing types (empty if all present).
   */
  checkMissingCredentials(
    projectId: string,
    requiredTypes: CredentialType[],
  ): CredentialType[] {
    return requiredTypes.filter(
      (type) => !this.getActiveCredential(projectId, type),
    );
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private getActiveCredential(projectId: string, credentialType: CredentialType): { id: string } | null {
    return (
      (this.db
        .prepare('SELECT id FROM project_credentials WHERE project_id = ? AND credential_type = ? AND deleted_at IS NULL')
        .get(projectId, credentialType) as { id: string } | undefined) ?? null
    );
  }

  private getActiveCredentialRow(projectId: string, credentialType: CredentialType): RawRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM project_credentials WHERE project_id = ? AND credential_type = ? AND deleted_at IS NULL')
        .get(projectId, credentialType) as RawRow | undefined) ?? null
    );
  }

  private toSummary(
    id: string,
    projectId: string,
    credentialType: CredentialType,
    metadata: Record<string, unknown>,
    createdAt: number,
    updatedAt: number,
  ): CredentialSummary {
    return { id, project_id: projectId, credential_type: credentialType, metadata, created_at: createdAt, updated_at: updatedAt };
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Internal row type
// ---------------------------------------------------------------------------

interface RawRow {
  id: string;
  project_id: string;
  credential_type: string;
  encrypted_value: string;
  metadata_json: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}
