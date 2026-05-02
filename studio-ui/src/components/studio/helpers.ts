import { SLUG_MAX } from './constants';
import type { PluginCatalog, ProviderId, ProvisioningGraphNode } from './types';

// ---------------------------------------------------------------------------
// API session (HttpOnly cookie)
// ---------------------------------------------------------------------------
// The daemon sets a `studio_session` cookie via CLI handoff (`#handoff=…`) or
// `POST /api/auth/dev-session` on loopback (tab reloads stay authenticated without passkey).
// All `fetch` calls use `credentials: 'include'`.

/**
 * Construct an authenticated WebSocket using a short-lived token from
 * `GET /api/auth/ws-token` (cookie-authenticated).
 */
export async function authedWebSocket(path: string): Promise<WebSocket> {
  const tokRes = await fetch('/api/auth/ws-token', { credentials: 'include', cache: 'no-store' });
  if (!tokRes.ok) {
    throw new Error(`WebSocket auth failed (HTTP ${tokRes.status}).`);
  }
  const { token } = (await tokRes.json()) as { token: string };
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const sep = path.includes('?') ? '&' : '?';
  const url = `${protocol}://${window.location.host}${path}${sep}token=${encodeURIComponent(token)}`;
  return new WebSocket(url);
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? {});

  const response = await fetch(path, {
    cache: 'no-store',
    credentials: 'include',
    ...init,
    headers,
  });
  if (response.status === 423) {
    const body = (await response.json().catch(() => ({}))) as { code?: string; error?: string };
    window.dispatchEvent(new CustomEvent('studio:vault-sealed', { detail: body }));
    throw new Error(body.error || 'Vault is sealed. Unlock to continue.');
  }
  if (response.status === 401) {
    window.dispatchEvent(new CustomEvent('studio:need-auth'));
  }
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

/**
 * Decode base64url (padding optional) to bytes — matches WebAuthn / SimpleWebAuthn wire encoding.
 */
export function base64UrlToUint8Array(input: string): Uint8Array {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (base64.length % 4)) % 4;
  const padded = base64 + '='.repeat(padLen);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
}

/**
 * `startRegistration` / `startAuthentication` pass server JSON into `navigator.credentials.*` but
 * only binary-encode top-level fields. Web IDL requires `extensions.prf.eval.first` (and optional
 * `second`) as ArrayBufferView, not base64url strings.
 */
export function materializePrfEvalBinaryBuffers(optionsJSON: Record<string, unknown>): void {
  const extensions = optionsJSON.extensions;
  if (!extensions || typeof extensions !== 'object') return;
  const prf = (extensions as Record<string, unknown>).prf;
  if (!prf || typeof prf !== 'object') return;
  const ev = (prf as Record<string, unknown>).eval;
  if (!ev || typeof ev !== 'object') return;
  const evalRec = ev as Record<string, unknown>;
  if (typeof evalRec.first === 'string') {
    evalRec.first = base64UrlToUint8Array(evalRec.first);
  }
  if (typeof evalRec.second === 'string') {
    evalRec.second = base64UrlToUint8Array(evalRec.second);
  }
}

/** Encode PRF binary results so JSON.stringify on the verify POST body preserves them. */
export function encodePrfClientExtensionResultsForTransport(
  clientExtensionResults: Record<string, unknown> | undefined,
): void {
  if (!clientExtensionResults || typeof clientExtensionResults !== 'object') return;
  const prf = clientExtensionResults.prf as Record<string, unknown> | undefined;
  if (!prf || typeof prf !== 'object') return;
  const results = prf.results as Record<string, unknown> | undefined;
  if (!results || typeof results !== 'object') return;
  for (const key of ['first', 'second'] as const) {
    const v = results[key];
    if (v instanceof ArrayBuffer) {
      results[key] = uint8ArrayToBase64Url(new Uint8Array(v));
    } else if (ArrayBuffer.isView(v)) {
      const view = v as ArrayBufferView;
      results[key] = uint8ArrayToBase64Url(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    } else if (
      Array.isArray(v) &&
      v.length > 0 &&
      v.every((x) => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 255)
    ) {
      results[key] = uint8ArrayToBase64Url(new Uint8Array(v as number[]));
    }
  }
}

function uint8ArrayToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
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

const LLM_MODULE_IDS = ['llm-openai', 'llm-anthropic', 'llm-gemini', 'llm-custom'] as const;

/**
 * Returns all module IDs whose id starts with `llm-` from the live plugin
 * catalog. Falls back to the static `LLM_MODULE_IDS` when the catalog is
 * not yet loaded (null).
 */
export function getLlmModuleIds(catalog: PluginCatalog | null): string[] {
  if (!catalog) return [...LLM_MODULE_IDS];
  return Object.keys(catalog.modules).filter((id) => id.startsWith('llm-'));
}

const LLM_NAME_BY_MODULE: Record<(typeof LLM_MODULE_IDS)[number], string> = {
  'llm-openai': 'OpenAI',
  'llm-anthropic': 'Anthropic',
  'llm-gemini': 'Gemini',
  'llm-custom': 'Custom',
};

/**
 * Expo env names written/cleared by `eas:sync-llm-secrets`.
 * Mirrors `PROJECT_LLM_RUNTIME_ENV_KEYS` grouping in `src/provisioning/runtime-env.ts`.
 */
export const LLM_EAS_ENV_KEYS_BY_MODULE: Record<(typeof LLM_MODULE_IDS)[number], readonly string[]> = {
  'llm-openai': ['LLM_OPENAI_API_KEY', 'LLM_OPENAI_ORGANIZATION_ID', 'LLM_OPENAI_DEFAULT_MODEL'],
  'llm-anthropic': ['LLM_ANTHROPIC_API_KEY', 'LLM_ANTHROPIC_DEFAULT_MODEL'],
  'llm-gemini': ['LLM_GEMINI_API_KEY', 'LLM_GEMINI_DEFAULT_MODEL'],
  'llm-custom': ['LLM_CUSTOM_API_KEY', 'LLM_CUSTOM_BASE_URL', 'LLM_CUSTOM_DEFAULT_MODEL'],
};

export function selectedLlmModuleIds(selectedModules?: string[]): (typeof LLM_MODULE_IDS)[number][] {
  const set = new Set(LLM_MODULE_IDS);
  return (selectedModules ?? []).filter((id): id is (typeof LLM_MODULE_IDS)[number] => set.has(id as (typeof LLM_MODULE_IDS)[number]));
}

/** Full env var names synced for the selected llm-* modules (planned order — same module order as in selections). */
export function easEnvKeysForLlmModuleSelection(selectedModules?: string[]): string[] {
  return selectedLlmModuleIds(selectedModules).flatMap((id) => [...LLM_EAS_ENV_KEYS_BY_MODULE[id]]);
}

export function llmEasEnvGroupsForUi(selectedModules?: string[]): { label: string; keys: readonly string[] }[] {
  return selectedLlmModuleIds(selectedModules).map((id) => ({
    label: LLM_NAME_BY_MODULE[id] ?? id,
    keys: LLM_EAS_ENV_KEYS_BY_MODULE[id],
  }));
}

/** Planned-resource card intro for `eas:sync-llm-secrets` — detailed variable names rendered in UI. */
export function easSyncLlmSecretsProduceDescription(selectedModules?: string[]): string {
  const llmIds = selectedLlmModuleIds(selectedModules);
  if (llmIds.length === 0) {
    return (
      'No AI/LLM module in your plan: clears Studio-tracked Expo variables for unused providers on this slot. Add a provider under Modules, Apply, then configure keys.'
    );
  }
  const names = llmIds.map((id) => LLM_NAME_BY_MODULE[id] ?? id).join(' & ');
  return `Upserts each variable named below when its provider is in your plan. Keys for providers not selected are cleared on Expo (${names}).`;
}

/**
 * Step copy that depends on project/plan context. For EAS build profiles, lists
 * environments from project creation (the provisioning plan's `environments` array).
 * For `eas:sync-llm-secrets`, lists selected `llm-*` modules instead of naming every vendor.
 */
export function provisioningNodeDescription(
  node: ProvisioningGraphNode,
  planEnvironments: string[],
  selectedModules?: string[],
): string {
  if (node.key === 'eas:configure-build-profiles') {
    const labels = planEnvironments.map((e) => e.trim()).filter((e) => e.length > 0);
    if (labels.length === 0) {
      return node.description;
    }
    return (
      `Initializes EAS build profile slots for: ${labels.join(', ')}. ` +
      'These are the environments you set when this project was created.'
    );
  }

  if (node.key !== 'eas:sync-llm-secrets') {
    return node.description;
  }

  const llmIds = selectedLlmModuleIds(selectedModules);

  if (llmIds.length === 0) {
    return (
      'Select an AI / LLM module under Modules to sync credentials to Expo. Unselected providers have their prefixed LLM keys cleared on Expo so stale secrets are not kept.'
    );
  }

  const names = llmIds.map((id) => LLM_NAME_BY_MODULE[id] ?? id).join(' & ');
  return (
    `Writes AI/LLM configuration from the vault to Expo for ${names}. Each Expo environment variable name for this project is listed below; values are upserted or cleared per key. Variables for other providers are cleared.`
  );
}
