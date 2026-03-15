/**
 * Idempotency — SHA-256-based key generation and caching.
 *
 * The same (provider, step, inputs) triple always produces the same key,
 * ensuring that retried or resumed operations can detect already-completed
 * work without hitting external provider APIs.
 */

import * as crypto from 'crypto';
import type { ProviderType } from '../providers/types.js';
import type { EventLog } from './event-log.js';
import type { OperationResult } from './types.js';

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

/**
 * Generates a deterministic idempotency key from provider + step + inputs.
 * Identical inputs always produce the same key.
 */
export function generateIdempotencyKey(
  provider: ProviderType,
  step: string,
  inputs: unknown,
): string {
  const payload = `${provider}:${step}:${JSON.stringify(inputs)}`;
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Hashes an OperationResult for storage in the idempotency_keys table.
 * Used to detect if the cached result is still valid.
 */
export function hashResult(result: OperationResult): string {
  const payload = JSON.stringify({
    success: result.success,
    resources_created: result.resources_created,
    secrets_stored: result.secrets_stored,
    provider: result.provider,
  });
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// IdempotencyManager
// ---------------------------------------------------------------------------

export class IdempotencyManager {
  constructor(private readonly eventLog: EventLog) {}

  /**
   * Checks whether a cached result exists for the given key.
   * Returns the cached OperationResult if present, otherwise null.
   */
  checkIdempotency(key: string): { operationId: string; resultHash: string } | null {
    const record = this.eventLog.getIdempotencyRecord(key);
    if (!record) return null;
    return { operationId: record.operation_id, resultHash: record.result_hash };
  }

  /**
   * Caches an OperationResult under the given idempotency key.
   */
  cacheResult(
    key: string,
    operationId: string,
    result: OperationResult,
  ): void {
    const resultHash = hashResult(result);
    this.eventLog.setIdempotencyKey(key, operationId, resultHash);
  }
}
