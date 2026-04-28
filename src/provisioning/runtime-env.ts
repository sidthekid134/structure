import type { CredentialType } from '../services/credential-service.js';

export const PROJECT_RUNTIME_ENV_KEYS = [
  'FIREBASE_API_KEY',
  'FIREBASE_PROJECT_ID',
  'FIREBASE_IOS_APP_ID',
  'FIREBASE_ANDROID_APP_ID',
  'GOOGLE_WEB_CLIENT_ID',
  'GOOGLE_IOS_CLIENT_ID',
  'GOOGLE_ANDROID_CLIENT_ID',
  'APPLE_SERVICE_ID',
  'AUTH_DEEP_LINK_BASE_URL',
  'AUTH_LANDING_URL',
] as const;

export const PROJECT_LLM_RUNTIME_ENV_KEYS = [
  'LLM_OPENAI_API_KEY',
  'LLM_OPENAI_ORGANIZATION_ID',
  'LLM_OPENAI_DEFAULT_MODEL',
  'LLM_ANTHROPIC_API_KEY',
  'LLM_ANTHROPIC_DEFAULT_MODEL',
  'LLM_GEMINI_API_KEY',
  'LLM_GEMINI_DEFAULT_MODEL',
  'LLM_CUSTOM_API_KEY',
  'LLM_CUSTOM_BASE_URL',
  'LLM_CUSTOM_DEFAULT_MODEL',
] as const;

export type EasEnvSecretType = 'PUBLIC' | 'SENSITIVE' | 'SECRET';

export const PROJECT_RUNTIME_ENV_SECRET_TYPES: Record<(typeof PROJECT_RUNTIME_ENV_KEYS)[number], EasEnvSecretType> = {
  FIREBASE_API_KEY: 'SENSITIVE',
  FIREBASE_PROJECT_ID: 'PUBLIC',
  FIREBASE_IOS_APP_ID: 'PUBLIC',
  FIREBASE_ANDROID_APP_ID: 'PUBLIC',
  GOOGLE_WEB_CLIENT_ID: 'PUBLIC',
  GOOGLE_IOS_CLIENT_ID: 'PUBLIC',
  GOOGLE_ANDROID_CLIENT_ID: 'PUBLIC',
  APPLE_SERVICE_ID: 'PUBLIC',
  AUTH_DEEP_LINK_BASE_URL: 'PUBLIC',
  AUTH_LANDING_URL: 'PUBLIC',
};

export const PROJECT_LLM_RUNTIME_ENV_SECRET_TYPES: Record<
  (typeof PROJECT_LLM_RUNTIME_ENV_KEYS)[number],
  EasEnvSecretType
> = {
  LLM_OPENAI_API_KEY: 'SECRET',
  LLM_OPENAI_ORGANIZATION_ID: 'SENSITIVE',
  LLM_OPENAI_DEFAULT_MODEL: 'PUBLIC',
  LLM_ANTHROPIC_API_KEY: 'SECRET',
  LLM_ANTHROPIC_DEFAULT_MODEL: 'PUBLIC',
  LLM_GEMINI_API_KEY: 'SECRET',
  LLM_GEMINI_DEFAULT_MODEL: 'PUBLIC',
  LLM_CUSTOM_API_KEY: 'SECRET',
  LLM_CUSTOM_BASE_URL: 'SENSITIVE',
  LLM_CUSTOM_DEFAULT_MODEL: 'PUBLIC',
};

export interface ProjectRuntimeEnvResolveInput {
  projectId: string;
  upstream: Record<string, string>;
  readVault: (providerId: string, key: string) => string | undefined;
  firebaseApiKeyOverride?: string;
  includesIos?: boolean;
  includesAndroid?: boolean;
}

export interface ProjectRuntimeEnvResolveResult {
  values: Record<string, string>;
  missingRequiredKeys: string[];
}

/** Module ids that select an LLM kind (`llm-openai`, …). */
export const LLM_KIND_MODULE_IDS = [
  'llm-openai',
  'llm-anthropic',
  'llm-gemini',
  'llm-custom',
] as const;

export type LlmKindModuleId = (typeof LLM_KIND_MODULE_IDS)[number];

export function llmModuleIdForEasEnvKey(
  name: (typeof PROJECT_LLM_RUNTIME_ENV_KEYS)[number],
): LlmKindModuleId {
  if (name.startsWith('LLM_OPENAI_')) return 'llm-openai';
  if (name.startsWith('LLM_ANTHROPIC_')) return 'llm-anthropic';
  if (name.startsWith('LLM_GEMINI_')) return 'llm-gemini';
  return 'llm-custom';
}

export interface ProjectLlmRuntimeEnvResolveInput {
  upstream: Record<string, string>;
  readVault: (providerId: string, key: string) => string | undefined;
  /**
   * Optional: Studio stores LLM API keys in SQLite (`llm_*_api_key` credential types)
   * while vault may use `llm`/`{kind}_api_key`. Values are merged vault-first.
   */
  retrieveProjectCredential?: (type: CredentialType) => string | null;
  /**
   * When set, only env vars for these `llm-*` module ids are populated from
   * vault/upstream; vars for other kinds are forced to empty strings so EAS
   * can clear stale entries. When omitted, all four kinds are included
   * (legacy behavior).
   */
  selectedLlmModuleIds?: readonly string[];
}

export interface ProjectLlmRuntimeEnvResolveResult {
  values: Record<string, string>;
}

function firstPresent(...values: Array<string | undefined | null>): string {
  for (const value of values) {
    const trimmed = value?.trim() ?? '';
    if (trimmed) return trimmed;
  }
  return '';
}

function setRuntimeValue(
  out: Record<string, string>,
  missing: string[],
  key: string,
  value: string,
  required: boolean,
): void {
  const trimmed = value.trim();
  out[key] = trimmed;
  if (required && !trimmed) {
    missing.push(key);
  }
}

export function resolveProjectRuntimeEnvValues(
  input: ProjectRuntimeEnvResolveInput,
): ProjectRuntimeEnvResolveResult {
  const upstream = input.upstream;
  const out: Record<string, string> = {};
  const missingRequiredKeys: string[] = [];

  const firebaseApiKey = firstPresent(
    input.firebaseApiKeyOverride,
    input.readVault('firebase', `${input.projectId}/api_key`),
    input.readVault('firebase', 'api_key'),
    upstream['firebase_api_key'],
  );
  const firebaseProjectId = firstPresent(upstream['firebase_project_id'], upstream['gcp_project_id']);
  const firebaseIosAppId = firstPresent(upstream['firebase_ios_app_id']);
  const firebaseAndroidAppId = firstPresent(upstream['firebase_android_app_id']);
  const googleWebClientId = firstPresent(upstream['oauth_client_id_web']);
  const googleIosClientId = firstPresent(upstream['oauth_client_id_ios']);
  const googleAndroidClientId = firstPresent(upstream['oauth_client_id_android']);
  const appleServiceId = firstPresent(upstream['apple_sign_in_service_id']);
  const deepLinkBaseUrl = firstPresent(upstream['deep_link_base_url']);
  const authLandingUrl = firstPresent(upstream['auth_landing_url']);

  setRuntimeValue(out, missingRequiredKeys, 'FIREBASE_API_KEY', firebaseApiKey, true);
  setRuntimeValue(out, missingRequiredKeys, 'FIREBASE_PROJECT_ID', firebaseProjectId, true);
  setRuntimeValue(out, missingRequiredKeys, 'FIREBASE_IOS_APP_ID', firebaseIosAppId, false);
  setRuntimeValue(out, missingRequiredKeys, 'FIREBASE_ANDROID_APP_ID', firebaseAndroidAppId, false);
  // OAuth client IDs are endpoint-specific and intentionally independent.
  // Any subset may be configured without forcing sibling keys.
  setRuntimeValue(out, missingRequiredKeys, 'GOOGLE_WEB_CLIENT_ID', googleWebClientId, false);
  setRuntimeValue(
    out,
    missingRequiredKeys,
    'GOOGLE_IOS_CLIENT_ID',
    googleIosClientId,
    false,
  );
  setRuntimeValue(
    out,
    missingRequiredKeys,
    'GOOGLE_ANDROID_CLIENT_ID',
    googleAndroidClientId,
    false,
  );
  setRuntimeValue(out, missingRequiredKeys, 'APPLE_SERVICE_ID', appleServiceId, false);
  setRuntimeValue(out, missingRequiredKeys, 'AUTH_DEEP_LINK_BASE_URL', deepLinkBaseUrl, false);
  setRuntimeValue(out, missingRequiredKeys, 'AUTH_LANDING_URL', authLandingUrl, false);

  return { values: out, missingRequiredKeys };
}

const LLM_API_KEY_VAULT_TO_CREDENTIAL_TYPE: Record<
  'openai_api_key' | 'anthropic_api_key' | 'gemini_api_key' | 'custom_api_key',
  CredentialType
> = {
  openai_api_key: 'llm_openai_api_key',
  anthropic_api_key: 'llm_anthropic_api_key',
  gemini_api_key: 'llm_gemini_api_key',
  custom_api_key: 'llm_custom_api_key',
};

/** Resolves an LLM vault slot, then falls back to SQLite `project_credentials` API keys. */
function readLlmApiKeyOrVault(
  input: ProjectLlmRuntimeEnvResolveInput,
  shortKey: keyof typeof LLM_API_KEY_VAULT_TO_CREDENTIAL_TYPE,
): string {
  const fromVault = firstPresent(input.readVault('llm', shortKey));
  if (fromVault) return fromVault;
  const ct = LLM_API_KEY_VAULT_TO_CREDENTIAL_TYPE[shortKey];
  if (input.retrieveProjectCredential) {
    const stored = input.retrieveProjectCredential(ct)?.trim() ?? '';
    if (stored) return stored;
  }
  return '';
}

export function resolveProjectLlmRuntimeEnvValues(
  input: ProjectLlmRuntimeEnvResolveInput,
): ProjectLlmRuntimeEnvResolveResult {
  const full: Record<string, string> = {};
  const read = (key: string) => firstPresent(input.readVault('llm', key));
  const upstream = input.upstream;

  setRuntimeValue(full, [], 'LLM_OPENAI_API_KEY', readLlmApiKeyOrVault(input, 'openai_api_key'), false);
  setRuntimeValue(full, [], 'LLM_OPENAI_ORGANIZATION_ID', read('openai_organization_id'), false);
  setRuntimeValue(
    full,
    [],
    'LLM_OPENAI_DEFAULT_MODEL',
    firstPresent(upstream['llm_openai_default_model']),
    false,
  );

  setRuntimeValue(full, [], 'LLM_ANTHROPIC_API_KEY', readLlmApiKeyOrVault(input, 'anthropic_api_key'), false);
  setRuntimeValue(
    full,
    [],
    'LLM_ANTHROPIC_DEFAULT_MODEL',
    firstPresent(upstream['llm_anthropic_default_model']),
    false,
  );

  setRuntimeValue(full, [], 'LLM_GEMINI_API_KEY', readLlmApiKeyOrVault(input, 'gemini_api_key'), false);
  setRuntimeValue(
    full,
    [],
    'LLM_GEMINI_DEFAULT_MODEL',
    firstPresent(upstream['llm_gemini_default_model']),
    false,
  );

  setRuntimeValue(full, [], 'LLM_CUSTOM_API_KEY', readLlmApiKeyOrVault(input, 'custom_api_key'), false);
  setRuntimeValue(full, [], 'LLM_CUSTOM_BASE_URL', read('custom_base_url'), false);
  setRuntimeValue(
    full,
    [],
    'LLM_CUSTOM_DEFAULT_MODEL',
    firstPresent(upstream['llm_custom_default_model']),
    false,
  );

  const picked = input.selectedLlmModuleIds?.filter((id): id is LlmKindModuleId =>
    (LLM_KIND_MODULE_IDS as readonly string[]).includes(id),
  );
  const active = new Set<LlmKindModuleId>(
    picked === undefined ? [...LLM_KIND_MODULE_IDS] : picked.length > 0 ? picked : [],
  );

  const out: Record<string, string> = {};
  for (const key of PROJECT_LLM_RUNTIME_ENV_KEYS) {
    const owner = llmModuleIdForEasEnvKey(key);
    if (active.has(owner)) {
      out[key] = full[key] ?? '';
    } else {
      out[key] = '';
    }
  }

  return { values: out };
}

export function extractFirebaseApiKeyFromAndroidConfig(jsonText: string): string | null {
  try {
    const parsed = JSON.parse(jsonText) as {
      client?: Array<{ api_key?: Array<{ current_key?: string }> }>;
    };
    const clients = parsed.client ?? [];
    for (const client of clients) {
      const key = client.api_key?.find(
        (entry) => typeof entry.current_key === 'string' && entry.current_key.trim().length > 0,
      )?.current_key;
      if (key) return key.trim();
    }
    return null;
  } catch {
    return null;
  }
}

export function extractFirebaseApiKeyFromIosConfig(plistText: string): string | null {
  const match = plistText.match(/<key>\s*API_KEY\s*<\/key>\s*<string>\s*([^<]+)\s*<\/string>/);
  const key = match?.[1]?.trim();
  return key && key.length > 0 ? key : null;
}
