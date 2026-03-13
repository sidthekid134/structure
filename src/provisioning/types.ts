/**
 * Result returned by all provider adapter operations.
 */
export interface ProvisioningResult {
  success: boolean;
  resourceId: string;
  credentials: Record<string, string>;
  metadata: Record<string, any>;
  error: Error | null;
}

/**
 * Configuration passed to a provider adapter.
 * timeout defaults to 30000ms.
 */
export interface ProviderConfig {
  apiKey: string;
  apiSecret?: string | null;
  baseUrl: string;
  timeout: number;
}

/**
 * Minimal database interface for issuing parameterised SQL queries.
 * Implementations can wrap pg.Pool, better-sqlite3, or a test double.
 */
export interface Database {
  query<T extends Record<string, any> = Record<string, any>>(
    sql: string,
    params?: any[],
  ): Promise<{ rows: T[] }>;
}
