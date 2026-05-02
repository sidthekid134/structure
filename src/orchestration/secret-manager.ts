/**
 * SecretManager — encrypts and stores provider credentials in SQLite.
 *
 * Each secret is encrypted with a per-(provider,key) Argon2id-derived AES key,
 * with the masterPassphrase as input keying material and `${provider}:${key}`
 * as the salt source.
 *
 * Secrets table is maintained inside the same SQLite database as the
 * orchestration event log, accessed via the EventLog instance.
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { encrypt, decrypt, deriveKeyArgon2id } from '../encryption.js';
import { createOperationLogger } from '../logger.js';
import type { LoggingCallback } from '../types.js';
import type { ProviderType } from '../providers/types.js';

// ---------------------------------------------------------------------------
// Stored secret record
// ---------------------------------------------------------------------------

export interface StoredSecret {
  provider: ProviderType;
  key: string;
  encrypted_value: string;
  created_at: number;
}

// ---------------------------------------------------------------------------
// SecretManager
// ---------------------------------------------------------------------------

export class SecretManager {
  private readonly db: Database.Database;
  private readonly log: ReturnType<typeof createOperationLogger>;

  constructor(
    storeDir: string,
    private readonly masterPassphrase: string,
    loggingCallback?: LoggingCallback,
  ) {
    this.log = createOperationLogger('SecretManager', loggingCallback);

    fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
    const dbPath = path.join(storeDir, 'secrets.db');
    this.db = new Database(dbPath);
    try { fs.chmodSync(dbPath, 0o600); } catch { /* best-effort */ }

    this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  // ---------------------------------------------------------------------------
  // Schema
  // ---------------------------------------------------------------------------

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS secrets (
        provider        TEXT NOT NULL,
        key             TEXT NOT NULL,
        encrypted_value TEXT NOT NULL,
        created_at      INTEGER NOT NULL,
        PRIMARY KEY (provider, key)
      );
    `);
  }

  // ---------------------------------------------------------------------------
  // Derive per-secret encryption key
  // ---------------------------------------------------------------------------

  private async deriveSecretKey(provider: ProviderType, secretKey: string): Promise<Buffer> {
    // The "vault path" passed to Argon2id is just the salt source — using
    // `${provider}:${key}` here gives every secret its own derived key.
    const saltSource = `${provider}:${secretKey}`;
    return deriveKeyArgon2id(this.masterPassphrase, saltSource);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Encrypts a secret value and stores it under (provider, key).
   * Existing values are overwritten (upsert).
   */
  async storeSecret(provider: ProviderType, key: string, value: string): Promise<void> {
    if (!value) {
      this.log.warn('storeSecret called with empty value — skipping', { provider, key });
      return;
    }

    const encKey = await this.deriveSecretKey(provider, key);
    const encValue = encrypt(value, encKey, { providerId: provider });

    this.db
      .prepare(
        `INSERT OR REPLACE INTO secrets (provider, key, encrypted_value, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(provider, key, encValue, Date.now());

    this.log.debug('Secret stored', { provider, key });
  }

  /**
   * Retrieves and decrypts a secret.
   * Returns null if the secret does not exist.
   */
  async retrieveSecret(provider: ProviderType, key: string): Promise<string | null> {
    const row = this.db
      .prepare('SELECT encrypted_value FROM secrets WHERE provider = ? AND key = ?')
      .get(provider, key) as { encrypted_value: string } | undefined;

    if (!row) return null;

    const encKey = await this.deriveSecretKey(provider, key);
    try {
      return decrypt(row.encrypted_value, encKey, { providerId: provider });
    } catch {
      this.log.error('Failed to decrypt secret', { provider, key });
      return null;
    }
  }

  /**
   * Stores all credentials returned by a provider's extractCredentials().
   */
  async storeProviderCredentials(
    provider: ProviderType,
    credentials: Record<string, string>,
  ): Promise<string[]> {
    const stored: string[] = [];
    for (const [key, value] of Object.entries(credentials)) {
      try {
        await this.storeSecret(provider, key, value);
        stored.push(key);
      } catch (err) {
        this.log.error('Failed to store credential', {
          provider,
          key,
          error: (err as Error).message,
        });
      }
    }
    return stored;
  }

  /**
   * Returns the list of secret keys stored for a provider.
   */
  listSecrets(provider: ProviderType): string[] {
    const rows = this.db
      .prepare('SELECT key FROM secrets WHERE provider = ? ORDER BY key ASC')
      .all(provider) as Array<{ key: string }>;
    return rows.map(r => r.key);
  }

  close(): void {
    this.db.close();
  }
}
