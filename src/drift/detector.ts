/**
 * DriftDetector — calls validate() on each registered adapter, collects
 * DriftReports, and aggregates them into a single summary.
 */

import {
  ProviderType,
  ProviderConfig,
  ProviderState,
  DriftReport,
} from '../providers/types.js';
import { ProviderRegistry } from '../providers/registry.js';
import { createOperationLogger } from '../logger.js';
import type { LoggingCallback } from '../types.js';

// ---------------------------------------------------------------------------
// Aggregated drift result
// ---------------------------------------------------------------------------

export interface AggregatedDriftResult {
  /** Reports per provider that have differences or errors */
  reports: DriftReport[];
  /** Providers that validated cleanly (no differences) */
  clean_providers: ProviderType[];
  /** Providers that had validation errors */
  error_providers: Array<{ provider: ProviderType; error: string }>;
  /** True if any provider requires user decision before reconciling */
  requires_user_decision: boolean;
  /** Total difference count across all providers */
  total_differences: number;
}

// ---------------------------------------------------------------------------
// DriftDetector
// ---------------------------------------------------------------------------

export class DriftDetector {
  private readonly log: ReturnType<typeof createOperationLogger>;

  constructor(
    private readonly registry: ProviderRegistry,
    loggingCallback?: LoggingCallback,
  ) {
    this.log = createOperationLogger('DriftDetector', loggingCallback);
  }

  /**
   * Runs validate() on each provider in the given state map and aggregates results.
   *
   * @param manifests  Map of provider type → manifest config
   * @param liveStates Map of provider type → live ProviderState (or null if not provisioned)
   */
  async detect(
    manifests: Map<ProviderType, ProviderConfig>,
    liveStates: Map<ProviderType, ProviderState | null>,
  ): Promise<AggregatedDriftResult> {
    const reports: DriftReport[] = [];
    const cleanProviders: ProviderType[] = [];
    const errorProviders: Array<{ provider: ProviderType; error: string }> = [];

    for (const [providerType, manifest] of manifests.entries()) {
      if (!this.registry.hasAdapter(providerType)) {
        this.log.warn(`No adapter registered for provider "${providerType}" — skipping`);
        continue;
      }

      const liveState = liveStates.get(providerType) ?? null;

      try {
        this.log.info('Validating provider', { provider: providerType });

        const adapter = this.registry.getAdapter(providerType);
        const report = await adapter.validate(manifest, liveState);

        if (report.differences.length === 0 && report.orphaned_resources.length === 0) {
          cleanProviders.push(providerType);
          this.log.info('Provider validated clean', { provider: providerType });
        } else {
          reports.push(report);
          this.log.info('Drift detected', {
            provider: providerType,
            differenceCount: report.differences.length,
            orphanedCount: report.orphaned_resources.length,
          });
        }
      } catch (err) {
        const message = (err as Error).message;
        errorProviders.push({ provider: providerType, error: message });
        this.log.error('Provider validation failed', {
          provider: providerType,
          error: message,
        });
      }
    }

    const totalDifferences = reports.reduce(
      (sum, r) => sum + r.differences.length,
      0,
    );

    const requiresUserDecision = reports.some(r => r.requires_user_decision);

    return {
      reports,
      clean_providers: cleanProviders,
      error_providers: errorProviders,
      requires_user_decision: requiresUserDecision,
      total_differences: totalDifferences,
    };
  }

  /**
   * Formats a DriftReport for user-facing display.
   */
  static formatReport(result: AggregatedDriftResult): string {
    const lines: string[] = [];

    if (result.clean_providers.length > 0) {
      lines.push(`✓ Clean: ${result.clean_providers.join(', ')}`);
    }

    for (const report of result.reports) {
      lines.push(`\n● ${report.provider_type}:`);
      for (const diff of report.differences) {
        const ct = diff.conflict_type;
        if (ct === 'missing_in_live') {
          lines.push(`  + ${diff.field}: ${JSON.stringify(diff.manifest_value)} (not in live)`);
        } else if (ct === 'missing_in_manifest') {
          lines.push(`  - ${diff.field}: ${JSON.stringify(diff.live_value)} (not in manifest)`);
        } else if (ct === 'value_mismatch') {
          lines.push(
            `  ~ ${diff.field}: manifest=${JSON.stringify(diff.manifest_value)} ` +
              `live=${JSON.stringify(diff.live_value)}`,
          );
        } else if (ct === 'orphaned_resource') {
          lines.push(`  ! ${diff.field}: orphaned (${JSON.stringify(diff.live_value)})`);
        }
      }
      if (report.requires_user_decision) {
        lines.push(
          `  ⚠ Requires user decision — choose sync direction: ` +
            `"manifest→live" or "live→manifest"`,
        );
      }
    }

    for (const ep of result.error_providers) {
      lines.push(`\n✗ ${ep.provider}: ${ep.error}`);
    }

    if (result.total_differences === 0 && result.error_providers.length === 0) {
      lines.push('All providers are in sync.');
    }

    return lines.join('\n');
  }
}
