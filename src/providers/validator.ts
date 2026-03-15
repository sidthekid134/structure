/**
 * ProviderValidator — validates provider configs against per-provider schemas.
 *
 * All validation is performed before provisioning begins, ensuring that
 * misconfigured manifests are rejected early with actionable error messages.
 *
 * Input sanitization rules applied to all fields:
 *   - Trim leading/trailing whitespace
 *   - Reject null/undefined required fields
 *   - Validate email formats where expected
 *   - Reject shell metacharacters in secret-like values
 */

import type {
  ProviderConfig,
  ProviderType,
  FirebaseManifestConfig,
  GitHubManifestConfig,
  EasManifestConfig,
  AppleManifestConfig,
  CloudflareManifestConfig,
  OAuthManifestConfig,
  GooglePlayManifestConfig,
} from './types.js';

// ---------------------------------------------------------------------------
// ValidationError item (not the class from types.ts)
// ---------------------------------------------------------------------------

export interface ProviderValidationError {
  provider: ProviderType;
  field: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SHELL_META_RE = /[;&|`$<>\\]/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_RE = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
const APPLE_KEY_ID_RE = /^[A-Z0-9]{10}$/;
const FIREBASE_PROJECT_RE = /^[a-z0-9-]{4,30}$/;

function err(
  provider: ProviderType,
  field: string,
  message: string,
): ProviderValidationError {
  return { provider, field, message };
}

function requireString(
  provider: ProviderType,
  obj: Record<string, unknown>,
  key: string,
  errors: ProviderValidationError[],
  opts?: { minLen?: number; maxLen?: number; pattern?: RegExp; patternHint?: string },
): boolean {
  const raw = obj[key];
  if (raw === null || raw === undefined || typeof raw !== 'string') {
    errors.push(err(provider, key, `"${key}" is required and must be a string`));
    return false;
  }
  const val = (raw as string).trim();
  if (!val) {
    errors.push(err(provider, key, `"${key}" must not be empty`));
    return false;
  }
  if (SHELL_META_RE.test(val)) {
    errors.push(err(provider, key, `"${key}" contains suspicious characters`));
    return false;
  }
  if (opts?.minLen !== undefined && val.length < opts.minLen) {
    errors.push(err(provider, key, `"${key}" must be at least ${opts.minLen} characters`));
    return false;
  }
  if (opts?.maxLen !== undefined && val.length > opts.maxLen) {
    errors.push(err(provider, key, `"${key}" must be at most ${opts.maxLen} characters`));
    return false;
  }
  if (opts?.pattern && !opts.pattern.test(val)) {
    errors.push(
      err(provider, key, `"${key}" has invalid format${opts.patternHint ? ` (${opts.patternHint})` : ''}`),
    );
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Per-provider validators
// ---------------------------------------------------------------------------

function validateFirebase(
  config: FirebaseManifestConfig,
  errors: ProviderValidationError[],
): void {
  const p = 'firebase' as const;
  const c = config as unknown as Record<string, unknown>;
  requireString(p, c, 'project_name', errors, {
    minLen: 4,
    maxLen: 30,
    pattern: FIREBASE_PROJECT_RE,
    patternHint: 'lowercase alphanumeric and hyphens, 4-30 chars',
  });
  requireString(p, c, 'billing_account_id', errors);

  if (!Array.isArray(config.services) || config.services.length === 0) {
    errors.push(err(p, 'services', '"services" must be a non-empty array'));
  }

  const validEnvs = ['dev', 'preview', 'prod'];
  if (!validEnvs.includes(config.environment)) {
    errors.push(err(p, 'environment', `"environment" must be one of: ${validEnvs.join(', ')}`));
  }
}

function validateGitHub(
  config: GitHubManifestConfig,
  errors: ProviderValidationError[],
): void {
  const p = 'github' as const;
  const c = config as unknown as Record<string, unknown>;
  requireString(p, c, 'repo_name', errors, { minLen: 1, maxLen: 100 });
  requireString(p, c, 'owner', errors, { minLen: 1, maxLen: 100 });

  if (!Array.isArray(config.environments) || config.environments.length === 0) {
    errors.push(err(p, 'environments', '"environments" must be a non-empty array'));
  }
}

function validateEas(
  config: EasManifestConfig,
  errors: ProviderValidationError[],
): void {
  const p = 'eas' as const;
  const c = config as unknown as Record<string, unknown>;
  requireString(p, c, 'project_name', errors, { minLen: 1, maxLen: 100 });
}

function validateApple(
  config: AppleManifestConfig,
  errors: ProviderValidationError[],
): void {
  const p = 'apple' as const;
  const c = config as unknown as Record<string, unknown>;
  requireString(p, c, 'bundle_id', errors);
  requireString(p, c, 'team_id', errors, { minLen: 10, maxLen: 10 });
  requireString(p, c, 'app_name', errors);

  // Validate apns_key_id if present
  const apnsKeyId = (c['apns_key_id'] as string | undefined)?.trim();
  if (apnsKeyId !== undefined && !APPLE_KEY_ID_RE.test(apnsKeyId)) {
    errors.push(err(p, 'apns_key_id', '"apns_key_id" must be exactly 10 uppercase alphanumeric characters'));
  }
}

function validateGooglePlay(
  config: GooglePlayManifestConfig,
  errors: ProviderValidationError[],
): void {
  const p = 'google-play' as const;
  const c = config as unknown as Record<string, unknown>;
  requireString(p, c, 'package_name', errors);
  requireString(p, c, 'app_title', errors);
  requireString(p, c, 'default_language', errors, { minLen: 2, maxLen: 10 });
}

function validateCloudflare(
  config: CloudflareManifestConfig,
  errors: ProviderValidationError[],
): void {
  const p = 'cloudflare' as const;
  const c = config as unknown as Record<string, unknown>;
  requireString(p, c, 'domain', errors, {
    pattern: DOMAIN_RE,
    patternHint: 'valid domain name',
  });

  const validSslModes = ['full', 'flexible', 'strict'];
  if (!validSslModes.includes(config.ssl_mode)) {
    errors.push(err(p, 'ssl_mode', `"ssl_mode" must be one of: ${validSslModes.join(', ')}`));
  }
}

function validateOAuth(
  config: OAuthManifestConfig,
  errors: ProviderValidationError[],
): void {
  const p = 'oauth' as const;
  const c = config as unknown as Record<string, unknown>;
  requireString(p, c, 'redirect_uri', errors);
  requireString(p, c, 'firebase_project_id', errors);

  const validOAuthProviders = ['google', 'github', 'apple'];
  if (!validOAuthProviders.includes(config.oauth_provider)) {
    errors.push(err(p, 'oauth_provider', `"oauth_provider" must be one of: ${validOAuthProviders.join(', ')}`));
  }
}

// ---------------------------------------------------------------------------
// ProviderValidator
// ---------------------------------------------------------------------------

export class ProviderValidator {
  /**
   * Validates a single provider config and returns all validation errors.
   * An empty array means the config is valid.
   */
  validate(providerId: ProviderType, config: ProviderConfig): ProviderValidationError[] {
    const errors: ProviderValidationError[] = [];

    switch (providerId) {
      case 'firebase':
        validateFirebase(config as FirebaseManifestConfig, errors);
        break;
      case 'github':
        validateGitHub(config as GitHubManifestConfig, errors);
        break;
      case 'eas':
        validateEas(config as EasManifestConfig, errors);
        break;
      case 'apple':
        validateApple(config as AppleManifestConfig, errors);
        break;
      case 'google-play':
        validateGooglePlay(config as GooglePlayManifestConfig, errors);
        break;
      case 'cloudflare':
        validateCloudflare(config as CloudflareManifestConfig, errors);
        break;
      case 'oauth':
        validateOAuth(config as OAuthManifestConfig, errors);
        break;
    }

    return errors;
  }

  /**
   * Validates all provider configs in a manifest and returns all errors.
   */
  validateAll(configs: ProviderConfig[]): ProviderValidationError[] {
    return configs.flatMap(c => this.validate(c.provider as ProviderType, c));
  }
}
