/**
 * ProviderRegistry — registers and retrieves typed provider adapters.
 *
 * Adapters are keyed by ProviderType and returned with full type information
 * via overloaded getAdapter() signatures.
 */

import {
  ProviderAdapter,
  ProviderConfig,
  ProviderType,
  FirebaseManifestConfig,
  GitHubManifestConfig,
  EasManifestConfig,
  AppleManifestConfig,
  GooglePlayManifestConfig,
  CloudflareManifestConfig,
  OAuthManifestConfig,
  PLATFORM_CORE_VERSION,
} from './types.js';
import { ProviderManifest } from './types.js';
import { ManifestSchemaError } from '../schemas/validation.js';

export class ProviderRegistry {
  private readonly adapters = new Map<ProviderType, ProviderAdapter<ProviderConfig>>();

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  register<T extends ProviderConfig>(
    providerId: ProviderType,
    adapter: ProviderAdapter<T>,
  ): void {
    this.adapters.set(providerId, adapter as ProviderAdapter<ProviderConfig>);
  }

  // ---------------------------------------------------------------------------
  // Typed retrieval (overloads ensure the caller gets the correct generic)
  // ---------------------------------------------------------------------------

  getAdapter(provider: 'firebase'): ProviderAdapter<FirebaseManifestConfig>;
  getAdapter(provider: 'github'): ProviderAdapter<GitHubManifestConfig>;
  getAdapter(provider: 'eas'): ProviderAdapter<EasManifestConfig>;
  getAdapter(provider: 'apple'): ProviderAdapter<AppleManifestConfig>;
  getAdapter(provider: 'google-play'): ProviderAdapter<GooglePlayManifestConfig>;
  getAdapter(provider: 'cloudflare'): ProviderAdapter<CloudflareManifestConfig>;
  getAdapter(provider: 'oauth'): ProviderAdapter<OAuthManifestConfig>;
  getAdapter(provider: ProviderType): ProviderAdapter<ProviderConfig>;
  getAdapter(provider: ProviderType): ProviderAdapter<ProviderConfig> {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new Error(
        `No adapter registered for provider: "${provider}". ` +
          `Register an adapter first using registry.register('${provider}', adapter).`,
      );
    }
    return adapter;
  }

  hasAdapter(provider: ProviderType): boolean {
    return this.adapters.has(provider);
  }

  registeredProviders(): ProviderType[] {
    return Array.from(this.adapters.keys());
  }

  // ---------------------------------------------------------------------------
  // Manifest validation
  // ---------------------------------------------------------------------------

  /**
   * Validates a manifest's schema version against the platform-core version.
   * Throws ManifestSchemaError if the version mismatches.
   */
  validateManifestVersion(manifest: ProviderManifest): void {
    if (manifest.version !== PLATFORM_CORE_VERSION) {
      throw new ManifestSchemaError(
        `Manifest schema version "${manifest.version}" does not match platform-core ` +
          `version "${PLATFORM_CORE_VERSION}". Run 'platform migrate' to update your manifest.`,
        manifest.version,
        PLATFORM_CORE_VERSION,
      );
    }
  }
}
