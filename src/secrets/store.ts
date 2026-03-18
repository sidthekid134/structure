/**
 * Secret management with environment scoping and encryption.
 *
 * Secrets are stored encrypted at rest using the existing AES-256-GCM encrypt()
 * function. The encryption key is derived per-secret using a scoped derivation:
 *   SHA-256(masterPassphrase + providerId + environment + secretName)
 *
 * Scoping rules:
 *   - dev and preview environments SHARE secrets (same vault entry)
 *   - prod is ISOLATED — a secret cannot exist in both prod and dev/preview
 *
 * Authorization:
 *   - Each operation requires an appId and ownerId/collaborators check
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { encrypt, decrypt } from '../encryption.js';
import { createOperationLogger } from '../logger.js';
import type { LoggingCallback } from '../types.js';
import { ValidationError, CredentialError } from '../types.js';
import type { Environment, ProviderType } from '../providers/types.js';
import { PROVIDER_SECRET_SCHEMAS } from '../core/provider-schemas.js';

// ---------------------------------------------------------------------------
// Scoping rule: dev and preview share the same scope key
// ---------------------------------------------------------------------------

function scopeKey(environment: Environment): 'shared' | 'prod' {
  return environment === 'prod' ? 'prod' : 'shared';
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

export interface AppAuthorization {
  appId: string;
  ownerId: string;
  collaboratorIds: string[];
}

export class AuthorizationError extends CredentialError {
  constructor(userId: string, appId: string) {
    super(
      `User "${userId}" does not have access to app "${appId}"`,
      'authorizeAccess',
    );
    this.name = 'AuthorizationError';
  }
}

// ---------------------------------------------------------------------------
// Secret validator
// ---------------------------------------------------------------------------

export class SecretValidator {
  static validate(
    providerId: ProviderType,
    secretName: string,
    value: string,
  ): void {
    const validNames = PROVIDER_SECRET_SCHEMAS[providerId];
    if (!validNames) {
      throw new ValidationError(
        `Unknown provider "${providerId}". Valid providers: ${Object.keys(PROVIDER_SECRET_SCHEMAS).join(', ')}`,
        'validateSecret',
        'providerId',
      );
    }

    if (!validNames.includes(secretName)) {
      throw new ValidationError(
        `Invalid secret name "${secretName}" for provider "${providerId}". ` +
          `Valid names: ${validNames.join(', ')}`,
        'validateSecret',
        'secretName',
      );
    }

    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new ValidationError(
        'Secret value must be a non-empty string',
        'validateSecret',
        'value',
      );
    }
  }

  static validateProvider(providerId: ProviderType): void {
    if (!PROVIDER_SECRET_SCHEMAS[providerId]) {
      throw new ValidationError(
        `Unknown provider "${providerId}"`,
        'validateProvider',
        'providerId',
      );
    }
  }

  static getValidNames(providerId: ProviderType): string[] {
    return [...(PROVIDER_SECRET_SCHEMAS[providerId] ?? [])];
  }
}

// ---------------------------------------------------------------------------
// Secret scoper
// ---------------------------------------------------------------------------

export class SecretScoper {
  /**
   * Enforces the prod isolation rule: a secret cannot exist in both prod and
   * the dev/preview scope.
   */
  static assertNotCrossScoped(
    entries: SecretStoreEntries,
    providerId: ProviderType,
    secretName: string,
    targetEnvironment: Environment,
  ): void {
    const targetScope = scopeKey(targetEnvironment);
    const otherScope = targetScope === 'prod' ? 'shared' : 'prod';
    const otherKey = SecretStore.entryKey(providerId, secretName, otherScope);

    if (entries[otherKey]) {
      throw new ValidationError(
        `Secret "${secretName}" for provider "${providerId}" already exists in ` +
          `${otherScope === 'prod' ? 'production' : 'dev/preview'} scope. ` +
          `Production secrets are isolated from dev/preview environments. ` +
          `Delete the other entry first.`,
        'assertNotCrossScoped',
        'environment',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Storage types
// ---------------------------------------------------------------------------

export interface SecretEntry {
  encrypted_value: string;
  provider_id: ProviderType;
  secret_name: string;
  scope: 'shared' | 'prod';
  stored_at: number;
  updated_at: number;
}

export type SecretStoreEntries = Record<string, SecretEntry>;

export interface SecretStoreData {
  app_id: string;
  entries: SecretStoreEntries;
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// SecretStore
// ---------------------------------------------------------------------------

export class SecretStore {
  private readonly log: ReturnType<typeof createOperationLogger>;
  private readonly storePath: string;

  constructor(
    private readonly appId: string,
    storeDir: string,
    loggingCallback?: LoggingCallback,
  ) {
    this.storePath = path.join(storeDir, `${appId}.secrets.json`);
    this.log = createOperationLogger('SecretStore', loggingCallback);
  }

  // ---------------------------------------------------------------------------
  // Authorization check
  // ---------------------------------------------------------------------------

  private authorizeAccess(userId: string, auth: AppAuthorization): void {
    const allowed =
      auth.ownerId === userId || auth.collaboratorIds.includes(userId);
    if (!allowed) {
      throw new AuthorizationError(userId, auth.appId);
    }
  }

  // ---------------------------------------------------------------------------
  // Store a secret
  // ---------------------------------------------------------------------------

  store(
    userId: string,
    auth: AppAuthorization,
    providerId: ProviderType,
    secretName: string,
    value: string,
    environment: Environment,
    masterPassphrase: string,
  ): void {
    this.authorizeAccess(userId, auth);
    SecretValidator.validate(providerId, secretName, value);

    const data = this.loadStore();
    const scope = scopeKey(environment);

    // Enforce prod isolation
    SecretScoper.assertNotCrossScoped(data.entries, providerId, secretName, environment);

    const key = this.deriveSecretKey(masterPassphrase, providerId, secretName, scope);
    const encryptedValue = encrypt(value, key, { providerId });

    const entryKey = SecretStore.entryKey(providerId, secretName, scope);
    const now = Date.now();
    data.entries[entryKey] = {
      encrypted_value: encryptedValue,
      provider_id: providerId,
      secret_name: secretName,
      scope,
      stored_at: data.entries[entryKey]?.stored_at ?? now,
      updated_at: now,
    };

    data.updated_at = Date.now();
    this.saveStore(data);

    this.log.info('Secret stored', { providerId, secretName, scope });
  }

  // ---------------------------------------------------------------------------
  // Retrieve a secret
  // ---------------------------------------------------------------------------

  retrieve(
    userId: string,
    auth: AppAuthorization,
    providerId: ProviderType,
    secretName: string,
    environment: Environment,
    masterPassphrase: string,
  ): string | undefined {
    this.authorizeAccess(userId, auth);

    const data = this.loadStore();
    const scope = scopeKey(environment);
    const entryKey = SecretStore.entryKey(providerId, secretName, scope);
    const entry = data.entries[entryKey];

    if (!entry) return undefined;

    const key = this.deriveSecretKey(masterPassphrase, providerId, secretName, scope);
    return decrypt(entry.encrypted_value, key, { providerId });
  }

  // ---------------------------------------------------------------------------
  // List secrets for a provider + environment
  // ---------------------------------------------------------------------------

  list(
    userId: string,
    auth: AppAuthorization,
    providerId: ProviderType,
    environment: Environment,
  ): Array<{ secretName: string; storedAt: number }> {
    this.authorizeAccess(userId, auth);

    const data = this.loadStore();
    const scope = scopeKey(environment);

    return Object.values(data.entries)
      .filter(e => e.provider_id === providerId && e.scope === scope)
      .map(e => ({ secretName: e.secret_name, storedAt: e.stored_at }));
  }

  // ---------------------------------------------------------------------------
  // Delete a secret
  // ---------------------------------------------------------------------------

  delete(
    userId: string,
    auth: AppAuthorization,
    providerId: ProviderType,
    secretName: string,
    environment: Environment,
  ): boolean {
    this.authorizeAccess(userId, auth);

    const data = this.loadStore();
    const scope = scopeKey(environment);
    const entryKey = SecretStore.entryKey(providerId, secretName, scope);

    if (!data.entries[entryKey]) return false;

    delete data.entries[entryKey];
    data.updated_at = Date.now();
    this.saveStore(data);

    this.log.info('Secret deleted', { providerId, secretName, scope });
    return true;
  }

  // ---------------------------------------------------------------------------
  // Key derivation
  // ---------------------------------------------------------------------------

  private deriveSecretKey(
    masterPassphrase: string,
    providerId: ProviderType,
    secretName: string,
    scope: 'shared' | 'prod',
  ): Buffer {
    // Deterministic 32-byte key: SHA-256(passphrase + ":" + providerId + ":" + scope + ":" + secretName)
    return crypto
      .createHash('sha256')
      .update(`${masterPassphrase}:${this.appId}:${providerId}:${scope}:${secretName}`)
      .digest();
  }

  // ---------------------------------------------------------------------------
  // Static helpers
  // ---------------------------------------------------------------------------

  static entryKey(
    providerId: ProviderType,
    secretName: string,
    scope: 'shared' | 'prod',
  ): string {
    return `${providerId}::${secretName}::${scope}`;
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private loadStore(): SecretStoreData {
    if (!fs.existsSync(this.storePath)) {
      const now = Date.now();
      return { app_id: this.appId, entries: {}, created_at: now, updated_at: now };
    }

    try {
      const raw = fs.readFileSync(this.storePath, 'utf8');
      return JSON.parse(raw) as SecretStoreData;
    } catch (err) {
      throw new CredentialError(
        `Failed to read secret store: ${(err as Error).message}`,
        'loadStore',
      );
    }
  }

  private saveStore(data: SecretStoreData): void {
    const dir = path.dirname(this.storePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    const tmpPath = `${this.storePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
      fs.renameSync(tmpPath, this.storePath);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw new CredentialError(
        `Failed to save secret store: ${(err as Error).message}`,
        'saveStore',
      );
    }
  }
}
