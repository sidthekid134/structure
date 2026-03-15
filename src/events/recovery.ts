/**
 * RecoveryManager — lets users resume failed provisioning operations.
 *
 * Two recovery strategies:
 *   - 'full_revalidation': delete intermediate state and re-run all providers
 *   - 'trust_log': skip succeeded providers, retry only failed/partial ones
 */

import {
  ProviderType,
  ProviderConfig,
  ProviderState,
} from '../providers/types.js';
import { ProviderRegistry } from '../providers/registry.js';
import { DependencyResolver } from '../drift/resolver.js';
import { EventStore, EventOperation } from './store.js';
import { EventReplayer, ReplayedAppState } from './replayer.js';
import { createOperationLogger } from '../logger.js';
import type { LoggingCallback } from '../types.js';

// ---------------------------------------------------------------------------
// Recovery strategy
// ---------------------------------------------------------------------------

export type RecoveryStrategy = 'full_revalidation' | 'trust_log';

export interface RecoveryPlan {
  app_id: string;
  strategy: RecoveryStrategy;
  providers_to_retry: ProviderType[];
  providers_to_skip: ProviderType[];
  replayed_state: ReplayedAppState;
}

export interface RecoveryResult {
  success: boolean;
  recovered_providers: ProviderType[];
  still_failed: ProviderType[];
  updated_states: Map<ProviderType, ProviderState>;
}

// ---------------------------------------------------------------------------
// RecoveryManager
// ---------------------------------------------------------------------------

export class RecoveryManager {
  private readonly log: ReturnType<typeof createOperationLogger>;
  private readonly replayer: EventReplayer;

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly eventStore: EventStore,
    loggingCallback?: LoggingCallback,
  ) {
    this.replayer = new EventReplayer(eventStore, loggingCallback);
    this.log = createOperationLogger('RecoveryManager', loggingCallback);
  }

  // ---------------------------------------------------------------------------
  // Build a recovery plan from the event log
  // ---------------------------------------------------------------------------

  buildPlan(
    appId: string,
    strategy: RecoveryStrategy,
    allProviders: ProviderType[],
  ): RecoveryPlan {
    const replayedState = this.replayer.replay(appId);

    let providersToRetry: ProviderType[];
    let providersToSkip: ProviderType[];

    if (strategy === 'full_revalidation') {
      // Re-run everything in dependency order
      providersToRetry = DependencyResolver.resolveOrder(allProviders);
      providersToSkip = [];
    } else {
      // trust_log: skip succeeded, retry failed and partial
      const succeeded = new Set(replayedState.succeeded_providers);
      providersToRetry = DependencyResolver.resolveOrder(
        allProviders.filter(p => !succeeded.has(p)),
      );
      providersToSkip = replayedState.succeeded_providers;
    }

    this.log.info('Recovery plan built', {
      appId,
      strategy,
      retryCount: providersToRetry.length,
      skipCount: providersToSkip.length,
    });

    return {
      app_id: appId,
      strategy,
      providers_to_retry: providersToRetry,
      providers_to_skip: providersToSkip,
      replayed_state: replayedState,
    };
  }

  // ---------------------------------------------------------------------------
  // Execute a recovery plan
  // ---------------------------------------------------------------------------

  async execute(
    userId: string,
    plan: RecoveryPlan,
    manifests: Map<ProviderType, ProviderConfig>,
  ): Promise<RecoveryResult> {
    this.log.info('Executing recovery plan', {
      appId: plan.app_id,
      strategy: plan.strategy,
      providersToRetry: plan.providers_to_retry,
    });

    const recoveredProviders: ProviderType[] = [];
    const stillFailed: ProviderType[] = [];
    const updatedStates = new Map<ProviderType, ProviderState>();

    // Seed already-known good states from the event log
    for (const [providerType, state] of plan.replayed_state.provider_states.entries()) {
      if (plan.providers_to_skip.includes(providerType)) {
        updatedStates.set(providerType, state);
      }
    }

    for (const providerType of plan.providers_to_retry) {
      const manifest = manifests.get(providerType);
      if (!manifest) {
        this.log.warn('No manifest found for provider — skipping', {
          provider: providerType,
        });
        continue;
      }

      if (!this.registry.hasAdapter(providerType)) {
        this.log.warn('No adapter for provider — skipping', { provider: providerType });
        continue;
      }

      const adapter = this.registry.getAdapter(providerType);
      const operation: EventOperation = 'provision';

      // For 'trust_log', pass existing intermediate state for idempotency
      const existingState =
        plan.strategy === 'trust_log'
          ? plan.replayed_state.provider_states.get(providerType)
          : undefined;

      try {
        this.log.info('Retrying provider', { provider: providerType });
        const newState = await adapter.provision(manifest);

        recoveredProviders.push(providerType);
        updatedStates.set(providerType, newState);

        this.eventStore.recordSuccess(
          userId,
          plan.app_id,
          providerType,
          operation,
          manifest,
          newState,
        );

        this.log.info('Provider recovery succeeded', { provider: providerType });
      } catch (err) {
        stillFailed.push(providerType);
        this.log.error('Provider recovery failed', {
          provider: providerType,
          error: (err as Error).message,
        });

        this.eventStore.recordFailure(
          userId,
          plan.app_id,
          providerType,
          operation,
          manifest,
          err as Error,
          existingState,
        );
      }
    }

    return {
      success: stillFailed.length === 0,
      recovered_providers: recoveredProviders,
      still_failed: stillFailed,
      updated_states: updatedStates,
    };
  }

  // ---------------------------------------------------------------------------
  // 'platform resume' command helper
  // ---------------------------------------------------------------------------

  /**
   * Lists failed operations for an app in a user-friendly format.
   * Intended for 'platform resume' command output.
   */
  listFailedOperations(appId: string): string {
    const replayedState = this.replayer.replay(appId);
    return EventReplayer.formatReplaySummary(replayedState);
  }
}
