/**
 * EventLog — SQLite-backed operation log for the orchestration engine.
 *
 * Schema:
 *   operations     — top-level run records (app_id, status, timestamps)
 *   events         — per-step records linked to an operation
 *   idempotency_keys — dedup cache for repeated identical requests
 *
 * This class is separate from the JSONL-based EventStore in src/events/store.ts.
 * EventStore tracks raw provider state for resume/replay; EventLog tracks
 * orchestration-level operations for idempotency and audit.
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import type { ProviderType } from '../providers/types.js';
import type { OperationResult } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OperationStatus = 'running' | 'success' | 'failure' | 'partial';

export interface OperationRecord {
  id: string;
  app_id: string;
  status: OperationStatus;
  created_at: number;
  updated_at: number;
}

export interface OperationEvent {
  id: string;
  operation_id: string;
  provider: ProviderType;
  step: string;
  status: 'success' | 'failure' | 'skipped';
  result_json: string | null;
  error_message: string | null;
  timestamp: number;
}

export interface IdempotencyRecord {
  key: string;
  operation_id: string;
  result_hash: string;
  created_at: number;
}

const VALID_PROVIDERS: ReadonlySet<string> = new Set([
  'firebase',
  'github',
  'eas',
  'apple',
  'google-play',
  'cloudflare',
  'oauth',
]);

// ---------------------------------------------------------------------------
// EventLog
// ---------------------------------------------------------------------------

export class EventLog {
  private readonly db: Database.Database;

  constructor(storeDir: string) {
    fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
    const dbPath = path.join(storeDir, 'operations.db');
    this.db = new Database(dbPath);
    // Restrict file permissions to owner-only after creation
    try { fs.chmodSync(dbPath, 0o600); } catch { /* best-effort */ }
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initSchema();
  }

  // ---------------------------------------------------------------------------
  // Schema
  // ---------------------------------------------------------------------------

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS operations (
        id         TEXT PRIMARY KEY,
        app_id     TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'running',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_operations_app_id ON operations(app_id);

      CREATE TABLE IF NOT EXISTS events (
        id           TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL REFERENCES operations(id),
        provider     TEXT NOT NULL,
        step         TEXT NOT NULL,
        status       TEXT NOT NULL,
        result_json  TEXT,
        error_message TEXT,
        timestamp    INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_operation_id ON events(operation_id);
      CREATE INDEX IF NOT EXISTS idx_events_created_at  ON events(timestamp);

      CREATE TABLE IF NOT EXISTS idempotency_keys (
        key          TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        result_hash  TEXT NOT NULL,
        created_at   INTEGER NOT NULL
      );
    `);
  }

  // ---------------------------------------------------------------------------
  // Operations CRUD
  // ---------------------------------------------------------------------------

  createOperation(id: string, appId: string): OperationRecord {
    if (!id) throw new Error('operation id must not be empty');
    if (!appId) throw new Error('app_id must not be empty');

    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO operations (id, app_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, appId, 'running', now, now);

    return { id, app_id: appId, status: 'running', created_at: now, updated_at: now };
  }

  updateOperationStatus(id: string, status: OperationStatus): void {
    this.db
      .prepare('UPDATE operations SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, Date.now(), id);
  }

  getOperation(id: string): OperationRecord | null {
    return (
      (this.db
        .prepare('SELECT * FROM operations WHERE id = ?')
        .get(id) as OperationRecord | undefined) ?? null
    );
  }

  /**
   * Returns all operations, ordered by creation time descending (most recent first).
   */
  listOperations(limit = 100): OperationRecord[] {
    return this.db
      .prepare('SELECT * FROM operations ORDER BY created_at DESC LIMIT ?')
      .all(limit) as OperationRecord[];
  }

  /**
   * Returns all operations for a specific app_id, ordered by creation time descending.
   */
  listOperationsByAppId(appId: string, limit = 50): OperationRecord[] {
    return this.db
      .prepare('SELECT * FROM operations WHERE app_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(appId, limit) as OperationRecord[];
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  /**
   * Appends a single step event to the log.
   * Validates provider against the known enum before writing.
   */
  append(
    operationId: string,
    provider: ProviderType,
    step: string,
    status: OperationEvent['status'],
    result?: OperationResult,
    errorMessage?: string,
  ): void {
    if (!operationId) throw new Error('operation_id must not be empty');
    if (!VALID_PROVIDERS.has(provider)) {
      throw new Error(`Unknown provider: "${provider}". Must be one of: ${[...VALID_PROVIDERS].join(', ')}`);
    }
    if (!step || !step.trim()) throw new Error('step must be a non-empty string');

    const id = `${operationId}-${provider}-${step}-${Date.now()}`;
    this.db
      .prepare(
        `INSERT INTO events (id, operation_id, provider, step, status, result_json, error_message, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        operationId,
        provider,
        step.trim(),
        status,
        result ? JSON.stringify(result) : null,
        errorMessage ?? null,
        Date.now(),
      );
  }

  /**
   * Returns all events for an operation, in chronological order.
   */
  getOperationHistory(operationId: string): OperationEvent[] {
    return this.db
      .prepare('SELECT * FROM events WHERE operation_id = ? ORDER BY timestamp ASC')
      .all(operationId) as OperationEvent[];
  }

  /**
   * Returns the last successful step for a given provider within an operation.
   * Used by the Orchestrator to skip already-completed work when resuming.
   */
  getLastSuccessfulStep(operationId: string, provider: ProviderType): string | null {
    const row = this.db
      .prepare(
        `SELECT step FROM events
         WHERE operation_id = ? AND provider = ? AND status = 'success'
         ORDER BY timestamp DESC
         LIMIT 1`,
      )
      .get(operationId, provider) as { step: string } | undefined;

    return row?.step ?? null;
  }

  // ---------------------------------------------------------------------------
  // Idempotency keys
  // ---------------------------------------------------------------------------

  setIdempotencyKey(key: string, operationId: string, resultHash: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO idempotency_keys (key, operation_id, result_hash, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(key, operationId, resultHash, Date.now());
  }

  getIdempotencyRecord(key: string): IdempotencyRecord | null {
    return (
      (this.db
        .prepare('SELECT * FROM idempotency_keys WHERE key = ?')
        .get(key) as IdempotencyRecord | undefined) ?? null
    );
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  close(): void {
    this.db.close();
  }
}
