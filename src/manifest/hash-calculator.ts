import { createHash } from 'crypto';

/**
 * Normalizes a config object for stable hashing:
 * - Sorts object keys recursively
 * - Strips timestamp-like keys that change on every request
 */
export function normalizeConfig(config: Record<string, unknown>): Record<string, unknown> {
  const TIMESTAMP_KEYS = new Set(['createdAt', 'updatedAt', 'lastModified', 'timestamp', 'etag']);

  function normalize(value: unknown): unknown {
    if (value === null || typeof value !== 'object') return value;

    if (Array.isArray(value)) {
      return value.map(normalize);
    }

    const obj = value as Record<string, unknown>;
    return Object.keys(obj)
      .filter((k) => !TIMESTAMP_KEYS.has(k))
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = normalize(obj[key]);
        return acc;
      }, {});
  }

  return normalize(config) as Record<string, unknown>;
}

export function computeHash(config: Record<string, unknown>): string {
  const normalized = normalizeConfig(config);
  const json = JSON.stringify(normalized);
  return createHash('sha256').update(json, 'utf8').digest('hex');
}
