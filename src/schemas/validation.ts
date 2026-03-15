/**
 * Manifest schema validation for the provider framework.
 *
 * Validates ProviderManifest documents before any provisioning begins,
 * ensuring schema version compatibility and required field presence.
 */

import { CredentialError } from '../types.js';
import {
  ProviderManifest,
  ProviderConfig,
  ProviderType,
  PLATFORM_CORE_VERSION,
  PROVIDER_TYPES,
} from '../providers/types.js';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class ManifestSchemaError extends CredentialError {
  constructor(
    message: string,
    public readonly manifest_version: string,
    public readonly expected_version: string,
  ) {
    super(message, 'validateManifestVersion');
    this.name = 'ManifestSchemaError';
  }
}

export class ManifestValidationError extends CredentialError {
  constructor(
    message: string,
    public readonly field: string,
    public readonly provider?: string,
  ) {
    super(message, 'validateManifest');
    this.name = 'ManifestValidationError';
  }
}

// ---------------------------------------------------------------------------
// Manifest validator
// ---------------------------------------------------------------------------

export class ManifestValidator {
  /**
   * Validates a raw manifest object (parsed JSON).
   * Throws on first validation error.
   */
  static validate(manifest: unknown): asserts manifest is ProviderManifest {
    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new ManifestValidationError(
        'Manifest must be a JSON object',
        'root',
      );
    }

    const m = manifest as Record<string, unknown>;

    // Required top-level fields
    if (typeof m['version'] !== 'string' || !m['version']) {
      throw new ManifestValidationError(
        'Manifest must have a "version" field (string)',
        'version',
      );
    }

    if (m['version'] !== PLATFORM_CORE_VERSION) {
      throw new ManifestSchemaError(
        `Manifest schema version "${m['version']}" does not match ` +
          `platform-core version "${PLATFORM_CORE_VERSION}". ` +
          `Run 'platform migrate' to update your manifest.`,
        m['version'] as string,
        PLATFORM_CORE_VERSION,
      );
    }

    if (typeof m['app_id'] !== 'string' || !m['app_id']) {
      throw new ManifestValidationError(
        'Manifest must have a non-empty "app_id" field (string)',
        'app_id',
      );
    }

    if (!Array.isArray(m['providers'])) {
      throw new ManifestValidationError(
        'Manifest must have a "providers" array',
        'providers',
      );
    }

    for (const [i, providerConfig] of (m['providers'] as unknown[]).entries()) {
      ManifestValidator.validateProviderConfig(providerConfig, i);
    }
  }

  private static validateProviderConfig(config: unknown, index: number): void {
    const field = `providers[${index}]`;

    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      throw new ManifestValidationError(
        `${field} must be an object`,
        field,
      );
    }

    const c = config as Record<string, unknown>;

    if (!c['provider'] || !(PROVIDER_TYPES as readonly string[]).includes(c['provider'] as string)) {
      throw new ManifestValidationError(
        `${field}.provider must be one of: ${PROVIDER_TYPES.join(', ')}. ` +
          `Got: "${c['provider'] ?? 'undefined'}"`,
        `${field}.provider`,
        c['provider'] as string | undefined,
      );
    }

    const provider = c['provider'] as ProviderType;

    switch (provider) {
      case 'firebase':
        ManifestValidator.validateFirebaseConfig(c, field);
        break;
      case 'github':
        ManifestValidator.validateGitHubConfig(c, field);
        break;
      case 'eas':
        ManifestValidator.validateEasConfig(c, field);
        break;
      case 'apple':
        ManifestValidator.validateAppleConfig(c, field);
        break;
      case 'google-play':
        ManifestValidator.validateGooglePlayConfig(c, field);
        break;
      case 'cloudflare':
        ManifestValidator.validateCloudflareConfig(c, field);
        break;
      case 'oauth':
        ManifestValidator.validateOAuthConfig(c, field);
        break;
    }
  }

  private static requireString(
    obj: Record<string, unknown>,
    key: string,
    field: string,
    hint?: string,
  ): void {
    if (typeof obj[key] !== 'string' || !(obj[key] as string)) {
      throw new ManifestValidationError(
        `${field}.${key} must be a non-empty string${hint ? ` (${hint})` : ''}`,
        `${field}.${key}`,
      );
    }
  }

  private static validateFirebaseConfig(
    c: Record<string, unknown>,
    field: string,
  ): void {
    ManifestValidator.requireString(c, 'project_name', field, '4-30 characters');

    const projectName = c['project_name'] as string;
    if (projectName.length < 4 || projectName.length > 30) {
      throw new ManifestValidationError(
        `${field}.project_name must be 4-30 characters, got ${projectName.length}`,
        `${field}.project_name`,
      );
    }

    ManifestValidator.requireString(c, 'billing_account_id', field);

    if (!Array.isArray(c['services']) || c['services'].length === 0) {
      throw new ManifestValidationError(
        `${field}.services must be a non-empty array`,
        `${field}.services`,
      );
    }

    if (!['dev', 'preview', 'prod'].includes(c['environment'] as string)) {
      throw new ManifestValidationError(
        `${field}.environment must be one of: dev, preview, prod`,
        `${field}.environment`,
      );
    }
  }

  private static validateGitHubConfig(
    c: Record<string, unknown>,
    field: string,
  ): void {
    ManifestValidator.requireString(c, 'repo_name', field);
    ManifestValidator.requireString(c, 'owner', field);

    if (!Array.isArray(c['environments'])) {
      throw new ManifestValidationError(
        `${field}.environments must be an array`,
        `${field}.environments`,
      );
    }
  }

  private static validateEasConfig(
    c: Record<string, unknown>,
    field: string,
  ): void {
    ManifestValidator.requireString(c, 'project_name', field);
  }

  private static validateAppleConfig(
    c: Record<string, unknown>,
    field: string,
  ): void {
    ManifestValidator.requireString(c, 'bundle_id', field);
    ManifestValidator.requireString(c, 'team_id', field);
    ManifestValidator.requireString(c, 'app_name', field);
  }

  private static validateGooglePlayConfig(
    c: Record<string, unknown>,
    field: string,
  ): void {
    ManifestValidator.requireString(c, 'package_name', field);
    ManifestValidator.requireString(c, 'app_title', field);
  }

  private static validateCloudflareConfig(
    c: Record<string, unknown>,
    field: string,
  ): void {
    ManifestValidator.requireString(c, 'domain', field);
  }

  private static validateOAuthConfig(
    c: Record<string, unknown>,
    field: string,
  ): void {
    ManifestValidator.requireString(c, 'oauth_provider', field);
    ManifestValidator.requireString(c, 'redirect_uri', field);
    ManifestValidator.requireString(c, 'firebase_project_id', field);

    const validProviders = ['google', 'github', 'apple'];
    if (!validProviders.includes(c['oauth_provider'] as string)) {
      throw new ManifestValidationError(
        `${field}.oauth_provider must be one of: ${validProviders.join(', ')}`,
        `${field}.oauth_provider`,
      );
    }
  }
}
