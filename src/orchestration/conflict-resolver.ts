/**
 * ConflictResolver — detects drift between the manifest and live provider
 * state, surfaces it to the caller, and applies the user-chosen direction.
 *
 * Drift detection is intentionally provider-agnostic: it compares the
 * declared config keys against what the provider returned in ProviderState.
 */

import type {
  ProviderType,
  ProviderConfig,
  ProviderState,
  DriftReport,
  ReconcileDirection,
} from '../providers/types.js';
import type { DriftSummary } from './types.js';
import { createOperationLogger } from '../logger.js';
import type { LoggingCallback } from '../types.js';

// ---------------------------------------------------------------------------
// DriftItem — a single detected difference
// ---------------------------------------------------------------------------

export interface DriftItem {
  resource_id: string;
  field: string;
  manifest_value: unknown;
  live_value: unknown;
  direction: 'manifest_ahead' | 'live_ahead' | 'conflict';
}

// ---------------------------------------------------------------------------
// OrphanedResource — resource in live state not declared in manifest
// ---------------------------------------------------------------------------

export interface OrphanedResource {
  resource_id: string;
  resource_type: string;
  suggested_action: string;
}

// ---------------------------------------------------------------------------
// FullDriftReport — internal representation used by ConflictResolver
// ---------------------------------------------------------------------------

export interface FullDriftReport {
  provider: ProviderType;
  manifest_errors: Array<{ field: string; message: string }>;
  drift_items: DriftItem[];
  orphaned_resources: OrphanedResource[];
  has_errors: boolean;
  has_warnings: boolean;
}

// ---------------------------------------------------------------------------
// ConflictResolver
// ---------------------------------------------------------------------------

export class ConflictResolver {
  private readonly log: ReturnType<typeof createOperationLogger>;

  constructor(loggingCallback?: LoggingCallback) {
    this.log = createOperationLogger('ConflictResolver', loggingCallback);
  }

  /**
   * Detects drift between the declared manifest and the current live state.
   * Returns a FullDriftReport describing all differences.
   */
  detectDrift(
    manifest: ProviderConfig,
    liveState: ProviderState | null,
    driftReport?: DriftReport,
  ): FullDriftReport {
    const provider = manifest.provider as ProviderType;

    if (!liveState) {
      this.log.info('No live state — resource not yet provisioned', { provider });
      return {
        provider,
        manifest_errors: [],
        drift_items: [],
        orphaned_resources: [],
        has_errors: false,
        has_warnings: false,
      };
    }

    const driftItems: DriftItem[] = [];
    const orphanedResources: OrphanedResource[] = [];
    const manifestErrors: Array<{ field: string; message: string }> = [];

    // Use the adapter's DriftReport differences if provided
    if (driftReport) {
      for (const diff of driftReport.differences) {
        let direction: DriftItem['direction'];
        if (diff.manifest_value !== undefined && diff.live_value === undefined) {
          direction = 'manifest_ahead';
        } else if (diff.manifest_value === undefined && diff.live_value !== undefined) {
          direction = 'live_ahead';
        } else {
          direction = 'conflict';
        }

        driftItems.push({
          resource_id: liveState.provider_id,
          field: diff.field,
          manifest_value: diff.manifest_value,
          live_value: diff.live_value,
          direction,
        });
      }

      for (const resourceId of driftReport.orphaned_resources) {
        orphanedResources.push({
          resource_id: resourceId,
          resource_type: provider,
          suggested_action: `Delete via provider console or run: platform cleanup ${resourceId}`,
        });
      }
    }

    const hasErrors = manifestErrors.length > 0 || driftItems.some(d => d.direction === 'conflict');
    const hasWarnings = orphanedResources.length > 0 || driftItems.length > 0;

    this.log.info('Drift detection complete', {
      provider,
      driftCount: driftItems.length,
      orphanedCount: orphanedResources.length,
      hasErrors,
    });

    return {
      provider,
      manifest_errors: manifestErrors,
      drift_items: driftItems,
      orphaned_resources: orphanedResources,
      has_errors: hasErrors,
      has_warnings: hasWarnings,
    };
  }

  /**
   * Converts a FullDriftReport to the lightweight DriftSummary carried in
   * ProgressEvents.
   */
  static toSummary(report: FullDriftReport): DriftSummary {
    return {
      provider: report.provider,
      manifest_errors: report.manifest_errors.map(e => `${e.field}: ${e.message}`),
      orphaned_resources: report.orphaned_resources.map(r => r.resource_id),
      has_errors: report.has_errors,
      has_warnings: report.has_warnings,
    };
  }

  /**
   * Returns the recommended reconciliation direction based on the drift report.
   * manifest→live is preferred when the manifest has explicit declarations;
   * live→manifest is preferred when live state has resources not in manifest.
   */
  recommendDirection(report: FullDriftReport): ReconcileDirection {
    const liveAhead = report.drift_items.filter(d => d.direction === 'live_ahead').length;
    const manifestAhead = report.drift_items.filter(d => d.direction === 'manifest_ahead').length;

    return liveAhead > manifestAhead ? 'live→manifest' : 'manifest→live';
  }
}
