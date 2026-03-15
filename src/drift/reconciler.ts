/**
 * ReconciliationEngine — applies a user-chosen sync direction across all
 * providers in dependency order, stopping on first failure.
 */

import {
  ProviderType,
  ProviderState,
  DriftReport,
  ReconcileDirection,
} from '../providers/types.js';
import { ProviderRegistry } from '../providers/registry.js';
import { DependencyResolver } from './resolver.js';
import { AggregatedDriftResult } from './detector.js';
import { createOperationLogger } from '../logger.js';
import type { LoggingCallback } from '../types.js';

// ---------------------------------------------------------------------------
// Reconciliation result
// ---------------------------------------------------------------------------

export interface ReconciliationResult {
  success: boolean;
  reconciled_providers: ProviderType[];
  failed_provider?: ProviderType;
  failed_reason?: string;
  updated_states: Map<ProviderType, ProviderState>;
}

// ---------------------------------------------------------------------------
// ReconciliationEngine
// ---------------------------------------------------------------------------

export class ReconciliationEngine {
  private readonly log: ReturnType<typeof createOperationLogger>;

  constructor(
    private readonly registry: ProviderRegistry,
    loggingCallback?: LoggingCallback,
  ) {
    this.log = createOperationLogger('ReconciliationEngine', loggingCallback);
  }

  /**
   * Reconciles all providers in the AggregatedDriftResult in dependency order.
   * Stops on the first failure and reports which provider blocked progress.
   *
   * @param driftResult   The aggregated drift detection result
   * @param direction     Which direction to sync: manifest→live or live→manifest
   */
  async reconcileAll(
    driftResult: AggregatedDriftResult,
    direction: ReconcileDirection,
  ): Promise<ReconciliationResult> {
    const reportsMap = new Map<ProviderType, DriftReport>(
      driftResult.reports.map(r => [r.provider_type, r]),
    );

    // Determine ordered list of providers that have drift to reconcile
    const providersWithDrift = driftResult.reports.map(r => r.provider_type);
    const orderedProviders = DependencyResolver.resolveOrder(providersWithDrift);

    const reconciledProviders: ProviderType[] = [];
    const updatedStates = new Map<ProviderType, ProviderState>();

    this.log.info('Starting reconciliation', {
      direction,
      providerCount: orderedProviders.length,
      order: orderedProviders,
    });

    for (const providerType of orderedProviders) {
      const report = reportsMap.get(providerType);
      if (!report) continue;

      if (!this.registry.hasAdapter(providerType)) {
        return {
          success: false,
          reconciled_providers: reconciledProviders,
          failed_provider: providerType,
          failed_reason: `No adapter registered for "${providerType}"`,
          updated_states: updatedStates,
        };
      }

      try {
        this.log.info('Reconciling provider', { provider: providerType, direction });

        const adapter = this.registry.getAdapter(providerType);
        const newState = await adapter.reconcile(report, direction);

        reconciledProviders.push(providerType);
        updatedStates.set(providerType, newState);

        this.log.info('Provider reconciled', { provider: providerType });
      } catch (err) {
        const reason = (err as Error).message;
        this.log.error('Reconciliation failed — stopping', {
          provider: providerType,
          reason,
        });
        return {
          success: false,
          reconciled_providers: reconciledProviders,
          failed_provider: providerType,
          failed_reason: reason,
          updated_states: updatedStates,
        };
      }
    }

    this.log.info('Reconciliation complete', {
      reconciledCount: reconciledProviders.length,
    });

    return {
      success: true,
      reconciled_providers: reconciledProviders,
      updated_states: updatedStates,
    };
  }

  /**
   * Reconciles a single provider report.
   */
  async reconcileOne(
    report: DriftReport,
    direction: ReconcileDirection,
  ): Promise<ProviderState> {
    const adapter = this.registry.getAdapter(report.provider_type);
    return adapter.reconcile(report, direction);
  }
}
