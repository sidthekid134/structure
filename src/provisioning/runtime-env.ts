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
