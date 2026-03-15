/**
 * Structured logging for vault operations.
 *
 * Sensitive values (passphrases, tokens, raw keys) are NEVER logged.
 * All log entries carry structured context for debugging.
 */

import type { LogEntry, LoggingCallback } from './types.js';

/** Fields that must never appear in log output. */
const SENSITIVE_KEYS = new Set([
  'passphrase',
  'password',
  'secret',
  'key',
  'token',
  'apiKey',
  'privateKey',
  'credentials',
  'value',
]);

/**
 * Strips any sensitive keys from a context object before logging.
 */
function sanitizeContext(
  ctx: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (SENSITIVE_KEYS.has(k)) {
      result[k] = '[REDACTED]';
    } else if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      result[k] = sanitizeContext(v as Record<string, unknown>);
    } else {
      result[k] = v;
    }
  }
  return result;
}

/**
 * Default logging callback — writes to stderr using a simple structured
 * format.  Replace this at the application level as needed.
 */
export const defaultLogger: LoggingCallback = (entry: LogEntry): void => {
  const safe = entry.context ? sanitizeContext(entry.context) : undefined;
  const line = JSON.stringify({ ...entry, context: safe });
  process.stderr.write(line + '\n');
};

/**
 * Creates a log entry and forwards it to the provided callback (or the
 * default logger when none is provided).
 */
export function log(
  level: LogEntry['level'],
  message: string,
  opts?: {
    operation?: string;
    providerId?: string;
    context?: Record<string, unknown>;
    callback?: LoggingCallback;
  },
): void {
  const entry: LogEntry = {
    level,
    message,
    operation: opts?.operation,
    providerId: opts?.providerId,
    timestamp: Date.now(),
    context: opts?.context ? sanitizeContext(opts.context) : undefined,
  };
  (opts?.callback ?? defaultLogger)(entry);
}

/**
 * Returns a partial logger pre-bound to a specific operation name so
 * call-sites don't need to repeat it.
 */
export function createOperationLogger(
  operation: string,
  callback?: LoggingCallback,
) {
  return {
    info: (msg: string, ctx?: Record<string, unknown>) =>
      log('info', msg, { operation, context: ctx, callback }),
    warn: (msg: string, ctx?: Record<string, unknown>) =>
      log('warn', msg, { operation, context: ctx, callback }),
    error: (msg: string, ctx?: Record<string, unknown>) =>
      log('error', msg, { operation, context: ctx, callback }),
    debug: (msg: string, ctx?: Record<string, unknown>) =>
      log('debug', msg, { operation, context: ctx, callback }),
  };
}
