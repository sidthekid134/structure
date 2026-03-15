/**
 * OperationLogger — structured logging for all adapter operations.
 *
 * Records provision(), validate(), reconcile() calls with:
 *   - timestamp
 *   - user_id
 *   - provider_id
 *   - operation name
 *   - input_hash (SHA-256 of serialized input, never the full input)
 *   - result (success | failure)
 *   - error_message (if failed)
 *   - duration_ms
 *
 * Writes to a rotating JSONL log file alongside the vault.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { createOperationLogger } from './logger.js';
import type { LoggingCallback } from './types.js';
import type { ProviderType } from './providers/types.js';

// ---------------------------------------------------------------------------
// Log entry type
// ---------------------------------------------------------------------------

export interface OperationLogEntry {
  entry_id: string;
  timestamp: number;
  user_id: string;
  provider_id: ProviderType | 'system';
  operation: string;
  input_hash: string;
  result: 'success' | 'failure';
  error_message?: string;
  duration_ms: number;
}

// ---------------------------------------------------------------------------
// OperationLogger
// ---------------------------------------------------------------------------

export class OperationLogger {
  private readonly log: ReturnType<typeof createOperationLogger>;
  private readonly logPath: string;

  constructor(logDir: string, loggingCallback?: LoggingCallback) {
    this.logPath = path.join(logDir, 'operations.jsonl');
    this.log = createOperationLogger('OperationLogger', loggingCallback);
  }

  /**
   * Wraps an async operation, logging start/end with timing.
   */
  async track<T>(
    userId: string,
    providerId: ProviderType | 'system',
    operation: string,
    input: unknown,
    fn: () => Promise<T>,
  ): Promise<T> {
    const inputHash = this.hashInput(input);
    const start = Date.now();

    this.log.debug('Operation started', { userId, providerId, operation, inputHash });

    try {
      const result = await fn();
      const duration = Date.now() - start;

      const entry: OperationLogEntry = {
        entry_id: crypto.randomUUID(),
        timestamp: start,
        user_id: userId,
        provider_id: providerId,
        operation,
        input_hash: inputHash,
        result: 'success',
        duration_ms: duration,
      };

      this.append(entry);
      this.log.info('Operation succeeded', { operation, providerId, duration_ms: duration });

      return result;
    } catch (err) {
      const duration = Date.now() - start;
      const errorMessage = (err as Error).message;

      const entry: OperationLogEntry = {
        entry_id: crypto.randomUUID(),
        timestamp: start,
        user_id: userId,
        provider_id: providerId,
        operation,
        input_hash: inputHash,
        result: 'failure',
        error_message: errorMessage,
        duration_ms: duration,
      };

      this.append(entry);
      this.log.error('Operation failed', {
        operation,
        providerId,
        duration_ms: duration,
        error: errorMessage,
      });

      throw err;
    }
  }

  /**
   * Reads all log entries for a given app.
   */
  readAll(): OperationLogEntry[] {
    if (!fs.existsSync(this.logPath)) return [];

    try {
      return fs
        .readFileSync(this.logPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as OperationLogEntry);
    } catch (err) {
      this.log.warn('Failed to read operation log', { error: (err as Error).message });
      return [];
    }
  }

  /**
   * Returns only failed operation entries.
   */
  readFailures(): OperationLogEntry[] {
    return this.readAll().filter(e => e.result === 'failure');
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private hashInput(input: unknown): string {
    const serialized = JSON.stringify(input) ?? '';
    return crypto.createHash('sha256').update(serialized).digest('hex').slice(0, 16);
  }

  private append(entry: OperationLogEntry): void {
    const dir = path.dirname(this.logPath);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.logPath, JSON.stringify(entry) + '\n', { mode: 0o600 });
    } catch (err) {
      this.log.warn('Failed to write operation log entry', {
        error: (err as Error).message,
      });
    }
  }
}
