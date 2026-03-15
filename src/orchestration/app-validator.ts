/**
 * validateApp() — compares a manifest against live provider state, detects
 * schema drift, and reports manifest errors and orphaned resources.
 *
 * Returns a ValidationReport that callers can inspect before deciding whether
 * to proceed with provisioning or invoke the ConflictResolver.
 */

import {
  ProviderManifest,
  ProviderConfig,
  ProviderState,
  ProviderType,
  PLATFORM_CORE_VERSION,
} from '../providers/types.js';
import { ProviderRegistry } from '../providers/registry.js';
import { DependencyResolver } from '../drift/resolver.js';
import { ManifestValidator, ManifestSchemaError } from '../schemas/validation.js';
import { ProviderValidator } from '../providers/validator.js';
import { ConflictResolver } from './conflict-resolver.js';
import { createOperationLogger } from '../logger.js';
import type { LoggingCallback } from '../types.js';
import type { ValidationReport, DriftSummary } from './types.js';

// ---------------------------------------------------------------------------
// AppValidator
// ---------------------------------------------------------------------------

export class AppValidator {
  private readonly log: ReturnType<typeof createOperationLogger>;
  private readonly providerValidator: ProviderValidator;
  private readonly conflictResolver: ConflictResolver;

  constructor(
    private readonly registry: ProviderRegistry,
    loggingCallback?: LoggingCallback,
  ) {
    this.log = createOperationLogger('AppValidator', loggingCallback);
    this.providerValidator = new ProviderValidator();
    this.conflictResolver = new ConflictResolver(loggingCallback);
  }

  /**
   * Validates a manifest against live provider state and returns a full
   * ValidationReport.
   *
   * @param manifest    The parsed ProviderManifest document
   * @param liveStates  Map of provider → live ProviderState (null if not provisioned)
   */
  async validateApp(
    manifest: ProviderManifest,
    liveStates: Map<ProviderType, ProviderState | null>,
  ): Promise<ValidationReport> {
    const schemaErrors: ValidationReport['schema_errors'] = [];
    const manifestErrors: ValidationReport['manifest_errors'] = [];
    const driftReports: DriftSummary[] = [];

    // ------------------------------------------------------------------
    // 1. Schema version check
    // ------------------------------------------------------------------
    const version = (manifest as unknown as Record<string, unknown>)['version'] as string | undefined;
    if (!version) {
      schemaErrors.push({
        field: 'version',
        message: 'Manifest is missing required "version" field',
        migration_hint: `Add version: "${PLATFORM_CORE_VERSION}" to your manifest`,
      });
    } else if (version !== PLATFORM_CORE_VERSION) {
      schemaErrors.push({
        field: 'version',
        message: `Manifest schema v${version} incompatible with platform v${PLATFORM_CORE_VERSION}`,
        migration_hint: 'Run: platform migrate manifest',
      });
    }

    // ------------------------------------------------------------------
    // 2. Structural manifest validation via ManifestValidator
    // ------------------------------------------------------------------
    try {
      ManifestValidator.validate(manifest);
    } catch (err) {
      if (err instanceof ManifestSchemaError) {
        // Already captured above
      } else {
        const e = err as Error & { field?: string; provider?: string };
        schemaErrors.push({
          field: e.field ?? 'unknown',
          message: e.message,
        });
      }
    }

    // ------------------------------------------------------------------
    // 3. Per-provider config validation
    // ------------------------------------------------------------------
    for (const config of manifest.providers) {
      const providerType = config.provider as ProviderType;
      const errors = this.providerValidator.validate(providerType, config);
      for (const e of errors) {
        manifestErrors.push({
          provider: providerType,
          field: e.field,
          message: e.message,
        });
      }
    }

    // ------------------------------------------------------------------
    // 4. Drift detection (only when structural validation passes)
    // ------------------------------------------------------------------
    if (schemaErrors.length === 0) {
      const orderedProviders = DependencyResolver.resolveOrder(
        manifest.providers.map(p => p.provider as ProviderType),
      );

      for (const providerType of orderedProviders) {
        if (!this.registry.hasAdapter(providerType)) {
          this.log.warn('No adapter registered — skipping drift detection', {
            provider: providerType,
          });
          continue;
        }

        const config = manifest.providers.find(p => p.provider === providerType)!;
        const liveState = liveStates.get(providerType) ?? null;

        try {
          const adapter = this.registry.getAdapter(providerType);
          const driftReport = await adapter.validate(config, liveState);
          const fullReport = this.conflictResolver.detectDrift(config, liveState, driftReport);

          if (fullReport.has_errors || fullReport.has_warnings) {
            driftReports.push(ConflictResolver.toSummary(fullReport));
          }
        } catch (err) {
          this.log.error('Drift detection failed for provider', {
            provider: providerType,
            error: (err as Error).message,
          });
          driftReports.push({
            provider: providerType,
            manifest_errors: [`Drift detection failed: ${(err as Error).message}`],
            orphaned_resources: [],
            has_errors: true,
            has_warnings: false,
          });
        }
      }
    }

    const hasErrors =
      schemaErrors.length > 0 ||
      manifestErrors.length > 0 ||
      driftReports.some(d => d.has_errors);

    const hasWarnings = driftReports.some(d => d.has_warnings);

    this.log.info('validateApp complete', {
      appId: manifest.app_id,
      schemaErrors: schemaErrors.length,
      manifestErrors: manifestErrors.length,
      driftProviders: driftReports.length,
      hasErrors,
      hasWarnings,
    });

    return {
      app_id: manifest.app_id,
      schema_version: version ?? 'unknown',
      schema_errors: schemaErrors,
      manifest_errors: manifestErrors,
      drift_reports: driftReports,
      has_errors: hasErrors,
      has_warnings: hasWarnings,
    };
  }
}

// ---------------------------------------------------------------------------
// Convenience function
// ---------------------------------------------------------------------------

/**
 * Validates a manifest against live provider state.
 * Creates a temporary AppValidator with the provided registry.
 */
export async function validateApp(
  manifest: ProviderManifest,
  liveStates: Map<ProviderType, ProviderState | null>,
  registry: ProviderRegistry,
  loggingCallback?: LoggingCallback,
): Promise<ValidationReport> {
  const validator = new AppValidator(registry, loggingCallback);
  return validator.validateApp(manifest, liveStates);
}
