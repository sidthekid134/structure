import { computeHash, normalizeConfig } from './hash-calculator';

describe('normalizeConfig', () => {
  it('sorts object keys alphabetically', () => {
    const result = normalizeConfig({ z: 1, a: 2, m: 3 });
    expect(Object.keys(result)).toEqual(['a', 'm', 'z']);
  });

  it('recursively sorts nested object keys', () => {
    const result = normalizeConfig({ b: { z: 1, a: 2 }, a: 'x' });
    const nested = result['b'] as Record<string, unknown>;
    expect(Object.keys(nested)).toEqual(['a', 'z']);
  });

  it('strips timestamp keys', () => {
    const result = normalizeConfig({
      name: 'app',
      createdAt: 999,
      updatedAt: 888,
      lastModified: 777,
      timestamp: 666,
      etag: 'abc',
    });
    expect(result).not.toHaveProperty('createdAt');
    expect(result).not.toHaveProperty('updatedAt');
    expect(result).not.toHaveProperty('lastModified');
    expect(result).not.toHaveProperty('timestamp');
    expect(result).not.toHaveProperty('etag');
    expect(result).toHaveProperty('name');
  });

  it('preserves arrays', () => {
    const result = normalizeConfig({ items: [3, 1, 2] });
    expect(result['items']).toEqual([3, 1, 2]);
  });

  it('preserves null values', () => {
    const result = normalizeConfig({ val: null });
    expect(result['val']).toBeNull();
  });
});

describe('computeHash', () => {
  it('returns a 64-character hex string', () => {
    const hash = computeHash({ name: 'app', bundleId: 'com.example.app' });
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('same config always produces same hash', () => {
    const config = { bundleId: 'com.example.app', name: 'My App', platform: 'IOS' };
    expect(computeHash(config)).toBe(computeHash(config));
  });

  it('different key order produces same hash (normalizes)', () => {
    const h1 = computeHash({ a: 1, b: 2 });
    const h2 = computeHash({ b: 2, a: 1 });
    expect(h1).toBe(h2);
  });

  it('different configs produce different hashes', () => {
    const h1 = computeHash({ name: 'AppA' });
    const h2 = computeHash({ name: 'AppB' });
    expect(h1).not.toBe(h2);
  });

  it('timestamp fields do not affect the hash', () => {
    const h1 = computeHash({ name: 'app', createdAt: 1000 });
    const h2 = computeHash({ name: 'app', createdAt: 9999 });
    expect(h1).toBe(h2);
  });
});
