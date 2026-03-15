/**
 * EventReplayer — reconstructs current app state from the event log,
 * identifying which providers have already completed and which still need work.
 */

import { ProviderType, ProviderState } from '../providers/types.js';
import { EventStore, StoredEvent } from './store.js';
import { createOperationLogger } from '../logger.js';
import type { LoggingCallback } from '../types.js';

// ---------------------------------------------------------------------------
// Replay result
// ---------------------------------------------------------------------------

export interface ReplayedAppState {
  app_id: string;
  /** Providers that successfully completed provisioning */
  succeeded_providers: ProviderType[];
  /** Providers that failed or are partially complete */
  failed_providers: ProviderType[];
  /** Providers with partial completion (some steps succeeded) */
  partial_providers: ProviderType[];
  /** Latest ProviderState per provider (from intermediate_state) */
  provider_states: Map<ProviderType, ProviderState>;
  /** The raw events for providers that need to be retried */
  retry_candidates: StoredEvent[];
}

// ---------------------------------------------------------------------------
// EventReplayer
// ---------------------------------------------------------------------------

export class EventReplayer {
  private readonly log: ReturnType<typeof createOperationLogger>;

  constructor(
    private readonly eventStore: EventStore,
    loggingCallback?: LoggingCallback,
  ) {
    this.log = createOperationLogger('EventReplayer', loggingCallback);
  }

  /**
   * Reads the event log for the given appId and reconstructs the current state.
   * Already-completed providers are identified so they can be skipped on resume.
   */
  replay(appId: string): ReplayedAppState {
    this.log.info('Replaying event log', { appId });

    const events = this.eventStore.readForApp(appId);

    if (events.length === 0) {
      this.log.info('No events found for app', { appId });
      return {
        app_id: appId,
        succeeded_providers: [],
        failed_providers: [],
        partial_providers: [],
        provider_states: new Map(),
        retry_candidates: [],
      };
    }

    // Build final status per provider (last event wins)
    const latestByProvider = new Map<ProviderType, StoredEvent>();
    for (const event of events) {
      // Only track provision events for state reconstruction
      if (event.operation === 'provision') {
        latestByProvider.set(event.provider_id, event);
      }
    }

    const succeededProviders: ProviderType[] = [];
    const failedProviders: ProviderType[] = [];
    const partialProviders: ProviderType[] = [];
    const providerStates = new Map<ProviderType, ProviderState>();
    const retryCandidates: StoredEvent[] = [];

    for (const [providerType, event] of latestByProvider.entries()) {
      if (event.intermediate_state) {
        providerStates.set(providerType, event.intermediate_state);
      }

      if (event.result === 'success') {
        succeededProviders.push(providerType);
      } else if (event.result === 'partial') {
        partialProviders.push(providerType);
        retryCandidates.push(event);
      } else {
        failedProviders.push(providerType);
        retryCandidates.push(event);
      }
    }

    this.log.info('Replay complete', {
      succeededCount: succeededProviders.length,
      failedCount: failedProviders.length,
      partialCount: partialProviders.length,
    });

    return {
      app_id: appId,
      succeeded_providers: succeededProviders,
      failed_providers: failedProviders,
      partial_providers: partialProviders,
      provider_states: providerStates,
      retry_candidates: retryCandidates,
    };
  }

  /**
   * Returns a human-readable summary of which providers need retry.
   */
  static formatReplaySummary(state: ReplayedAppState): string {
    const lines: string[] = [`App: ${state.app_id}`];

    if (state.succeeded_providers.length > 0) {
      lines.push(`✓ Completed: ${state.succeeded_providers.join(', ')}`);
    }

    if (state.partial_providers.length > 0) {
      lines.push(`~ Partial: ${state.partial_providers.join(', ')}`);
    }

    if (state.failed_providers.length > 0) {
      lines.push(`✗ Failed: ${state.failed_providers.join(', ')}`);
    }

    if (state.retry_candidates.length === 0) {
      lines.push('Nothing to retry.');
    } else {
      lines.push(
        `\nRetry candidates (${state.retry_candidates.length}):\n` +
          state.retry_candidates
            .map(e => `  - ${e.provider_id}: ${e.error_message ?? 'partially complete'}`)
            .join('\n'),
      );
    }

    return lines.join('\n');
  }
}
