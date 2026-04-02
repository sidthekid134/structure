/**
 * CredentialStore — SQLite-backed storage for Firebase auth configs, OAuth
 * clients, provider credentials, and OAuth session state.
 *
 * Sensitive fields are encrypted with AES-256-GCM before persistence.
 * The encryption key is derived from the master passphrase unique to each row.
 *
 * Schema tables:
 *   firebase_auth_configs   — per-project Firebase Identity Toolkit state
 *   oauth_clients           — OAuth2 client credentials (Google / Apple)
 *   provider_credentials    — generic encrypted credential blobs (APNs, Play, etc.)
 *   oauth_sessions          — short-lived OAuth session state (CSRF protection)
 */

import * as crypto from 'crypto';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { encrypt, decrypt, deriveKey } from '../encryption.js';
import type {
  FirebaseAuthConfig,
  FirebaseAuthConfigCreate,
  FirebaseAuthConfigUpdate,
  OAuthClient,
  OAuthClientCreate,
  OAuthClientPublic,
  ProviderCredential,
  ProviderCredentialCreate,
  OAuthSessionState,
  OAuthProvider,
} from '../models/firebase-auth-config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uuid(): string {
  return crypto.randomUUID();
}

function maskSecret(secret: string): string {
  if (secret.length <= 8) return '****';
  return `${secret.slice(0, 4)}${'*'.repeat(Math.max(8, secret.length - 8))}${secret.slice(-4)}`;
}

function hashCredential(data: string): string {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// CredentialStore
// ---------------------------------------------------------------------------

export class CredentialStore {
  private readonly db: Database.Database;
  private readonly masterPassphrase: string;

  constructor(storeDir: string, masterPassphrase: string) {
    fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
    const dbPath = path.join(storeDir, 'credentials.db');
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
      CREATE TABLE IF NOT EXISTS firebase_auth_configs (
        id                          TEXT PRIMARY KEY,
        project_id                  TEXT NOT NULL UNIQUE,
        identity_toolkit_enabled    INTEGER NOT NULL DEFAULT 0,
        encrypted_config            TEXT,
        apns_configured             INTEGER NOT NULL DEFAULT 0,
        play_fingerprint_configured INTEGER NOT NULL DEFAULT 0,
        created_at                  INTEGER NOT NULL,
        updated_at                  INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_firebase_auth_project
        ON firebase_auth_configs(project_id);

      CREATE TABLE IF NOT EXISTS oauth_clients (
        id                      TEXT PRIMARY KEY,
        firebase_config_id      TEXT NOT NULL
          REFERENCES firebase_auth_configs(id) ON DELETE CASCADE,
        provider                TEXT NOT NULL,
        client_id               TEXT NOT NULL,
        encrypted_client_secret TEXT NOT NULL,
        redirect_uris_json      TEXT NOT NULL DEFAULT '[]',
        created_at              INTEGER NOT NULL,
        updated_at              INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_oauth_clients_config
        ON oauth_clients(firebase_config_id);

      CREATE TABLE IF NOT EXISTS provider_credentials (
        id                       TEXT PRIMARY KEY,
        project_id               TEXT NOT NULL,
        provider_type            TEXT NOT NULL,
        encrypted_credential_data TEXT NOT NULL,
        credential_hash          TEXT NOT NULL,
        expires_at               INTEGER,
        created_at               INTEGER NOT NULL,
        updated_at               INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_provider_creds_project_type
        ON provider_credentials(project_id, provider_type);

      CREATE TABLE IF NOT EXISTS oauth_sessions (
        id           TEXT PRIMARY KEY,
        project_id   TEXT NOT NULL,
        provider     TEXT NOT NULL,
        state_token  TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        expires_at   INTEGER NOT NULL,
        completed    INTEGER NOT NULL DEFAULT 0,
        access_token TEXT,
        created_at   INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_oauth_sessions_project
        ON oauth_sessions(project_id, provider);
    `);
  }

  // ---------------------------------------------------------------------------
  // Encryption helpers
  // ---------------------------------------------------------------------------

  private encryptField(value: string, context: string): string {
    const key = deriveKey(this.masterPassphrase, context);
    return encrypt(value, key);
  }

  private decryptField(encrypted: string, context: string): string {
    const key = deriveKey(this.masterPassphrase, context);
    return decrypt(encrypted, key);
  }

  // ---------------------------------------------------------------------------
  // Firebase Auth Configs
  // ---------------------------------------------------------------------------

  upsertFirebaseAuthConfig(input: FirebaseAuthConfigCreate): FirebaseAuthConfig {
    const existing = this.db
      .prepare('SELECT * FROM firebase_auth_configs WHERE project_id = ?')
      .get(input.project_id) as FirebaseAuthConfig | undefined;

    const now = Date.now();

    if (existing) {
      this.db.prepare(`
        UPDATE firebase_auth_configs
           SET identity_toolkit_enabled = ?, updated_at = ?
         WHERE project_id = ?
      `).run(
        input.identity_toolkit_enabled ? 1 : (existing.identity_toolkit_enabled ? 1 : 0),
        now,
        input.project_id,
      );
      return this.getFirebaseAuthConfig(input.project_id)!;
    }

    const id = uuid();
    this.db.prepare(`
      INSERT INTO firebase_auth_configs
        (id, project_id, identity_toolkit_enabled, encrypted_config, apns_configured, play_fingerprint_configured, created_at, updated_at)
      VALUES (?, ?, ?, NULL, 0, 0, ?, ?)
    `).run(id, input.project_id, input.identity_toolkit_enabled ? 1 : 0, now, now);

    return this.getFirebaseAuthConfig(input.project_id)!;
  }

  getFirebaseAuthConfig(projectId: string): FirebaseAuthConfig | null {
    const row = this.db
      .prepare('SELECT * FROM firebase_auth_configs WHERE project_id = ?')
      .get(projectId) as (Omit<FirebaseAuthConfig, 'identity_toolkit_enabled' | 'apns_configured' | 'play_fingerprint_configured'> & {
        identity_toolkit_enabled: number;
        apns_configured: number;
        play_fingerprint_configured: number;
      }) | undefined;

    if (!row) return null;
    return {
      ...row,
      identity_toolkit_enabled: row.identity_toolkit_enabled === 1,
      apns_configured: row.apns_configured === 1,
      play_fingerprint_configured: row.play_fingerprint_configured === 1,
    };
  }

  updateFirebaseAuthConfig(projectId: string, update: FirebaseAuthConfigUpdate): FirebaseAuthConfig {
    const now = Date.now();
    const sets: string[] = ['updated_at = ?'];
    const params: (string | number | null)[] = [now];

    if (update.identity_toolkit_enabled !== undefined) {
      sets.push('identity_toolkit_enabled = ?');
      params.push(update.identity_toolkit_enabled ? 1 : 0);
    }
    if (update.encrypted_config !== undefined) {
      sets.push('encrypted_config = ?');
      params.push(update.encrypted_config);
    }
    if (update.apns_configured !== undefined) {
      sets.push('apns_configured = ?');
      params.push(update.apns_configured ? 1 : 0);
    }
    if (update.play_fingerprint_configured !== undefined) {
      sets.push('play_fingerprint_configured = ?');
      params.push(update.play_fingerprint_configured ? 1 : 0);
    }

    params.push(projectId);
    this.db.prepare(`UPDATE firebase_auth_configs SET ${sets.join(', ')} WHERE project_id = ?`).run(...params);
    return this.getFirebaseAuthConfig(projectId)!;
  }

  // ---------------------------------------------------------------------------
  // OAuth Clients
  // ---------------------------------------------------------------------------

  createOAuthClient(input: OAuthClientCreate): OAuthClientPublic {
    const now = Date.now();
    const id = uuid();
    const context = `oauth_client:${id}`;
    const encryptedSecret = this.encryptField(input.client_secret, context);

    this.db.prepare(`
      INSERT INTO oauth_clients
        (id, firebase_config_id, provider, client_id, encrypted_client_secret, redirect_uris_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.firebase_config_id,
      input.provider,
      input.client_id,
      encryptedSecret,
      JSON.stringify(input.redirect_uris),
      now,
      now,
    );

    return this.toPublicOAuthClient(id, input.client_id, input.provider, input.firebase_config_id, input.redirect_uris, input.client_secret, now, now);
  }

  private toPublicOAuthClient(
    id: string,
    clientId: string,
    provider: OAuthProvider,
    firebaseConfigId: string,
    redirectUris: string[],
    plainSecret: string,
    createdAt: number,
    updatedAt: number,
  ): OAuthClientPublic {
    return {
      id,
      firebase_config_id: firebaseConfigId,
      provider,
      client_id: clientId,
      masked_client_secret: maskSecret(plainSecret),
      redirect_uris: redirectUris,
      created_at: createdAt,
      updated_at: updatedAt,
    };
  }

  listOAuthClients(firebaseConfigId: string): OAuthClientPublic[] {
    const rows = this.db
      .prepare('SELECT * FROM oauth_clients WHERE firebase_config_id = ?')
      .all(firebaseConfigId) as Array<{
        id: string;
        firebase_config_id: string;
        provider: OAuthProvider;
        client_id: string;
        encrypted_client_secret: string;
        redirect_uris_json: string;
        created_at: number;
        updated_at: number;
      }>;

    return rows.map(r => ({
      id: r.id,
      firebase_config_id: r.firebase_config_id,
      provider: r.provider,
      client_id: r.client_id,
      masked_client_secret: '****',
      redirect_uris: JSON.parse(r.redirect_uris_json) as string[],
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
  }

  getDecryptedClientSecret(oauthClientId: string): string | null {
    const row = this.db
      .prepare('SELECT encrypted_client_secret FROM oauth_clients WHERE id = ?')
      .get(oauthClientId) as { encrypted_client_secret: string } | undefined;
    if (!row) return null;
    try {
      return this.decryptField(row.encrypted_client_secret, `oauth_client:${oauthClientId}`);
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Provider Credentials
  // ---------------------------------------------------------------------------

  storeProviderCredential(input: ProviderCredentialCreate): ProviderCredential {
    const now = Date.now();
    const id = uuid();
    const dataJson = JSON.stringify(input.credential_data);
    const credentialHash = hashCredential(dataJson);
    const context = `provider_cred:${id}`;
    const encryptedData = this.encryptField(dataJson, context);

    this.db.prepare(`
      INSERT INTO provider_credentials
        (id, project_id, provider_type, encrypted_credential_data, credential_hash, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.project_id,
      input.provider_type,
      encryptedData,
      credentialHash,
      input.expires_at ?? null,
      now,
      now,
    );

    return this.getProviderCredential(id)!;
  }

  getProviderCredential(credentialId: string): ProviderCredential | null {
    const row = this.db
      .prepare('SELECT * FROM provider_credentials WHERE id = ?')
      .get(credentialId) as ProviderCredential | undefined;
    return row ?? null;
  }

  getProviderCredentialByType(projectId: string, providerType: string): ProviderCredential | null {
    const row = this.db
      .prepare('SELECT * FROM provider_credentials WHERE project_id = ? AND provider_type = ? ORDER BY created_at DESC LIMIT 1')
      .get(projectId, providerType) as ProviderCredential | undefined;
    return row ?? null;
  }

  decryptProviderCredential(credentialId: string): Record<string, unknown> | null {
    const row = this.db
      .prepare('SELECT encrypted_credential_data FROM provider_credentials WHERE id = ?')
      .get(credentialId) as { encrypted_credential_data: string } | undefined;
    if (!row) return null;
    try {
      const json = this.decryptField(row.encrypted_credential_data, `provider_cred:${credentialId}`);
      return JSON.parse(json) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  isDuplicateCredential(projectId: string, providerType: string, credentialData: Record<string, unknown>): boolean {
    const hash = hashCredential(JSON.stringify(credentialData));
    const row = this.db
      .prepare('SELECT id FROM provider_credentials WHERE project_id = ? AND provider_type = ? AND credential_hash = ?')
      .get(projectId, providerType, hash);
    return !!row;
  }

  // ---------------------------------------------------------------------------
  // OAuth Sessions
  // ---------------------------------------------------------------------------

  createOAuthSession(
    projectId: string,
    provider: OAuthProvider,
    redirectUri: string,
    ttlSeconds = 3600,
  ): OAuthSessionState {
    const now = Date.now();
    const id = uuid();
    const stateToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = now + ttlSeconds * 1000;

    this.db.prepare(`
      INSERT INTO oauth_sessions
        (id, project_id, provider, state_token, redirect_uri, expires_at, completed, access_token, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?)
    `).run(id, projectId, provider, stateToken, redirectUri, expiresAt, now);

    return {
      id,
      project_id: projectId,
      provider,
      state_token: stateToken,
      redirect_uri: redirectUri,
      expires_at: expiresAt,
      completed: false,
      access_token: null,
      created_at: now,
    };
  }

  getOAuthSession(sessionId: string): OAuthSessionState | null {
    const row = this.db
      .prepare('SELECT * FROM oauth_sessions WHERE id = ?')
      .get(sessionId) as (Omit<OAuthSessionState, 'completed'> & { completed: number }) | undefined;
    if (!row) return null;
    return { ...row, completed: row.completed === 1 };
  }

  validateAndCompleteOAuthSession(sessionId: string, stateToken: string, accessToken: string): boolean {
    const session = this.getOAuthSession(sessionId);
    if (!session) return false;
    if (session.completed) return false;
    if (session.expires_at < Date.now()) return false;
    if (session.state_token !== stateToken) return false;

    this.db.prepare(`
      UPDATE oauth_sessions SET completed = 1, access_token = ? WHERE id = ?
    `).run(accessToken, sessionId);
    return true;
  }

  cleanupExpiredSessions(): number {
    const result = this.db
      .prepare('DELETE FROM oauth_sessions WHERE expires_at < ?')
      .run(Date.now()) as { changes: number };
    return result.changes;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  close(): void {
    this.db.close();
  }
}
