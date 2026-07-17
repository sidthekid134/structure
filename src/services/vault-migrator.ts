/**
 * VaultToSqliteMigrator — one-time migration from credentials.enc to SQLite.
 *
 * Reads the legacy AES-256-GCM vault file, maps every entry to the typed
 * CredentialService schema, and writes rows idempotently. Writes a sentinel
 * file on completion so subsequent startups skip the migration.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { VaultManager } from '../vault.js';
import type { CredentialService } from './credential-service.js';
import { ORG_SENTINEL } from './credential-service.js';
import type { CredentialType } from './credential-service.js';

// ---------------------------------------------------------------------------
// Migration result
// ---------------------------------------------------------------------------

export interface MigrationReport {
  migrated: number;
  skipped: number;
  errors: Array<{ providerId: string; key: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// Static mapping table
// ---------------------------------------------------------------------------

interface MappingEntry {
  providerId: string;
  keyPattern: string | RegExp;
  projectId: string | 'from-prefix';
  credentialType: CredentialType;
  subKey: string | 'from-suffix';
}

// For firebase keys of the form "{projectId}/{suffix}", the projectId is the
// part before the first "/" and the suffix determines the credential type.
const FIREBASE_SUFFIX_MAP: Record<string, CredentialType> = {
  gcp_project_id: 'gcp_project_id',
  service_account_email: 'gcp_service_account_email',
  service_account_json: 'gcp_service_account_json',
  connected_by_email: 'gcp_connected_by_email',
  connected_at: 'gcp_connected_at',
  gcp_oauth_refresh_token: 'gcp_oauth_refresh_token',
  api_key: 'firebase_api_key',
  firebase_ios_app_id: 'firebase_ios_app_id',
  firebase_android_app_id: 'firebase_android_app_id',
  firestore_database_id: 'firestore_database_id',
  firestore_location: 'firestore_location',
  apple_sign_in_key_id: 'apple_sign_in_key_id',
  apple_sign_in_service_id: 'apple_sign_in_service_id',
  apple_sign_in_p8: 'apple_sign_in_p8',
  apns_key_id: 'apns_key_id',
  apple_team_id: 'apple_team_id',
  asc_app_id: 'apple_asc_app_id',
  'apple/auth-keys': 'apple_auth_keys_registry',
};

const SIMPLE_MAPPINGS: Array<{
  providerId: string;
  key: string;
  projectId: string;
  credentialType: CredentialType;
  subKey: string;
}> = [
  { providerId: 'github', key: 'token', projectId: ORG_SENTINEL, credentialType: 'github_pat', subKey: '' },
  { providerId: 'github', key: 'user_id', projectId: ORG_SENTINEL, credentialType: 'github_user_id', subKey: '' },
  { providerId: 'github', key: 'username', projectId: ORG_SENTINEL, credentialType: 'github_username', subKey: '' },
  { providerId: 'github', key: 'orgs', projectId: ORG_SENTINEL, credentialType: 'github_orgs', subKey: '' },
  { providerId: 'github', key: 'scopes', projectId: ORG_SENTINEL, credentialType: 'github_scopes', subKey: '' },
  { providerId: 'github', key: 'token_last_validated_at', projectId: ORG_SENTINEL, credentialType: 'github_validated_at', subKey: '' },
  { providerId: 'eas', key: 'expo_token', projectId: ORG_SENTINEL, credentialType: 'expo_token', subKey: '' },
  { providerId: 'eas', key: 'expo_username', projectId: ORG_SENTINEL, credentialType: 'expo_username', subKey: '' },
  { providerId: 'eas', key: 'expo_user_id', projectId: ORG_SENTINEL, credentialType: 'expo_user_id', subKey: '' },
  { providerId: 'eas', key: 'expo_accounts', projectId: ORG_SENTINEL, credentialType: 'expo_accounts', subKey: '' },
  // eas also stores expo_token_last_validated_at — map to validated_at (reuse github_validated_at doesn't apply, skip)
  { providerId: 'apple', key: 'apple/team_id', projectId: ORG_SENTINEL, credentialType: 'apple_team_id', subKey: '' },
  { providerId: 'apple', key: 'apple/asc_issuer_id', projectId: ORG_SENTINEL, credentialType: 'apple_asc_issuer_id', subKey: '' },
  { providerId: 'apple', key: 'apple/asc_api_key_id', projectId: ORG_SENTINEL, credentialType: 'apple_asc_api_key_id', subKey: '' },
  { providerId: 'apple', key: 'apple/asc_api_key_p8', projectId: ORG_SENTINEL, credentialType: 'apple_asc_api_key_p8', subKey: '' },
];

// ---------------------------------------------------------------------------
// Migrator
// ---------------------------------------------------------------------------

export class VaultToSqliteMigrator {
  private readonly sentinelPath: string;

  constructor(
    private readonly vaultManager: VaultManager,
    private readonly credentialService: CredentialService,
    private readonly storeDir: string,
  ) {
    this.sentinelPath = path.join(storeDir, '.vault-migration-complete');
  }

  isComplete(): boolean {
    return fs.existsSync(this.sentinelPath);
  }

  migrate(dek: Buffer): MigrationReport {
    const report: MigrationReport = { migrated: 0, skipped: 0, errors: [] };

    let vault: import('../types.js').VaultData;
    try {
      vault = this.vaultManager.loadVault(dek);
    } catch (err) {
      // Vault file missing or corrupt — treat as empty, still write sentinel
      report.errors.push({ providerId: '__vault__', key: '__load__', reason: (err as Error).message });
      this.writeSentinel();
      return report;
    }

    for (const [providerId, schema] of Object.entries(vault.entries)) {
      for (const [key, value] of Object.entries(schema.credentials)) {
        if (!value?.trim()) {
          report.skipped++;
          continue;
        }
        const mapped = this.resolveMapping(providerId, key);
        if (!mapped) {
          // Unknown key — log but don't block
          report.errors.push({ providerId, key, reason: 'No mapping found — skipped' });
          continue;
        }

        try {
          // Idempotent: skip if already present
          const existing = this.credentialService.getCredentialSummary(
            mapped.projectId,
            mapped.credentialType,
            mapped.subKey || undefined,
          );
          if (existing) {
            report.skipped++;
            continue;
          }

          this.credentialService.storeCredential({
            project_id: mapped.projectId,
            credential_type: mapped.credentialType,
            sub_key: mapped.subKey || undefined,
            value: value.trim(),
          });
          report.migrated++;
        } catch (err) {
          report.errors.push({ providerId, key, reason: (err as Error).message });
        }
      }
    }

    this.writeSentinel();
    return report;
  }

  private resolveMapping(
    providerId: string,
    key: string,
  ): { projectId: string; credentialType: CredentialType; subKey: string } | null {
    // Simple 1:1 mappings
    const simple = SIMPLE_MAPPINGS.find((m) => m.providerId === providerId && m.key === key);
    if (simple) {
      return { projectId: simple.projectId, credentialType: simple.credentialType, subKey: simple.subKey };
    }

    // Firebase: "{projectId}/{suffix}" pattern
    if (providerId === 'firebase') {
      return this.resolveFirebaseKey(key);
    }

    // Cloudflare: any key → cloudflare_token (org-level)
    if (providerId === 'cloudflare') {
      return { projectId: ORG_SENTINEL, credentialType: 'cloudflare_token', subKey: '' };
    }

    // Google Play: any key → google_play_key (org-level)
    if (providerId === 'google-play') {
      return { projectId: ORG_SENTINEL, credentialType: 'google_play_key', subKey: '' };
    }

    return null;
  }

  private resolveFirebaseKey(
    key: string,
  ): { projectId: string; credentialType: CredentialType; subKey: string } | null {
    const slashIdx = key.indexOf('/');
    if (slashIdx === -1) return null;

    const projectId = key.slice(0, slashIdx);
    const suffix = key.slice(slashIdx + 1);

    if (!projectId.trim()) return null;

    // EAS signing blob: "apple/eas-app-store-signing/{bundleId}"
    const easSigningPrefix = 'apple/eas-app-store-signing/';
    if (suffix.startsWith(easSigningPrefix)) {
      const bundleId = suffix.slice(easSigningPrefix.length);
      if (!bundleId) return null;
      return { projectId, credentialType: 'apple_eas_signing_blob', subKey: bundleId };
    }

    const credentialType = FIREBASE_SUFFIX_MAP[suffix];
    if (!credentialType) return null;
    return { projectId, credentialType, subKey: '' };
  }

  private writeSentinel(): void {
    try {
      fs.writeFileSync(this.sentinelPath, new Date().toISOString(), { mode: 0o600 });
    } catch {
      // Best-effort — if we can't write the sentinel, migration will re-run
      // on next startup (idempotent inserts protect against double-writes)
    }
  }
}
