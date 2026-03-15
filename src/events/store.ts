/**
 * EventStore — persists all provision/validate/reconcile operations to a
 * JSON-lines file for resume capability.
 *
 * Each event captures intermediate state so the EventReplayer can reconstruct
 * which providers have already completed and which still need to run.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { createOperationLogger } from '../logger.js';
import type { LoggingCallback } from '../types.js';
import type { ProviderType, ProviderState } from '../providers/types.js';

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export type EventOperation = 'provision' | 'validate' | 'reconcile' | 'extract_credentials';
export type EventResult = 'success' | 'failure' | 'partial';

export interface StoredEvent {
  event_id: string;
  timestamp: number;
  user_id: string;
  app_id: string;
  provider_id: ProviderType;
  operation: EventOperation;
  input_hash: string;
  result: EventResult;
  error_message?: string;
  intermediate_state?: ProviderState;
}

// ---------------------------------------------------------------------------
// EventStore
// ---------------------------------------------------------------------------

export class EventStore {
  private readonly log: ReturnType<typeof createOperationLogger>;
  private readonly storePath: string;

  constructor(storeDir: string, loggingCallback?: LoggingCallback) {
    this.storePath = path.join(storeDir, 'events.jsonl');
    this.log = createOperationLogger('EventStore', loggingCallback);
  }

  // ---------------------------------------------------------------------------
  // Write
  // ---------------------------------------------------------------------------

  append(event: StoredEvent): void {
    const dir = path.dirname(this.storePath);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.storePath, JSON.stringify(event) + '\n', { mode: 0o600 });
      this.log.debug('Event appended', {
        eventId: event.event_id,
        appId: event.app_id,
        provider: event.provider_id,
        operation: event.operation,
        result: event.result,
      });
    } catch (err) {
      this.log.warn('Failed to append event', { error: (err as Error).message });
    }
  }

  /**
   * Convenience: record a successful operation with its resulting state.
   */
  recordSuccess(
    userId: string,
    appId: string,
    providerId: ProviderType,
    operation: EventOperation,
    input: unknown,
    state?: ProviderState,
  ): string {
    const event: StoredEvent = {
      event_id: crypto.randomUUID(),
      timestamp: Date.now(),
      user_id: userId,
      app_id: appId,
      provider_id: providerId,
      operation,
      input_hash: this.hashInput(input),
      result: state?.partially_complete ? 'partial' : 'success',
      intermediate_state: state,
    };
    this.append(event);
    return event.event_id;
  }

  /**
   * Convenience: record a failed operation.
   */
  recordFailure(
    userId: string,
    appId: string,
    providerId: ProviderType,
    operation: EventOperation,
    input: unknown,
    error: Error,
    partialState?: ProviderState,
  ): string {
    const event: StoredEvent = {
      event_id: crypto.randomUUID(),
      timestamp: Date.now(),
      user_id: userId,
      app_id: appId,
      provider_id: providerId,
      operation,
      input_hash: this.hashInput(input),
      result: 'failure',
      error_message: error.message,
      intermediate_state: partialState,
    };
    this.append(event);
    return event.event_id;
  }

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  /**
   * Reads all events for a given appId, in chronological order.
   */
  readForApp(appId: string): StoredEvent[] {
    return this.readAll().filter(e => e.app_id === appId);
  }

  /**
   * Reads all events.
   */
  readAll(): StoredEvent[] {
    if (!fs.existsSync(this.storePath)) return [];

    try {
      return fs
        .readFileSync(this.storePath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as StoredEvent);
    } catch (err) {
      this.log.warn('Failed to read event store', { error: (err as Error).message });
      return [];
    }
  }

  /**
   * Reads all failed events for an app.
   */
  readFailures(appId: string): StoredEvent[] {
    return this.readForApp(appId).filter(e => e.result === 'failure');
  }

  /**
   * Returns the most recent event for each provider+operation combination.
   */
  getLatestStates(appId: string): Map<string, StoredEvent> {
    const latest = new Map<string, StoredEvent>();
    for (const event of this.readForApp(appId)) {
      const key = `${event.provider_id}::${event.operation}`;
      latest.set(key, event); // later events overwrite earlier ones
    }
    return latest;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private hashInput(input: unknown): string {
    const serialized = typeof input === 'string' ? input : JSON.stringify(input);
    return crypto.createHash('sha256').update(serialized ?? '').digest('hex').slice(0, 16);
  }
}
