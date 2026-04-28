import { SLUG_MAX } from './constants';
import type { ProviderId, ProvisioningGraphNode } from './types';

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

/** Matches backend `project-identity` / credential domain validation. */
export function isValidAppHostname(domain: string): boolean {
  const d = domain.trim().toLowerCase();
  if (!d) return false;
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(d);
}

/** Reverse-DNS bundle id from hostname, e.g. `app.example.com` → `com.example.app`. */
export function bundleIdFromAppDomain(hostname: string): string {
  const h = hostname.trim().toLowerCase().replace(/\.+$/g, '');
  if (!h) return '';
  const parts = h.split('.').filter((p) => p.length > 0);
  if (parts.length < 2) return '';
  return [...parts].reverse().join('.');
}

export function providerToBackendKey(providerId: ProviderId): string {
  if (providerId === 'expo') return 'eas';
  return providerId;
}

/**
 * Step copy that depends on project/plan context. For EAS build profiles, lists
 * environments from project creation (the provisioning plan's `environments` array).
 */
export function provisioningNodeDescription(node: ProvisioningGraphNode, planEnvironments: string[]): string {
  if (node.key !== 'eas:configure-build-profiles') {
    return node.description;
  }
  const labels = planEnvironments.map((e) => e.trim()).filter((e) => e.length > 0);
  if (labels.length === 0) {
    return node.description;
  }
  return (
    `Initializes EAS build profile slots for: ${labels.join(', ')}. ` +
    'These are the environments you set when this project was created.'
  );
}
