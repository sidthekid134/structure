import { SLUG_MAX } from './constants';
import type { ProviderId } from './types';

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    cache: 'no-store',
    ...init,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error || response.statusText);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  const body = await response.text();
  if (!body) {
    return undefined as T;
  }
  return JSON.parse(body) as T;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX);
}

export function bundleFromSlug(slug: string): string {
  return slug ? `com.example.${slug}` : 'com.example';
}

export function providerToBackendKey(providerId: ProviderId): string {
  if (providerId === 'expo') return 'eas';
  return providerId;
}
