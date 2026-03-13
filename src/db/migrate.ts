import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Minimal interface for a node-postgres-compatible client.
 * Accepts any client that exposes a query(sql) method.
 */
export interface DbClient {
  query(sql: string): Promise<unknown>;
}

const SCHEMA_SQL = join(__dirname, 'schema.sql');

/**
 * Runs schema.sql against the provided database client.
 * Safe to call multiple times — all statements use IF NOT EXISTS / IF NOT EXISTS guards.
 */
export async function runMigration(client: DbClient): Promise<void> {
  const sql = readFileSync(SCHEMA_SQL, 'utf8');
  await client.query(sql);
}
