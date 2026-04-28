/**
 * Apple Developer adapter — provisions bundle IDs, certificates, and APNs keys.
 *
 * Apple's APNs keys have a one-time download window; if the window closes before
 * the key is captured, the state is marked as `download_window_closed = true` and
 * the user is directed to manually supply the key via 'platform secret add'.
 */

import * as crypto from 'crypto';
import * as https from 'https';
import {
  ProviderAdapter,
  AppleManifestConfig,
  ProviderState,
  DriftReport,
  DriftDifference,
  ReconcileDirection,
  AdapterError,
  StepContext,
  StepResult,
} from './types.js';
import { createOperationLogger } from '../logger.js';
import type { LoggingCallback } from '../types.js';
import { ExpoGraphqlEasApiClient } from './expo-graphql-eas-client.js';
import {
  mintAppleAppStoreSigningAssets,
  revokeAppleAppStoreSigningAssets,
  type AppleAppStoreSigningAssets,
} from './apple-eas-signing.js';

// ---------------------------------------------------------------------------
// Apple Auth Key registry — unified .p8 store keyed by Apple Key ID
// ---------------------------------------------------------------------------
//
// Apple `.p8` keys are NOT capability-bound: a single key can carry any
// combination of APNs, "Sign In with Apple", DeviceCheck, MusicKit, etc., and
// the user toggles capability checkboxes in Apple Developer → Keys. Treating
// each capability as its own "key" (separate vault entries, separate input
// fields) duplicates state, forces the user to upload the same .p8 twice when
// they reuse a single key for both APNs + SIWA, and couples capability
// management to Firebase-specific consumers.
//
// This registry models reality: ONE map keyed by Apple Key ID (10 uppercase
// alphanumeric chars), each entry storing the PEM and the set of capabilities
// the user has enabled on it in Apple Developer. Both the APNs step and the
// SIWA step write to it; downstream consumers (the Firebase OAuth bridge, a
// future Firebase Messaging APNs bridge, etc.) read it by capability.
//
// Vault layout (single JSON blob — atomic read/write, fits the existing
// VaultManager `(providerId, key) → string` shape):
//
//   <projectId>/apple/auth-keys → JSON { keys: { [keyId]: AppleAuthKeyRecord } }
//
// Legacy single-purpose paths are migrated on first read and then ignored
// (per project-rule: no permanent fallback chains). The Studio REST endpoint
// at /api/projects/:id/integrations/firebase/apple/upload-key still writes
// the legacy paths for backwards compat with non-step flows; on next step
// run those entries will be folded into the registry automatically.

export type AppleKeyCapability = 'apns' | 'sign_in_with_apple';

export const APPLE_KEY_CAPABILITY_LABEL: Record<AppleKeyCapability, string> = {
  apns: 'Apple Push Notification service (APNs)',
  sign_in_with_apple: 'Sign in with Apple',
};

export interface AppleAuthKeyRecord {
  /** PEM-encoded private key (validated server-side before write). */
  p8: string;
  /** Capabilities enabled on this key in Apple Developer Portal. */
  capabilities: AppleKeyCapability[];
  /** ISO timestamp when the registry first saw this key. */
  firstAddedAt: string;
  /** Step key that first registered this auth key (for audit). */
  firstAddedByStep: string;
  /** ISO timestamp of the most recent capability/p8 mutation. */
  lastUpdatedAt: string;
}

export interface AppleAuthKeyRegistry {
  keys: Record<string, AppleAuthKeyRecord>;
}

export function appleAuthKeysVaultPath(projectId: string): string {
  return `${projectId}/apple/auth-keys`;
}

export function appleSignInServiceIdVaultPath(projectId: string): string {
  return `${projectId}/apple/sign-in/service-id`;
}

function emptyRegistry(): AppleAuthKeyRegistry {
  return { keys: {} };
}

/**
 * Post-step reminder explaining the one-time `eas credentials` bootstrap that
 * must happen on a developer machine before CI builds will succeed. See the
 * comment block above `executeStoreSigningInEas` for the full context.
 */
function easCredentialsBootstrapReminder(bundleIdentifier: string): string {
  return (
    `iOS distribution cert + App Store profile are uploaded to EAS for ${bundleIdentifier}. ` +
    'ONE-TIME CI BOOTSTRAP REQUIRED before `eas build --non-interactive` will succeed: ' +
    'from your app repo run `EXPO_TOKEN=<robot token> npx eas-cli@latest credentials -p ios`, ' +
    'pick the production profile, then "Use existing Distribution Certificate" and ' +
    '"Use existing Provisioning Profile" to confirm the ones Studio just uploaded. ' +
    'This flips EAS\'s "validated for non-interactive builds" flag — it is a known EAS bug ' +
    '(https://github.com/expo/eas-cli/issues/3202) for credentials uploaded via the GraphQL API. ' +
    'You only have to do this once per cert (i.e. again when the cert is rotated next year).'
  );
}

function isPlausibleRegistry(value: unknown): value is AppleAuthKeyRegistry {
  if (!value || typeof value !== 'object') return false;
  const v = value as { keys?: unknown };
  return !!v.keys && typeof v.keys === 'object' && !Array.isArray(v.keys);
}

/**
 * Read the registry, transparently folding any legacy single-purpose entries
 * (`<projectId>/apns_key_id` etc.) into it. Writes the migrated registry back
 * to the vault if anything was folded in, then deletes the legacy entries by
 * overwriting them with empty strings — the reader at studio/api-helpers.ts
 * tries multiple provider buckets, so we cannot truly delete, but an empty
 * string is treated the same as "absent" by every call site.
 */
export async function readAppleAuthKeyRegistry(
  context: StepContext,
): Promise<AppleAuthKeyRegistry> {
  const raw = await context.vaultRead(appleAuthKeysVaultPath(context.projectId));
  let registry: AppleAuthKeyRegistry = emptyRegistry();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (isPlausibleRegistry(parsed)) {
        registry = parsed;
      }
    } catch {
      // Corrupt JSON in the vault is a real problem — surface it loudly
      // rather than silently dropping the user's keys on the floor.
      throw new AdapterError(
        `Apple auth key registry at ${appleAuthKeysVaultPath(context.projectId)} is corrupt JSON. ` +
          'Inspect the project vault entry; do not re-run any Apple key step until this is repaired.',
        'apple',
        'readAppleAuthKeyRegistry',
      );
    }
  }
  return migrateLegacyAppleKeys(context, registry);
}

async function migrateLegacyAppleKeys(
  context: StepContext,
  registry: AppleAuthKeyRegistry,
): Promise<AppleAuthKeyRegistry> {
  const now = new Date().toISOString();
  let mutated = false;

  const apnsKeyId = (await context.vaultRead(`${context.projectId}/apns_key_id`))?.trim();
  const apnsP8 = (await context.vaultRead(`${context.projectId}/apns_key_p8`))?.trim();
  if (apnsKeyId && apnsP8) {
    mutated =
      mergeCapabilityIntoRegistry(registry, {
        keyId: apnsKeyId,
        p8: apnsP8,
        capability: 'apns',
        addedByStep: 'apple:generate-apns-key',
        now,
      }) || mutated;
  }

  const siwaKeyId = (
    await context.vaultRead(`${context.projectId}/apple_sign_in_key_id`)
  )?.trim();
  const siwaP8 = (await context.vaultRead(`${context.projectId}/apple_sign_in_p8`))?.trim();
  if (siwaKeyId && siwaP8) {
    mutated =
      mergeCapabilityIntoRegistry(registry, {
        keyId: siwaKeyId,
        p8: siwaP8,
        capability: 'sign_in_with_apple',
        addedByStep: 'apple:create-sign-in-key',
        now,
      }) || mutated;
  }

  if (mutated) {
    await writeAppleAuthKeyRegistry(context, registry);
  }
  return registry;
}

export async function writeAppleAuthKeyRegistry(
  context: StepContext,
  registry: AppleAuthKeyRegistry,
): Promise<void> {
  await context.vaultWrite(
    appleAuthKeysVaultPath(context.projectId),
    JSON.stringify(registry),
  );
}

interface MergeArgs {
  keyId: string;
  p8: string;
  capability: AppleKeyCapability;
  addedByStep: string;
  now: string;
}

function mergeCapabilityIntoRegistry(
  registry: AppleAuthKeyRegistry,
  args: MergeArgs,
): boolean {
  const existing = registry.keys[args.keyId];
  if (!existing) {
    registry.keys[args.keyId] = {
      p8: args.p8,
      capabilities: [args.capability],
      firstAddedAt: args.now,
      firstAddedByStep: args.addedByStep,
      lastUpdatedAt: args.now,
    };
    return true;
  }
  let mutated = false;
  if (!existing.capabilities.includes(args.capability)) {
    existing.capabilities.push(args.capability);
    existing.lastUpdatedAt = args.now;
    mutated = true;
  }
  // Trust newer .p8 if non-empty — the user may have re-uploaded after
  // re-creating the key in Apple Developer. A re-uploaded PEM for the same
  // Key ID always wins over the cached one because Apple Key IDs are
  // append-only: the Key ID never changes for a single creation event.
  if (args.p8 && args.p8 !== existing.p8) {
    existing.p8 = args.p8;
    existing.lastUpdatedAt = args.now;
    mutated = true;
  }
  return mutated;
}

/**
 * Find the first key in the registry that bears the requested capability.
 * Today we only ever expect one key per capability per project (Apple's APNs
 * key cap is 2 active per team total, and SIWA is also typically a single key
 * for the whole app). Return order is insertion order — `Object.values` on a
 * plain object preserves it for string keys.
 */
export function findAuthKeyByCapability(
  registry: AppleAuthKeyRegistry,
  capability: AppleKeyCapability,
): { keyId: string; record: AppleAuthKeyRecord } | null {
  for (const [keyId, record] of Object.entries(registry.keys)) {
    if (record.capabilities.includes(capability)) {
      return { keyId, record };
    }
  }
  return null;
}

const APPLE_KEY_ID_PATTERN = /^[A-Z0-9]{10}$/;
const PEM_BEGIN = '-----BEGIN PRIVATE KEY-----';
const PEM_END = '-----END PRIVATE KEY-----';

export function validateAppleKeyId(keyId: string): string | null {
  if (!APPLE_KEY_ID_PATTERN.test(keyId)) {
    return `Apple Key ID "${keyId}" is not a 10-character uppercase alphanumeric Apple key id (expected something like ABCD1234EF).`;
  }
  return null;
}

export function validateApplePemP8(pem: string): string | null {
  if (!pem.includes(PEM_BEGIN) || !pem.includes(PEM_END)) {
    return 'The .p8 contents are not a PEM-encoded private key (missing BEGIN/END PRIVATE KEY markers). Re-upload the AuthKey_<KEYID>.p8 file Apple gave you.';
  }
  return null;
}

const APPLE_SERVICE_ID_PATTERN = /^[A-Za-z0-9.\-_]+$/;

export function validateAppleServiceId(serviceId: string): string | null {
  if (!APPLE_SERVICE_ID_PATTERN.test(serviceId) || !serviceId.includes('.')) {
    return `Apple Services ID "${serviceId}" is not a valid reverse-DNS identifier (expected something like com.example.app.signin).`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// API client interface
// ---------------------------------------------------------------------------

export interface AppleApiClient {
  createBundleId(bundleId: string, appName: string, teamId: string): Promise<string>;
  getBundleId(bundleId: string): Promise<{ id: string; identifier: string } | null>;
  createCertificate(
    teamId: string,
    type: 'development' | 'distribution',
    csrPem: string,
  ): Promise<{ id: string; certPem: string }>;
  getCertificates(teamId: string): Promise<Array<{ id: string; type: string; expiresAt: number }>>;
  createApnsKey(teamId: string): Promise<{ keyId: string; privateKeyP8: string }>;
  getApnsKeys(teamId: string): Promise<Array<{ keyId: string }>>;
}

export class StubAppleApiClient implements AppleApiClient {
  async createBundleId(_bundleId: string, _appName: string, _teamId: string): Promise<string> {
    throw new Error(
      'StubAppleApiClient cannot create App IDs. Configure AppleAdapter with a real Apple API client.',
    );
  }

  async getBundleId(
    _bundleId: string,
  ): Promise<{ id: string; identifier: string } | null> {
    throw new Error(
      'StubAppleApiClient cannot query App IDs. Configure AppleAdapter with a real Apple API client.',
    );
  }

  async createCertificate(
    _teamId: string,
    _type: 'development' | 'distribution',
    _csrPem: string,
  ): Promise<{ id: string; certPem: string }> {
    throw new Error(
      'StubAppleApiClient cannot create certificates. Configure AppleAdapter with a real Apple API client.',
    );
  }

  async getCertificates(
    _teamId: string,
  ): Promise<Array<{ id: string; type: string; expiresAt: number }>> {
    throw new Error(
      'StubAppleApiClient cannot list certificates. Configure AppleAdapter with a real Apple API client.',
    );
  }

  async createApnsKey(
    _teamId: string,
  ): Promise<{ keyId: string; privateKeyP8: string }> {
    throw new Error(
      'StubAppleApiClient cannot create APNs keys. Configure AppleAdapter with a real Apple API client.',
    );
  }

  async getApnsKeys(_teamId: string): Promise<Array<{ keyId: string }>> {
    throw new Error(
      'StubAppleApiClient cannot list APNs keys. Configure AppleAdapter with a real Apple API client.',
    );
  }
}

export type AppleAscAuth = {
  issuerId: string;
  keyId: string;
  privateKeyP8: string;
};

type AppleApiError = {
  status?: string;
  code?: string;
  title?: string;
  detail?: string;
};

type AppleApiEnvelope<T> = {
  data?: T;
  errors?: AppleApiError[];
};

function toBase64Url(value: Buffer | string): string {
  const b64 = Buffer.isBuffer(value) ? value.toString('base64') : Buffer.from(value).toString('base64');
  return b64.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signAppStoreConnectJwt(auth: AppleAscAuth): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', kid: auth.keyId, typ: 'JWT' };
  const payload = {
    iss: auth.issuerId,
    iat: now,
    exp: now + 19 * 60,
    aud: 'appstoreconnect-v1',
  };
  const encodedHeader = toBase64Url(JSON.stringify(header));
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  // JWS ES256 (RFC 7515 §3.4) requires the raw IEEE P1363 r||s form (64 bytes
  // for P-256). Node's crypto.sign() defaults to DER-encoded ECDSA, which
  // Apple decodes as garbage and rejects as 401 NOT_AUTHORIZED. Force the
  // P1363 encoding so Apple can verify the signature against the public key
  // it has on file for `kid`.
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: crypto.createPrivateKey(auth.privateKeyP8),
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${toBase64Url(signature)}`;
}

/**
 * Verify a freshly-supplied App Store Connect Team Key against Apple before we
 * persist it. We hit /v1/users?limit=1 because every ASC API key role (Admin,
 * Developer, App Manager, Marketing, etc.) has at least Read access to that
 * endpoint, so a 200 confirms issuerId/keyId/.p8 align with what Apple has on
 * file. The function rethrows the actionable 401 message produced by
 * requestAppStoreConnect.
 */
export async function verifyAscApiCredentials(auth: AppleAscAuth): Promise<void> {
  await requestAppStoreConnect<AppleApiEnvelope<unknown>>(auth, 'GET', '/v1/users?limit=1');
}

async function requestAppStoreConnect<T>(
  auth: AppleAscAuth,
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const token = signAppStoreConnectJwt(auth);
  const payload = body ? JSON.stringify(body) : undefined;

  // Apple's API has no published latency SLO, but every endpoint we hit (read
  // bundle IDs, create bundle ID, list users, etc.) responds in well under
  // 10s in steady state. A 30s ceiling guards against socket hangs / NAT
  // idle drops that would otherwise stall the orchestrator forever.
  const REQUEST_TIMEOUT_MS = 30_000;

  return await new Promise<T>((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.appstoreconnect.apple.com',
        method,
        path,
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(payload
            ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload).toString(),
            }
            : {}),
        },
      },
      (res) => {
        let responseBody = '';
        res.on('data', (chunk: Buffer) => {
          responseBody += chunk.toString('utf8');
        });
        res.on('end', () => {
          const statusCode = res.statusCode ?? 0;
          if (statusCode < 200 || statusCode >= 300) {
            const truncated = responseBody.slice(0, 500) || 'empty response body';
            if (statusCode === 401) {
              reject(
                new Error(
                  `Apple App Store Connect rejected the API credentials (401 NOT_AUTHORIZED). ` +
                    `Apple's response: ${truncated}\n\n` +
                    `The .p8 parses as a valid PKCS#8 key, so Apple verified the JWT signature and rejected its claims. Likely causes (most common first):\n` +
                    `  1) Wrong Issuer ID — the App Store Connect Team Key issuer is shown at App Store Connect → Users and Access → Integrations → App Store Connect API → "Issuer ID" header. It is NOT the Apple Developer Team ID.\n` +
                    `  2) Wrong Key ID — the Key ID in the org integration must match the .p8 you uploaded. Studio auto-fills it from the AuthKey_<KEYID>.p8 filename; if the file was renamed, set it manually.\n` +
                    `  3) Wrong key type — App Store Connect Team Keys, "Sign In with Apple" keys, and APNs keys all download as AuthKey_<KEYID>.p8 but only Team Keys authenticate against /v1/* App Store Connect endpoints.\n` +
                    `Reconnect the org-level Apple integration with the correct Issuer ID, Key ID, and .p8 to retry.`,
                ),
              );
              return;
            }
            reject(
              new Error(
                `Apple API ${method} ${path} failed (${statusCode}): ${truncated}`,
              ),
            );
            return;
          }
          if (!responseBody) {
            resolve({} as T);
            return;
          }
          try {
            resolve(JSON.parse(responseBody) as T);
          } catch (error) {
            reject(
              new Error(
                `Apple API ${method} ${path} returned invalid JSON: ${(error as Error).message}`,
              ),
            );
          }
        });
      },
    );
    req.on('error', (error) => reject(new Error(`Apple API request failed: ${error.message}`)));
    req.on('timeout', () => {
      req.destroy(
        new Error(
          `Apple API ${method} https://api.appstoreconnect.apple.com${path} timed out after ${REQUEST_TIMEOUT_MS}ms (no response from Apple). ` +
            'Re-run the step; if it persists, check api.appstoreconnect.apple.com reachability and retry.',
        ),
      );
    });
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Apple adapter
// ---------------------------------------------------------------------------

export class AppleAdapter implements ProviderAdapter<AppleManifestConfig> {
  private readonly log: ReturnType<typeof createOperationLogger>;

  constructor(
    private readonly apiClient: AppleApiClient = new StubAppleApiClient(),
    loggingCallback?: LoggingCallback,
  ) {
    this.log = createOperationLogger('AppleAdapter', loggingCallback);
  }

  private async readVaultSecret(
    context: StepContext,
    key: string,
    options?: { includeAppleScope?: boolean; includeProjectScope?: boolean },
  ): Promise<string | undefined> {
    const includeAppleScope = options?.includeAppleScope ?? true;
    const includeProjectScope = options?.includeProjectScope ?? true;
    if (includeAppleScope) {
      const shared = (await context.vaultRead(`apple/${key}`))?.trim();
      if (shared) return shared;
    }
    if (includeProjectScope) {
      const project = (await context.vaultRead(`${context.projectId}/${key}`))?.trim();
      if (project) return project;
    }
    return undefined;
  }

  private async readAscIssuerId(context: StepContext): Promise<string | undefined> {
    return (
      (await this.readVaultSecret(context, 'asc_issuer_id')) ??
      (await this.readVaultSecret(context, 'app_store_connect_issuer_id'))
    );
  }

  private async readAscAuth(context: StepContext): Promise<AppleAscAuth | null> {
    const issuerId = await this.readAscIssuerId(context);
    const keyId =
      context.upstreamResources['asc_api_key_id']?.trim() ||
      (await this.readVaultSecret(context, 'asc_api_key_id'));
    const privateKeyP8 =
      (await this.readVaultSecret(context, 'asc_api_key_p8')) ||
      (context.upstreamResources['asc_api_key_p8']?.trim() !== 'vaulted'
        ? context.upstreamResources['asc_api_key_p8']?.trim()
        : undefined);

    if (!issuerId || !keyId || !privateKeyP8) {
      return null;
    }
    return { issuerId, keyId, privateKeyP8 };
  }

  private async getBundleIdByIdentifier(
    auth: AppleAscAuth,
    identifier: string,
  ): Promise<{ id: string; identifier: string } | null> {
    // Apple's ASC API documents the filter parameter as filter[identifier]=...
    // with literal brackets. Percent-encoding them as %5B/%5D causes the
    // parser to treat the parameter name as unrecognized and silently apply
    // no filter, so the response contains the first bundle in the team
    // regardless of what we asked for. Send raw brackets and request the
    // identifier attribute explicitly so we can verify the match below.
    // Use limit=200 (the API max) so that even if filter is somehow ignored
    // we still scan a representative window before falling back to create.
    const path =
      `/v1/bundleIds?filter[identifier]=${encodeURIComponent(identifier)}` +
      `&fields[bundleIds]=identifier,name,platform&limit=200`;
    const response = await requestAppStoreConnect<
      AppleApiEnvelope<
        Array<{ id: string; attributes?: { identifier?: string } }>
      >
    >(auth, 'GET', path);
    const data = response.data ?? [];
    // Exact match against the returned identifier — never trust position.
    const match = data.find((row) => row.attributes?.identifier === identifier);
    if (!match) {
      return null;
    }
    return { id: match.id, identifier: match.attributes!.identifier! };
  }

  private async createBundleIdInAsc(
    auth: AppleAscAuth,
    identifier: string,
    appName: string,
  ): Promise<string> {
    const response = await requestAppStoreConnect<AppleApiEnvelope<{ id: string }>>(
      auth,
      'POST',
      '/v1/bundleIds',
      {
        data: {
          type: 'bundleIds',
          attributes: {
            identifier,
            name: appName,
            platform: 'IOS',
          },
        },
      },
    );
    const created = response.data?.id;
    if (!created) {
      throw new AdapterError(
        'Apple API did not return a bundle ID resource id.',
        'apple',
        'executeStep',
      );
    }
    return created;
  }

  private async getAppStoreAppByBundleIdentifier(
    auth: AppleAscAuth,
    bundleIdentifier: string,
  ): Promise<{ id: string; name?: string; bundleId?: string } | null> {
    // Per Apple's "List Apps" docs, GET /v1/apps?filter[bundleId]=...
    // expects the *reverse-DNS bundle identifier string* (e.g.
    // "net.third-brain.flow"), NOT the bundle ID resource id (e.g.
    // "N546G6FN9M"). Passing the resource id silently returns zero
    // matches. Same caveat as getBundleIdByIdentifier: brackets must be
    // raw, otherwise Apple's parser ignores the filter and returns the
    // first row of the team's apps list (which we'd misread as a match).
    const path =
      `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleIdentifier)}` +
      `&fields[apps]=name,bundleId,sku&limit=200`;
    const response = await requestAppStoreConnect<
      AppleApiEnvelope<
        Array<{
          id: string;
          attributes?: { name?: string; bundleId?: string; sku?: string };
        }>
      >
    >(auth, 'GET', path);
    // Verify by string equality so an unfiltered response (e.g. if Apple
    // ever silently drops the filter) cannot masquerade as a match.
    const data = response.data ?? [];
    const match = data.find((row) => row.attributes?.bundleId === bundleIdentifier);
    if (!match) return null;
    return {
      id: match.id,
      name: match.attributes?.name,
      bundleId: match.attributes?.bundleId,
    };
  }

  // -------------------------------------------------------------------------
  // TestFlight beta groups + testers
  // -------------------------------------------------------------------------
  //
  // Apple's App Store Connect API exposes full CRUD over TestFlight beta
  // groups and testers under /v1/betaGroups and /v1/betaTesters. We use it
  // to materialise a default group on the app so that EAS Submit (and any
  // manual TestFlight build assignment) has a target group to attach builds
  // to without requiring the user to click into App Store Connect first.
  //
  // Group type:
  //   - We always create EXTERNAL groups. Internal groups can only contain
  //     users who are already in the App Store Connect team with a TestFlight
  //     role; the API will reject createBetaTester with a HUMAN_VERIFICATION
  //     error if you try to add an arbitrary email to an internal group.
  //     External groups accept any email and are the right choice for the
  //     "add my QA + my own email" workflow.
  //   - First build submitted to an external group requires Beta App Review
  //     to clear before testers can install. That's outside this step's
  //     scope; it's a one-time gate the user manages in ASC's TestFlight tab.
  //
  // Idempotency: rerunning this step with the same group name reuses the
  // existing group, and only adds testers that aren't already in it. This
  // keeps the step safe for repeated provisioning runs.
  private async findBetaGroupByName(
    auth: AppleAscAuth,
    ascAppId: string,
    name: string,
  ): Promise<{ id: string; name: string; isInternalGroup: boolean } | null> {
    const path =
      `/v1/betaGroups?filter[app]=${encodeURIComponent(ascAppId)}` +
      `&filter[name]=${encodeURIComponent(name)}` +
      `&fields[betaGroups]=name,isInternalGroup&limit=200`;
    const response = await requestAppStoreConnect<
      AppleApiEnvelope<
        Array<{
          id: string;
          attributes?: { name?: string; isInternalGroup?: boolean };
        }>
      >
    >(auth, 'GET', path);
    const data = response.data ?? [];
    const match = data.find((row) => row.attributes?.name === name);
    if (!match) return null;
    return {
      id: match.id,
      name: match.attributes!.name!,
      isInternalGroup: !!match.attributes?.isInternalGroup,
    };
  }

  private async createBetaGroup(
    auth: AppleAscAuth,
    ascAppId: string,
    name: string,
    isInternalGroup: boolean,
  ): Promise<{ id: string; name: string; isInternalGroup: boolean }> {
    // Apple's createBetaGroup payload differs by group type:
    //   - Internal groups: only `name` + `isInternalGroup: true` are valid;
    //     publicLink* attributes are external-only and Apple rejects them
    //     with ENTITY_ERROR.ATTRIBUTE_INVALID when set on an internal group.
    //   - External groups: omit `isInternalGroup` (defaults to false) and
    //     send the publicLink* attrs so we can later toggle them if needed.
    const attributes: Record<string, unknown> = { name };
    if (isInternalGroup) {
      attributes['isInternalGroup'] = true;
      // Mirrors ASC's "Enable automatic distribution" toggle for internal groups.
      attributes['hasAccessToAllBuilds'] = true;
    } else {
      attributes['publicLinkEnabled'] = false;
      attributes['publicLinkLimitEnabled'] = false;
    }
    const response = await requestAppStoreConnect<
      AppleApiEnvelope<{
        id: string;
        attributes?: { name?: string; isInternalGroup?: boolean };
      }>
    >(auth, 'POST', '/v1/betaGroups', {
      data: {
        type: 'betaGroups',
        attributes,
        relationships: {
          app: { data: { type: 'apps', id: ascAppId } },
        },
      },
    });
    const created = response.data;
    if (!created?.id) {
      throw new AdapterError(
        `Apple App Store Connect did not return a betaGroups resource id when creating group "${name}".`,
        'apple',
        'apple:configure-testflight-group',
      );
    }
    return {
      id: created.id,
      name: created.attributes?.name ?? name,
      isInternalGroup: !!created.attributes?.isInternalGroup,
    };
  }

  /**
   * Look up an App Store Connect *user* (Users and Access) by email. Internal
   * TestFlight testers MUST be existing ASC users — Apple rejects createBetaTester
   * on an internal group otherwise. The /v1/users endpoint exposes ASC team
   * members; the username is the email address they signed in with.
   */
  private async findAscUserByEmail(
    auth: AppleAscAuth,
    email: string,
  ): Promise<{ id: string; firstName?: string; lastName?: string } | null> {
    const path =
      `/v1/users?filter[username]=${encodeURIComponent(email)}` +
      `&fields[users]=username,firstName,lastName,roles&limit=10`;
    const response = await requestAppStoreConnect<
      AppleApiEnvelope<
        Array<{
          id: string;
          attributes?: {
            username?: string;
            firstName?: string;
            lastName?: string;
          };
        }>
      >
    >(auth, 'GET', path);
    const data = response.data ?? [];
    const lowered = email.toLowerCase();
    const match = data.find(
      (row) => row.attributes?.username?.toLowerCase() === lowered,
    );
    if (!match) return null;
    return {
      id: match.id,
      firstName: match.attributes?.firstName,
      lastName: match.attributes?.lastName,
    };
  }

  private async findBetaTesterByEmail(
    auth: AppleAscAuth,
    email: string,
  ): Promise<{ id: string } | null> {
    const path =
      `/v1/betaTesters?filter[email]=${encodeURIComponent(email)}` +
      `&fields[betaTesters]=email&limit=10`;
    const response = await requestAppStoreConnect<
      AppleApiEnvelope<Array<{ id: string; attributes?: { email?: string } }>>
    >(auth, 'GET', path);
    const data = response.data ?? [];
    // Apple normalises emails case-insensitively; do the same here so a
    // user typed in mixed case still matches what Apple has on file.
    const lowered = email.toLowerCase();
    const match = data.find(
      (row) => row.attributes?.email?.toLowerCase() === lowered,
    );
    if (!match) return null;
    return { id: match.id };
  }

  private async createBetaTester(
    auth: AppleAscAuth,
    args: { email: string; firstName?: string; lastName?: string; betaGroupId: string },
  ): Promise<{ id: string }> {
    const response = await requestAppStoreConnect<
      AppleApiEnvelope<{ id: string }>
    >(auth, 'POST', '/v1/betaTesters', {
      data: {
        type: 'betaTesters',
        attributes: {
          email: args.email,
          firstName: args.firstName ?? 'TestFlight',
          lastName: args.lastName ?? 'Tester',
        },
        relationships: {
          betaGroups: {
            data: [{ type: 'betaGroups', id: args.betaGroupId }],
          },
        },
      },
    });
    if (!response.data?.id) {
      throw new AdapterError(
        `Apple App Store Connect did not return a betaTesters resource id when creating tester "${args.email}".`,
        'apple',
        'apple:configure-testflight-group',
      );
    }
    return { id: response.data.id };
  }

  private async listBetaGroupTesterEmails(
    auth: AppleAscAuth,
    betaGroupId: string,
  ): Promise<Set<string>> {
    // List testers directly under the group so we can verify membership by email.
    // Using include/fields keeps payload small while still exposing attributes.email.
    const path =
      `/v1/betaGroups/${encodeURIComponent(betaGroupId)}/betaTesters` +
      `?fields[betaTesters]=email&limit=200`;
    const response = await requestAppStoreConnect<
      AppleApiEnvelope<Array<{ id: string; attributes?: { email?: string } }>>
    >(auth, 'GET', path);
    const emails = new Set<string>();
    for (const tester of response.data ?? []) {
      const email = tester.attributes?.email?.trim().toLowerCase();
      if (email) emails.add(email);
    }
    return emails;
  }

  private async addTesterToBetaGroup(
    auth: AppleAscAuth,
    betaGroupId: string,
    betaTesterId: string,
  ): Promise<void> {
    await requestAppStoreConnect<unknown>(
      auth,
      'POST',
      `/v1/betaGroups/${encodeURIComponent(betaGroupId)}/relationships/betaTesters`,
      {
        data: [{ type: 'betaTesters', id: betaTesterId }],
      },
    );
  }

  private async ensureTesterInBetaGroup(
    auth: AppleAscAuth,
    args: {
      betaGroupId: string;
      email: string;
      firstName?: string;
      lastName?: string;
      addedEmails: string[];
      reusedEmails: string[];
    },
  ): Promise<void> {
    const existingTester = await this.findBetaTesterByEmail(auth, args.email);
    const testerId = existingTester
      ? existingTester.id
      : (
        await this.createBetaTester(auth, {
          email: args.email,
          firstName: args.firstName,
          lastName: args.lastName,
          betaGroupId: args.betaGroupId,
        })
      ).id;

    try {
      // Always attach explicitly. Relying on createBetaTester relationship linkage
      // alone is not reliable across Apple ASC API behavior.
      await this.addTesterToBetaGroup(auth, args.betaGroupId, testerId);
      args.addedEmails.push(args.email);
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('409') || message.toLowerCase().includes('already')) {
        args.reusedEmails.push(args.email);
        return;
      }
      throw err;
    }
  }

  private parseTesterEmails(raw: string | undefined): string[] {
    if (!raw) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const part of raw.split(/[\s,;\n]+/)) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const lowered = trimmed.toLowerCase();
      if (seen.has(lowered)) continue;
      // Cheap email shape check — Apple's API will reject malformed addresses
      // anyway, but failing fast here gives a much clearer error than the
      // ENTITY_ERROR.ATTRIBUTE_INVALID Apple returns.
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
        throw new AdapterError(
          `Tester email "${trimmed}" is not a valid email address. Fix the testflight_tester_emails input and re-run.`,
          'apple',
          'apple:configure-testflight-group',
        );
      }
      seen.add(lowered);
      out.push(trimmed);
    }
    return out;
  }

  private async executeConfigureTestFlightGroup(
    context: StepContext,
    config: AppleManifestConfig,
  ): Promise<StepResult> {
    const ascAppId =
      context.upstreamResources['asc_app_id']?.trim() ||
      (await context.vaultRead(`${context.projectId}/asc_app_id`))?.trim();
    if (!ascAppId) {
      return {
        status: 'failed',
        resourcesProduced: {},
        error:
          'TestFlight group setup requires asc_app_id from "Create App Store Connect Listing". Run that step first.',
      };
    }

    const auth = await this.readAscAuth(context);
    if (!auth) {
      throw new AdapterError(
        'TestFlight group setup requires App Store Connect API credentials (asc_issuer_id, asc_api_key_id, asc_api_key_p8) from the org-level Apple integration. Reconnect the Apple integration in Studio and retry.',
        'apple',
        'apple:configure-testflight-group',
      );
    }

    const requestedName =
      context.upstreamResources['testflight_group_name']?.trim() ||
      `${config.app_name} Testers`;
    const requestedTypeRaw =
      context.upstreamResources['testflight_group_type']?.trim().toLowerCase() ||
      'internal';
    if (requestedTypeRaw !== 'internal' && requestedTypeRaw !== 'external') {
      return {
        status: 'failed',
        resourcesProduced: {},
        error: `testflight_group_type must be 'internal' or 'external'; got "${requestedTypeRaw}".`,
      };
    }
    const wantInternal = requestedTypeRaw === 'internal';
    const testerEmails = this.parseTesterEmails(
      context.upstreamResources['testflight_tester_emails'],
    );

    this.log.info('Resolving TestFlight beta group', {
      ascAppId,
      name: requestedName,
      type: requestedTypeRaw,
      testerCount: testerEmails.length,
    });

    let group = await this.findBetaGroupByName(auth, ascAppId, requestedName);
    let createdGroup = false;
    if (!group) {
      group = await this.createBetaGroup(auth, ascAppId, requestedName, wantInternal);
      createdGroup = true;
      this.log.info('Created TestFlight beta group', {
        ascAppId,
        groupId: group.id,
        name: group.name,
        isInternalGroup: group.isInternalGroup,
      });
    } else {
      this.log.info('Reusing existing TestFlight beta group', {
        ascAppId,
        groupId: group.id,
        name: group.name,
        isInternalGroup: group.isInternalGroup,
      });
      // Apple does not support flipping a group between internal/external
      // after creation — the only path is delete + recreate. Surface the
      // mismatch loudly so the user can decide rather than silently
      // pretending we honoured their requested type.
      if (group.isInternalGroup !== wantInternal) {
        return {
          status: 'failed',
          resourcesProduced: {},
          error:
            `TestFlight group "${requestedName}" already exists as ${group.isInternalGroup ? 'INTERNAL' : 'EXTERNAL'} on ASC app ${ascAppId}, ` +
            `but the step is configured for ${wantInternal ? 'INTERNAL' : 'EXTERNAL'}. ` +
            `Apple does not support changing group type after creation. ` +
            `Either change the testflight_group_type input to match, pick a different testflight_group_name, ` +
            `or delete the existing group in App Store Connect → TestFlight → Groups and re-run.`,
        };
      }
    }

    const addedEmails: string[] = [];
    const reusedEmails: string[] = [];
    if (wantInternal) {
      // Internal groups: every tester MUST already be an App Store Connect
      // user with the "Access to TestFlight" role. Apple's createBetaTester
      // rejects unknown emails on internal groups with a confusing
      // ENTITY_ERROR.RELATIONSHIP.INVALID. Pre-flight by looking each email
      // up in /v1/users so we can fail with a clear, actionable error.
      const missing: string[] = [];
      type AscUser = { email: string; id: string; firstName?: string; lastName?: string };
      const resolvedUsers: AscUser[] = [];
      for (const email of testerEmails) {
        const user = await this.findAscUserByEmail(auth, email);
        if (!user) {
          missing.push(email);
        } else {
          resolvedUsers.push({ email, ...user });
        }
      }
      if (missing.length > 0) {
        return {
          status: 'failed',
          resourcesProduced: {
            testflight_group_id: group.id,
            testflight_group_name: group.name,
          },
          error:
            `These tester emails are not App Store Connect users and cannot be added to an internal TestFlight group: ${missing.join(', ')}. ` +
            `Internal testers must first be invited as ASC users at https://appstoreconnect.apple.com/access/users (Users and Access → Add User → grant Developer/App Manager/Marketing/Customer Support role with "Access to TestFlight" enabled). ` +
            `After they accept the invitation, re-run this step. ` +
            `Alternatively, switch testflight_group_type to "external" if you want to invite arbitrary emails (Beta App Review required on first build).`,
        };
      }
      for (const user of resolvedUsers) {
        await this.ensureTesterInBetaGroup(auth, {
          betaGroupId: group.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          addedEmails,
          reusedEmails,
        });
      }
    } else {
      for (const email of testerEmails) {
        await this.ensureTesterInBetaGroup(auth, {
          betaGroupId: group.id,
          email,
          addedEmails,
          reusedEmails,
        });
      }
    }

    // Hard verification: every requested tester must now appear on the group.
    // Apple can take a brief moment to index new tester->group links; retry a
    // few times and fail loudly if any are still missing.
    if (testerEmails.length > 0) {
      const requestedLower = testerEmails.map((e) => e.toLowerCase());
      let missingLower = new Set<string>(requestedLower);
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = await this.listBetaGroupTesterEmails(auth, group.id);
        missingLower = new Set(requestedLower.filter((email) => !current.has(email)));
        if (missingLower.size === 0) break;
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
      if (missingLower.size > 0) {
        const missing = testerEmails.filter((email) => missingLower.has(email.toLowerCase()));
        throw new AdapterError(
          `TestFlight group "${group.name}" was created but these testers are still not in the group after add attempts: ${missing.join(', ')}. ` +
            `Open https://appstoreconnect.apple.com/apps/${ascAppId}/testflight/groups/${group.id} to confirm membership and retry.`,
          'apple',
          'apple:configure-testflight-group',
        );
      }
    }

    // Verify by re-fetching the group via Apple's API. This catches the
    // (rare) case where the POST returned 201 but the group landed on a
    // different app than expected, or against a stale ASC cache.
    const verifyPath =
      `/v1/betaGroups/${encodeURIComponent(group.id)}` +
      `?fields[betaGroups]=name,isInternalGroup,createdDate&include=app` +
      `&fields[apps]=name,bundleId`;
    let verifiedAppName: string | undefined;
    let verifiedBundleId: string | undefined;
    try {
      const verify = await requestAppStoreConnect<
        AppleApiEnvelope<{
          id: string;
          attributes?: { name?: string };
          relationships?: { app?: { data?: { id?: string } } };
        }> & {
          included?: Array<{
            type: string;
            id: string;
            attributes?: { name?: string; bundleId?: string };
          }>;
        }
      >(auth, 'GET', verifyPath);
      const linkedAppId = verify.data?.relationships?.app?.data?.id;
      const includedApp = verify.included?.find(
        (row) => row.type === 'apps' && row.id === linkedAppId,
      );
      verifiedAppName = includedApp?.attributes?.name;
      verifiedBundleId = includedApp?.attributes?.bundleId;
      if (linkedAppId && linkedAppId !== ascAppId) {
        // This should be impossible — we POSTed against `ascAppId` — but if
        // Apple ever returns a different app, surface it loudly rather than
        // pretend everything worked.
        throw new AdapterError(
          `Created TestFlight group "${group.name}" (id ${group.id}) is attached to ASC app "${linkedAppId}" but Studio expected "${ascAppId}". Aborting so you can investigate.`,
          'apple',
          'apple:configure-testflight-group',
        );
      }
    } catch (err) {
      if (err instanceof AdapterError) throw err;
      this.log.warn('Could not verify TestFlight beta group after creation', {
        groupId: group.id,
        error: (err as Error).message,
      });
    }

    const directGroupUrl = `https://appstoreconnect.apple.com/apps/${ascAppId}/testflight/groups/${group.id}`;
    const groupTypeLabel = group.isInternalGroup ? 'INTERNAL' : 'EXTERNAL';
    const summaryParts: string[] = [
      createdGroup
        ? `Created ${groupTypeLabel} TestFlight group "${group.name}"`
        : `Reusing existing ${groupTypeLabel} TestFlight group "${group.name}"`,
      `(id ${group.id}) on ASC app "${verifiedAppName ?? ascAppId}"${verifiedBundleId ? ` (bundle ${verifiedBundleId})` : ''}.`,
    ];
    if (addedEmails.length > 0) {
      summaryParts.push(
        `Added ${addedEmails.length} tester${addedEmails.length === 1 ? '' : 's'}: ${addedEmails.join(', ')}.`,
      );
    }
    if (reusedEmails.length > 0) {
      summaryParts.push(
        `${reusedEmails.length} already in group: ${reusedEmails.join(', ')}.`,
      );
    }
    if (testerEmails.length === 0) {
      summaryParts.push(
        'No tester emails supplied — group is empty until you add testers in App Store Connect → TestFlight → Groups.',
      );
    }
    if (group.isInternalGroup) {
      summaryParts.push(
        'Internal groups skip Beta App Review — once a build is uploaded and processed, internal testers can install immediately.',
      );
    } else {
      summaryParts.push(
        'External groups need Beta App Review to clear on the first build of each version before testers can install — that one-time gate is handled in App Store Connect.',
      );
    }
    summaryParts.push(`Open the group directly: ${directGroupUrl}`);

    return {
      status: 'completed',
      resourcesProduced: {
        testflight_group_id: group.id,
        testflight_group_name: group.name,
      },
      userPrompt: summaryParts.join(' '),
    };
  }

  private async checkConfigureTestFlightGroup(
    context: StepContext,
    config: AppleManifestConfig,
  ): Promise<StepResult> {
    const groupId = context.upstreamResources['testflight_group_id']?.trim();
    if (groupId) {
      return {
        status: 'completed',
        resourcesProduced: {
          testflight_group_id: groupId,
          testflight_group_name:
            context.upstreamResources['testflight_group_name']?.trim() || '',
        },
      };
    }
    const ascAppId =
      context.upstreamResources['asc_app_id']?.trim() ||
      (await context.vaultRead(`${context.projectId}/asc_app_id`))?.trim();
    const auth = await this.readAscAuth(context);
    const requestedName =
      context.upstreamResources['testflight_group_name']?.trim() ||
      `${config.app_name} Testers`;
    if (auth && ascAppId) {
      const group = await this.findBetaGroupByName(auth, ascAppId, requestedName);
      if (group) {
        return {
          status: 'completed',
          resourcesProduced: {
            testflight_group_id: group.id,
            testflight_group_name: group.name,
          },
        };
      }
    }
    return {
      status: 'failed',
      resourcesProduced: {},
      error: `TestFlight group "${requestedName}" was not found in App Store Connect. Re-run "Create TestFlight Beta Group".`,
    };
  }

  async provision(config: AppleManifestConfig): Promise<ProviderState> {
    this.log.info('Starting Apple provisioning', {
      bundleId: config.bundle_id,
      teamId: config.team_id,
    });

    const now = Date.now();
    const state: ProviderState = {
      provider_id: `apple-${config.bundle_id}`,
      provider_type: 'apple',
      resource_ids: {},
      config_hashes: { config: this.hashConfig(config) },
      credential_metadata: {},
      partially_complete: false,
      failed_steps: [],
      completed_steps: [],
      created_at: now,
      updated_at: now,
    };

    try {
      // Step 1: Create bundle ID
      const existing = await this.apiClient.getBundleId(config.bundle_id);
      let bundleResourceId: string;

      if (existing) {
        bundleResourceId = existing.id;
      } else {
        bundleResourceId = await this.apiClient.createBundleId(
          config.bundle_id,
          config.app_name,
          config.team_id,
        );
      }
      state.resource_ids['bundle_resource_id'] = bundleResourceId;
      state.resource_ids['bundle_id'] = config.bundle_id;
      state.completed_steps.push('create_bundle_id');
      this.log.info('Bundle ID provisioned', { bundleId: config.bundle_id });

      // Step 2: Create certificate
      const csr = this.generateCsrPlaceholder();
      const cert = await this.apiClient.createCertificate(
        config.team_id,
        config.certificate_type,
        csr,
      );
      state.resource_ids['certificate_id'] = cert.id;
      state.credential_metadata['certificate_pem'] = {
        name: 'certificate_pem',
        stored_at: Date.now(),
      };
      state.completed_steps.push('create_certificate');
      this.log.info('Certificate created', { certId: cert.id });

      // Step 3: Create APNs key (if enabled)
      if (config.enable_apns) {
        const apnsKey = await this.apiClient.createApnsKey(config.team_id);
        state.resource_ids['apns_key_id'] = apnsKey.keyId;
        state.credential_metadata['apns_key'] = {
          name: 'apns_key',
          download_window_closed: false,
          stored_at: Date.now(),
        };
        state.completed_steps.push('create_apns_key');
        this.log.info('APNs key created', { keyId: apnsKey.keyId });
      }

      state.updated_at = Date.now();
      return state;
    } catch (err) {
      throw new AdapterError(
        `Apple provisioning failed: ${(err as Error).message}`,
        'apple',
        'provision',
        err,
      );
    }
  }

  /**
   * Shared executor for any step that registers an Apple Auth Key with a
   * specific capability. Both `apple:generate-apns-key` and
   * `apple:create-sign-in-key` reduce to this — the only difference is which
   * capability checkbox the user checks in Apple Developer Portal.
   *
   * Inputs (uniform across both steps):
   *   - `apple_auth_key_p8`  (p8, conditionally required) — PEM. NOT required
   *     when the user picked an existing key from the wizard's "Reuse" chips
   *     (which sets the Key ID against an already-vaulted entry).
   *   - `apple_auth_key_id` (string, side-channel) — 10-char Apple Key ID.
   *     Set by the frontend automatically: either extracted from the
   *     AuthKey_<KEYID>.p8 filename on upload, or set when the user clicks
   *     a chip in the "Reuse an existing key" picker. Persisted alongside
   *     the regular inputFields via the inputs PUT endpoint.
   *   - SIWA-only: `apple_sign_in_service_id` (text, required)
   *
   * Output (capability-tagged so multiple steps can write to upstreamResources
   * without colliding):
   *   - `apple_auth_key_id_<capability>` = the Key ID claimed for this cap
   *   - `apple_auth_key_p8_<capability>` = 'vaulted' marker
   *   - SIWA-only: `apple_sign_in_service_id`
   */
  private async executeAppleAuthKeyCapabilityStep(
    context: StepContext,
    config: AppleManifestConfig,
    args: { stepKey: string; capability: AppleKeyCapability },
  ): Promise<StepResult> {
    const { stepKey, capability } = args;
    const isSignIn = capability === 'sign_in_with_apple';
    const capabilityLabel = APPLE_KEY_CAPABILITY_LABEL[capability];

    const keyId = context.upstreamResources['apple_auth_key_id']?.trim();
    const formP8Raw = context.upstreamResources['apple_auth_key_p8']?.trim();
    const formP8 = formP8Raw && formP8Raw !== 'vaulted' ? formP8Raw : undefined;

    const serviceId = isSignIn
      ? context.upstreamResources['apple_sign_in_service_id']?.trim() ||
        (await context.vaultRead(appleSignInServiceIdVaultPath(context.projectId)))?.trim()
      : undefined;

    if (isSignIn && !serviceId) {
      return {
        status: 'waiting-on-user',
        resourcesProduced: {},
        userPrompt:
          `Missing Apple Services ID. Open https://developer.apple.com/account/resources/identifiers/list/bundleId (Team "${config.team_id}") and ensure your App ID has "Sign In with Apple" enabled, ` +
          'then open https://developer.apple.com/account/resources/identifiers/list/serviceId and create or update the Services ID with "Sign In with Apple" enabled and the Firebase auth handler in Return URLs, ' +
          'paste the identifier above, save, then re-run.',
      };
    }

    if (!keyId) {
      return {
        status: 'waiting-on-user',
        resourcesProduced: {},
        userPrompt:
          `Missing Apple Auth Key. Open https://developer.apple.com/account/resources/authkeys/list (Team "${config.team_id}"), ` +
          `${isSignIn ? 'create or edit a key with the "Sign in with Apple" capability checked (after App ID + Services ID are configured)' : 'create or edit a key with the "Apple Push Notifications service (APNs)" capability checked'}, ` +
          'then either drop the downloaded AuthKey_<KEYID>.p8 into the upload above (Studio derives the Key ID from the filename) or pick an existing key from the "Reuse an existing key" chips. Save, then re-run.',
      };
    }

    const keyIdError = validateAppleKeyId(keyId);
    if (keyIdError) {
      return { status: 'failed', resourcesProduced: {}, error: keyIdError };
    }
    if (isSignIn && serviceId) {
      const serviceIdError = validateAppleServiceId(serviceId);
      if (serviceIdError) {
        return { status: 'failed', resourcesProduced: {}, error: serviceIdError };
      }
    }

    const registry = await readAppleAuthKeyRegistry(context);
    const existingRecord = registry.keys[keyId];

    let p8ToWrite: string | undefined;
    if (formP8) {
      const p8Error = validateApplePemP8(formP8);
      if (p8Error) {
        return { status: 'failed', resourcesProduced: {}, error: p8Error };
      }
      p8ToWrite = formP8;
    } else if (!existingRecord) {
      // No upload, no prior record — we have no .p8 to vault. Block the user
      // until they upload it. Distinguish this from "we already have it" so
      // the prompt directs them at the upload, not at Apple's portal.
      return {
        status: 'waiting-on-user',
        resourcesProduced: {},
        userPrompt:
          `Key ID "${keyId}" is not registered in this project's Apple Auth Key store. Drop the AuthKey_${keyId}.p8 file into the upload above and save. ` +
          'If you already vaulted this key under a different step, pick it from the "Reuse an existing key" chips above instead.',
      };
    }

    const now = new Date().toISOString();
    mergeCapabilityIntoRegistry(registry, {
      keyId,
      p8: p8ToWrite ?? existingRecord!.p8,
      capability,
      addedByStep: stepKey,
      now,
    });
    await writeAppleAuthKeyRegistry(context, registry);
    if (isSignIn && serviceId) {
      await context.vaultWrite(
        appleSignInServiceIdVaultPath(context.projectId),
        serviceId,
      );
    }

    const finalRecord = registry.keys[keyId]!;
    const reusedExisting = !!existingRecord && !p8ToWrite;
    const verb = reusedExisting
      ? `Added "${capabilityLabel}" capability to existing Apple Auth Key`
      : existingRecord
      ? `Re-uploaded .p8 and added "${capabilityLabel}" capability to Apple Auth Key`
      : `Registered new Apple Auth Key (capability: "${capabilityLabel}")`;

    const resourcesProduced: Record<string, string> = {
      [`apple_auth_key_id_${capability}`]: keyId,
      [`apple_auth_key_p8_${capability}`]: 'vaulted',
    };
    if (isSignIn && serviceId) {
      resourcesProduced['apple_sign_in_service_id'] = serviceId;
    }

    const capabilityList = finalRecord.capabilities
      .map((c) => APPLE_KEY_CAPABILITY_LABEL[c])
      .join(' + ');

    return {
      status: 'completed',
      resourcesProduced,
      userPrompt:
        `${verb} "${keyId}" under Team "${config.team_id}". This key now bears: ${capabilityList}. ` +
        (isSignIn
          ? `Services ID "${serviceId}" is vaulted. Confirm your App ID Edit Configuration has "Sign In with Apple" enabled, then run the downstream "Configure Apple Sign-In in Firebase" step. `
          : 'The downstream "Upload APNs Key to Firebase" step will pick it up. ') +
        'Keep an offline backup of the .p8 \u2014 Apple cannot re-issue it.',
    };
  }

  private async checkAppleAuthKeyCapabilityStep(
    context: StepContext,
    args: { stepKey: string; capability: AppleKeyCapability },
  ): Promise<StepResult> {
    const { capability } = args;
    const isSignIn = capability === 'sign_in_with_apple';
    const registry = await readAppleAuthKeyRegistry(context);
    const found = findAuthKeyByCapability(registry, capability);
    if (!found) {
      return {
        status: 'failed',
        resourcesProduced: {},
        error: `No Apple Auth Key with "${APPLE_KEY_CAPABILITY_LABEL[capability]}" capability is registered for this project. Re-run ${args.stepKey}.`,
      };
    }
    const resourcesProduced: Record<string, string> = {
      [`apple_auth_key_id_${capability}`]: found.keyId,
      [`apple_auth_key_p8_${capability}`]: 'vaulted',
    };
    if (isSignIn) {
      const serviceId = (
        await context.vaultRead(appleSignInServiceIdVaultPath(context.projectId))
      )?.trim();
      if (!serviceId) {
        return {
          status: 'failed',
          resourcesProduced: {},
          error:
            'Sign In with Apple key is registered but the Services ID is missing. Re-run apple:create-sign-in-key.',
        };
      }
      resourcesProduced['apple_sign_in_service_id'] = serviceId;
    }
    return { status: 'completed', resourcesProduced };
  }

  async executeStep(
    stepKey: string,
    config: AppleManifestConfig,
    context: StepContext,
  ): Promise<StepResult> {
    this.log.info('AppleAdapter.executeStep()', { stepKey });
    switch (stepKey) {
      case 'apple:register-app-id': {
        const providedBundleId =
          context.upstreamResources['apple_bundle_id']?.trim() ||
          context.upstreamResources['bundle_id']?.trim() ||
          config.bundle_id;
        const auth = await this.readAscAuth(context);
        if (!auth) {
          throw new AdapterError(
            `Apple App ID registration requires App Store Connect API credentials (asc_issuer_id, asc_api_key_id, asc_api_key_p8) from the org-level Apple integration. Reconnect the integration in Studio and retry bundle "${providedBundleId}".`,
            'apple',
            'apple:register-app-id',
          );
        }
        this.log.info('Looking up Apple bundle ID', { bundleId: providedBundleId });
        const existing = await this.getBundleIdByIdentifier(auth, providedBundleId);
        let appleAppId: string;
        if (existing) {
          this.log.info('Apple bundle ID already registered', { bundleId: providedBundleId, ascId: existing.id });
          appleAppId = existing.id;
        } else {
          this.log.info('Registering new Apple bundle ID', { bundleId: providedBundleId });
          appleAppId = await this.createBundleIdInAsc(auth, providedBundleId, config.app_name);
          this.log.info('Apple bundle ID registered', { bundleId: providedBundleId, ascId: appleAppId });
        }
        return {
          status: 'completed',
          resourcesProduced: {
            apple_app_id: appleAppId,
            apple_bundle_id: providedBundleId,
          },
          userPrompt:
            `Apple App ID ${existing ? 'verified' : 'created'} automatically for bundle "${providedBundleId}" using the org App Store Connect Team Key. ` +
            'In Apple Developer, confirm required capabilities (Sign In with Apple, Push Notifications) are enabled on this identifier.',
        };
      }
      // apple:create-dev-provisioning-profile and
      // apple:create-dist-provisioning-profile have been removed.
      // iOS code-signing certs + profiles are now provisioned by EAS Build
      // (see apple:store-signing-in-eas) using the same org-level App Store
      // Connect Team Key.
      case 'apple:generate-apns-key':
        return this.executeAppleAuthKeyCapabilityStep(context, config, {
          stepKey: 'apple:generate-apns-key',
          capability: 'apns',
        });
      case 'apple:create-sign-in-key':
        return this.executeAppleAuthKeyCapabilityStep(context, config, {
          stepKey: 'apple:create-sign-in-key',
          capability: 'sign_in_with_apple',
        });
      case 'apple:upload-apns-to-firebase': {
        // Authoritative checklist + deep link + .p8 download for this step
        // live in the server-rendered MANUAL_INSTRUCTION_REGISTRY
        // (manual-step-instructions.ts) so they always reflect the latest
        // project ids without needing the step to be re-executed to refresh
        // a persisted userPrompt.
        //
        // Firebase exposes no API for inspecting which APNs Auth Keys are
        // configured on an iOS app, so there is no automated way to "verify"
        // the upload after the fact. Instead, completion is driven by the
        // user clicking "Run Step" *after* performing the manual upload —
        // the precondition we *can* check is that the .p8 they need to
        // upload is in fact vaulted in this project's Apple Auth Key
        // registry. If it isn't, fail loudly (don't silently mark complete)
        // so the user goes back and runs apple:generate-apns-key first.
        const registry = await readAppleAuthKeyRegistry(context);
        const apnsKey = findAuthKeyByCapability(registry, 'apns');
        if (!apnsKey) {
          throw new AdapterError(
            'No Apple Auth Key with the APNs capability is registered for this project. ' +
              'Run "Generate APNs Key" first so Studio has the .p8 vaulted, then re-run this step.',
            'apple',
            'upload-apns-to-firebase',
          );
        }
        return {
          status: 'completed',
          resourcesProduced: {
            apple_auth_key_id_apns: apnsKey.keyId,
            apple_apns_key_uploaded_to_firebase: 'manual',
          },
        };
      }
      case 'apple:create-app-store-listing':
      {
        // Apple's App Store Connect API explicitly forbids POST /v1/apps
        // ("The resource 'apps' does not allow 'CREATE'. Allowed operations
        // are: GET_COLLECTION, GET_INSTANCE, UPDATE"). New apps must be
        // created in the App Store Connect web UI by an Account Holder /
        // Admin. Studio's job here is to *detect* the listing once it
        // exists and link it to this project, not to create it.
        //
        // The user-supplied input field `asc_app_name` (defaulting to the
        // project name) captures whatever name they actually typed in App
        // Store Connect — App Store names must be globally unique, so the
        // listing name often differs from the project name. The orchestrator
        // merges userInputs into upstreamResources, so we read it from there.
        const requestedAscName =
          context.upstreamResources['asc_app_name']?.trim() || config.app_name;

        const ascAppId =
          context.upstreamResources['asc_app_id']?.trim() ||
          (await context.vaultRead(`${context.projectId}/asc_app_id`))?.trim();
        if (ascAppId) {
          return {
            status: 'completed',
            resourcesProduced: {
              asc_app_id: ascAppId,
              asc_app_name: requestedAscName,
            },
            userPrompt:
              `App Store Connect app record already linked as "${requestedAscName}" (id ${ascAppId}). ` +
              'Complete metadata, compliance, and TestFlight setup in App Store Connect.',
          };
        }

        const bundleId =
          context.upstreamResources['apple_bundle_id']?.trim() || config.bundle_id;
        const auth = await this.readAscAuth(context);
        if (!auth) {
          throw new AdapterError(
            `Detecting the App Store Connect listing requires the org-level Apple integration (asc_issuer_id, asc_api_key_id, asc_api_key_p8). Reconnect the Apple integration in Studio and rerun this step for bundle "${bundleId}".`,
            'apple',
            'apple:create-app-store-listing',
          );
        }

        // Sanity check that the bundle is actually registered in Apple
        // Developer before pointing the user at App Store Connect — if the
        // bundle ID isn't there, the ASC "New App" form won't list it.
        this.log.info('Verifying Apple Developer bundle ID before App Store listing detection', {
          bundleId,
        });
        const bundle = await this.getBundleIdByIdentifier(auth, bundleId);
        if (!bundle) {
          throw new AdapterError(
            `Bundle ID "${bundleId}" is not registered in Apple Developer. Run "Register App ID" first so Studio can detect the App Store Connect listing.`,
            'apple',
            'apple:create-app-store-listing',
          );
        }

        this.log.info('Looking up App Store Connect app by bundle identifier string', {
          bundleId,
          requestedAscName,
        });
        const existing = await this.getAppStoreAppByBundleIdentifier(auth, bundleId);
        if (existing) {
          // Source-of-truth: whatever Apple has on the listing record. If
          // the user typed a slightly different name (typo, suffix change),
          // surface the actual ASC name and persist that — that's what
          // shows in TestFlight, the App Store, and downstream tooling.
          const detectedName = existing.name?.trim() || requestedAscName;
          const nameMismatch =
            !!existing.name && existing.name.trim() !== requestedAscName.trim();
          this.log.info('Detected existing App Store Connect listing', {
            bundleId,
            ascAppId: existing.id,
            ascAppName: detectedName,
            requestedAscName,
            nameMismatch,
          });
          const mismatchSuffix = nameMismatch
            ? ` Note: the App Store Connect listing is named "${detectedName}", not "${requestedAscName}" — Studio recorded the actual name from Apple. Update the input above if you want this to match.`
            : '';
          return {
            status: 'completed',
            resourcesProduced: {
              asc_app_id: existing.id,
              asc_app_name: detectedName,
            },
            userPrompt:
              `Linked App Store Connect listing "${detectedName}" (id ${existing.id}) for bundle ${bundleId}.${mismatchSuffix} ` +
              'Complete metadata, compliance, and TestFlight setup in App Store Connect.',
          };
        }

        // App Store Connect API has no "create app" endpoint. Pause the
        // step so the user can create the listing in the web UI; on the
        // next run we'll detect it via filter[bundleId]. The detailed
        // step-by-step instructions are rendered by the UI from the
        // server-built manualInstructionsByNodeKey payload — no need to
        // duplicate them in the prompt.
        return {
          status: 'waiting-on-user',
          resourcesProduced: {},
          userPrompt:
            `App Store Connect listing for bundle ${bundleId} not found yet. Create it manually as "${requestedAscName}" ` +
            '(or any unique name — update the input field above if you have to use a different one), then re-run this step. ' +
            'Studio will detect it via filter[bundleId] and store asc_app_id and asc_app_name automatically.',
        };
      }
      case 'apple:configure-testflight-group':
        return await this.executeConfigureTestFlightGroup(context, config);
      case 'apple:store-signing-in-eas':
        return await this.executeStoreSigningInEas(context, config);
      case 'apple:revoke-signing-assets':
        return {
          status: 'completed',
          resourcesProduced: {
            apple_signing_assets_revoked: 'manual',
          },
          userPrompt:
            'Teardown checklist: revoke certificates/profiles/APNs keys in Apple Developer (https://developer.apple.com/account/resources) and revoke ASC API keys in App Store Connect (https://appstoreconnect.apple.com/access/integrations/api). This step records teardown intent.',
        };
      case 'apple:remove-app-store-listing':
        return {
          status: 'completed',
          resourcesProduced: {
            apple_app_store_listing_removed: 'manual',
          },
          userPrompt:
            'Teardown checklist: open https://appstoreconnect.apple.com/apps and remove/archive the app listing if allowed. Apple may block permanent deletion for apps that were previously published.',
        };
      default:
        throw new AdapterError(`Unknown Apple step: ${stepKey}`, 'apple', 'executeStep');
    }
  }

  // -------------------------------------------------------------------------
  // apple:store-signing-in-eas — full automation (App Store distribution only)
  // -------------------------------------------------------------------------

  // Reminder shown after the step succeeds.
  //
  // Why: EAS marks credentials uploaded via its GraphQL API (which Studio uses
  // here) as "not validated for non-interactive builds". The flag only flips
  // when an interactive `eas credentials` / `eas build` session re-checks the
  // cert against Apple. Until that happens, CI runs of
  // `eas build --non-interactive` fail with:
  //
  //   Distribution Certificate is not validated for non-interactive builds.
  //   Failed to set up credentials.
  //
  // Tracked upstream at https://github.com/expo/eas-cli/issues/3202 (open as of
  // April 2026). Until Expo ships a `validateCredentials` mutation, the only
  // workaround is a one-time interactive bootstrap from a developer machine.
  //
  //
  // Behaviour:
  //   1. Validate that all upstream prerequisites exist (eas_project_id,
  //      bundle id, ASC API credentials, Apple Team ID, Expo token).
  //   2. Ask EAS whether the app already has APP_STORE iosAppBuildCredentials
  //      with both a distribution cert and a provisioning profile attached.
  //      If so, return success with the existing IDs — Apple caps each team
  //      at 2 active iOS Distribution certs and we do not want to burn one
  //      on a no-op re-run.
  //   3. Otherwise, mint a fresh distribution cert + provisioning profile
  //      via Apple ASC API (using @expo/apple-utils, the same library
  //      eas-cli uses), then upload them to EAS via the Expo GraphQL
  //      mutations.
  //   4. Stash the certificate's developer-portal id, profile's id, P12
  //      password, and serial number in the per-project vault so the
  //      teardown step can revoke them in Apple Developer Portal.
  //
  // Dev profiles are intentionally out of scope — they require registered
  // device UDIDs which Studio does not collect.
  private async executeStoreSigningInEas(
    context: StepContext,
    config: AppleManifestConfig,
  ): Promise<StepResult> {
    const expoAppId = context.upstreamResources['eas_project_id']?.trim();
    const bundleIdentifier =
      context.upstreamResources['apple_bundle_id']?.trim() || config.bundle_id?.trim();
    const appleTeamId =
      context.upstreamResources['apple_team_id']?.trim() || config.team_id?.trim();
    const expoAccount =
      context.upstreamResources['expo_account']?.trim() || undefined;
    const ascAuth = await this.readAscAuth(context);
    const expoToken = (await context.vaultRead('expo_token'))?.trim() || undefined;
    const isRefresh = context.executionIntent === 'refresh';

    const missing: string[] = [];
    if (!expoAppId) missing.push('eas_project_id (run "Create EAS Project" first)');
    if (!bundleIdentifier) missing.push('bundle id (run "Register App ID" first)');
    if (!appleTeamId) missing.push('apple_team_id (configure the org-level Apple integration)');
    if (!ascAuth) {
      missing.push(
        'App Store Connect API credentials (asc_issuer_id, asc_api_key_id, asc_api_key_p8 from the org-level Apple integration)',
      );
    }
    if (!expoToken) missing.push('expo_token (connect EAS in the EAS integration)');
    if (missing.length > 0) {
      return {
        status: 'failed',
        resourcesProduced: {},
        error: `EAS-managed iOS signing prerequisites are missing: ${missing.join(', ')}.`,
      };
    }

    const expo = new ExpoGraphqlEasApiClient(expoToken!);

    const existing = await expo.checkExistingEasIosAppStoreSigning({
      expoAppId: expoAppId!,
      organization: expoAccount,
      bundleIdentifier: bundleIdentifier!,
    });
    if (existing && !isRefresh) {
      this.log.info('apple:store-signing-in-eas reusing existing EAS build credentials', {
        bundleIdentifier,
        iosAppCredentialsId: existing.iosAppCredentialsId,
      });
      return {
        status: 'completed',
        resourcesProduced: {
          apple_distribution_cert_id: existing.distributionCertificateId,
          apple_app_store_profile_id: existing.provisioningProfileId,
          eas_ios_build_credentials_id: existing.iosAppBuildCredentialsId,
          ...(existing.certSerialNumber
            ? { apple_distribution_cert_serial: existing.certSerialNumber }
            : {}),
        },
        userPrompt: easCredentialsBootstrapReminder(bundleIdentifier!),
      };
    }

    if (existing && isRefresh) {
      if (!ascAuth) {
        throw new AdapterError(
          'Cannot refresh EAS-managed iOS signing without App Store Connect credentials. ' +
            'Reconnect the org-level Apple integration and retry.',
          'apple',
          'executeStep',
        );
      }

      const vaultPath = `${context.projectId}/apple/eas-app-store-signing/${bundleIdentifier!}`;
      const vaultRecordRaw = await context.vaultRead(vaultPath);
      let certDeveloperPortalId = existing.certDeveloperPortalIdentifier ?? undefined;
      let profileDeveloperPortalId = existing.profileDeveloperPortalIdentifier ?? undefined;
      if (vaultRecordRaw) {
        try {
          const parsed = JSON.parse(vaultRecordRaw) as {
            certDeveloperPortalId?: string;
            profileDeveloperPortalId?: string;
          };
          certDeveloperPortalId = certDeveloperPortalId || parsed.certDeveloperPortalId?.trim() || undefined;
          profileDeveloperPortalId =
            profileDeveloperPortalId || parsed.profileDeveloperPortalId?.trim() || undefined;
        } catch (err) {
          throw new AdapterError(
            `Corrupt signing metadata in vault path "${vaultPath}": ${(err as Error).message}`,
            'apple',
            'executeStep',
            err,
          );
        }
      }

      this.log.info('apple:store-signing-in-eas refresh requested; revoking prior Apple assets', {
        bundleIdentifier,
        certDeveloperPortalId,
        profileDeveloperPortalId,
      });

      await revokeAppleAppStoreSigningAssets(ascAuth, {
        certDeveloperPortalId,
        profileDeveloperPortalId,
      });
    }

    const profileName = `Studio App Store ${bundleIdentifier!} ${new Date().toISOString().slice(0, 10)}`;
    let minted: AppleAppStoreSigningAssets;
    try {
      minted = await mintAppleAppStoreSigningAssets({
        ascAuth: ascAuth!,
        bundleIdentifier: bundleIdentifier!,
        profileName,
      });
    } catch (err) {
      throw new AdapterError(
        `Failed to mint Apple distribution cert + App Store profile via App Store Connect API: ${(err as Error).message}`,
        'apple',
        'executeStep',
        err,
      );
    }

    const provisioned = await expo.provisionEasIosAppStoreSigning({
      expoAppId: expoAppId!,
      organization: expoAccount,
      bundleIdentifier: bundleIdentifier!,
      appleTeamIdentifier: appleTeamId!,
      cert: {
        certP12Base64: minted.certP12Base64,
        certPassword: minted.certPassword,
        certPrivateSigningKey: minted.certPrivateSigningKey,
        developerPortalIdentifier: minted.certDeveloperPortalId,
      },
      profile: {
        profileContentBase64: minted.profileContentBase64,
        developerPortalIdentifier: minted.profileDeveloperPortalId,
      },
    });

    const vaultPath = `${context.projectId}/apple/eas-app-store-signing/${bundleIdentifier!}`;
    await context.vaultWrite(
      vaultPath,
      JSON.stringify({
        bundleIdentifier,
        appleTeamId,
        certDeveloperPortalId: minted.certDeveloperPortalId,
        certSerialNumber: minted.certSerialNumber,
        certExpirationDate: minted.certExpirationDate,
        certPassword: minted.certPassword,
        certP12Base64: minted.certP12Base64,
        profileDeveloperPortalId: minted.profileDeveloperPortalId,
        profileName: minted.profileName,
        profileExpirationDate: minted.profileExpirationDate,
        easIosAppCredentialsId: provisioned.iosAppCredentialsId,
        easIosAppBuildCredentialsId: provisioned.iosAppBuildCredentialsId,
        easAppleDistCertId: provisioned.appleDistributionCertificateId,
        easAppleProvisioningProfileId: provisioned.appleProvisioningProfileId,
        mintedAt: new Date().toISOString(),
      }),
    );

    this.log.info('apple:store-signing-in-eas minted + uploaded fresh App Store credentials', {
      bundleIdentifier,
      certSerialNumber: minted.certSerialNumber,
      iosAppBuildCredentialsId: provisioned.iosAppBuildCredentialsId,
    });

    return {
      status: 'completed',
      resourcesProduced: {
        apple_distribution_cert_id: provisioned.appleDistributionCertificateId,
        apple_distribution_cert_serial: minted.certSerialNumber,
        apple_app_store_profile_id: provisioned.appleProvisioningProfileId,
        eas_ios_build_credentials_id: provisioned.iosAppBuildCredentialsId,
      },
      userPrompt: easCredentialsBootstrapReminder(bundleIdentifier!),
    };
  }

  private async checkStoreSigningInEas(
    context: StepContext,
    config: AppleManifestConfig,
  ): Promise<StepResult> {
    const expoAppId = context.upstreamResources['eas_project_id']?.trim();
    const bundleIdentifier =
      context.upstreamResources['apple_bundle_id']?.trim() || config.bundle_id?.trim();
    const expoAccount =
      context.upstreamResources['expo_account']?.trim() || undefined;
    const expoToken = (await context.vaultRead('expo_token'))?.trim() || undefined;

    if (!expoAppId || !bundleIdentifier || !expoToken) {
      return {
        status: 'failed',
        resourcesProduced: {},
        error:
          'EAS-managed iOS signing prerequisites are incomplete. Expected eas_project_id, bundle id, and a stored expo_token.',
      };
    }

    const expo = new ExpoGraphqlEasApiClient(expoToken);
    const existing = await expo.checkExistingEasIosAppStoreSigning({
      expoAppId,
      organization: expoAccount,
      bundleIdentifier,
    });
    if (!existing) {
      return {
        status: 'failed',
        resourcesProduced: {},
        error: `EAS does not have App Store iosAppBuildCredentials for "${bundleIdentifier}". Re-run "Configure EAS-Managed iOS Signing".`,
      };
    }
    return {
      status: 'completed',
      resourcesProduced: {
        apple_distribution_cert_id: existing.distributionCertificateId,
        apple_app_store_profile_id: existing.provisioningProfileId,
        eas_ios_build_credentials_id: existing.iosAppBuildCredentialsId,
        ...(existing.certSerialNumber
          ? { apple_distribution_cert_serial: existing.certSerialNumber }
          : {}),
      },
    };
  }

  async checkStep(
    stepKey: string,
    config: AppleManifestConfig,
    context: StepContext,
  ): Promise<StepResult> {
    switch (stepKey) {
      case 'apple:register-app-id': {
        const appId = context.upstreamResources['apple_app_id']?.trim();
        const bundleId = context.upstreamResources['apple_bundle_id']?.trim() ?? config.bundle_id;
        if (appId) {
          return {
            status: 'completed',
            resourcesProduced: {
              apple_app_id: appId,
              apple_bundle_id: bundleId,
            },
          };
        }
        const auth = await this.readAscAuth(context);
        if (auth && bundleId) {
          const existing = await this.getBundleIdByIdentifier(auth, bundleId);
          if (existing) {
            return {
              status: 'completed',
              resourcesProduced: {
                apple_app_id: existing.id,
                apple_bundle_id: bundleId,
              },
            };
          }
        }
        if (!bundleId) {
          return {
            status: 'failed',
            resourcesProduced: {},
            error:
              'Bundle ID is not available on the project. Set the project bundle identifier and re-run "Register App ID" after confirming the org-level Apple integration is connected.',
          };
        }
        return {
          status: 'failed',
          resourcesProduced: { apple_bundle_id: bundleId },
          error:
            `Apple bundle "${bundleId}" exists in plan inputs but no App ID resource was found via the org-level App Store Connect Team Key. Reconnect the Apple integration and re-run "Register App ID".`,
        };
      }
      case 'apple:generate-apns-key':
        return this.checkAppleAuthKeyCapabilityStep(context, {
          stepKey: 'apple:generate-apns-key',
          capability: 'apns',
        });
      case 'apple:create-sign-in-key':
        return this.checkAppleAuthKeyCapabilityStep(context, {
          stepKey: 'apple:create-sign-in-key',
          capability: 'sign_in_with_apple',
        });
      // apple:create-dev-provisioning-profile and
      // apple:create-dist-provisioning-profile have been removed —
      // EAS Build manages iOS certs/profiles via apple:store-signing-in-eas.
      case 'apple:upload-apns-to-firebase': {
        const registry = await readAppleAuthKeyRegistry(context);
        const apnsKey = findAuthKeyByCapability(registry, 'apns');
        if (!apnsKey) {
          return {
            status: 'failed',
            resourcesProduced: {},
            error:
              'No Apple Auth Key with APNs capability is registered. Run apple:generate-apns-key first.',
          };
        }
        return { status: 'completed', resourcesProduced: {} };
      }
      case 'apple:create-app-store-listing': {
        const appStoreId = context.upstreamResources['asc_app_id']?.trim();
        const requestedAscName =
          context.upstreamResources['asc_app_name']?.trim() || config.app_name;
        if (appStoreId) {
          return {
            status: 'completed',
            resourcesProduced: {
              asc_app_id: appStoreId,
              asc_app_name:
                context.upstreamResources['asc_app_name']?.trim() || requestedAscName,
            },
          };
        }
        const auth = await this.readAscAuth(context);
        const bundleId = context.upstreamResources['apple_bundle_id']?.trim() ?? config.bundle_id;
        if (auth && bundleId) {
          const app = await this.getAppStoreAppByBundleIdentifier(auth, bundleId);
          if (app) {
            return {
              status: 'completed',
              resourcesProduced: {
                asc_app_id: app.id,
                asc_app_name: app.name?.trim() || requestedAscName,
              },
            };
          }
        }
        if (!bundleId) {
          return {
            status: 'failed',
            resourcesProduced: {},
            error:
              'App Store Connect app identifier (asc_app_id) is missing. Re-run listing creation or provide the ASC app id.',
          };
        }
        return {
          status: 'failed',
          resourcesProduced: {},
          error:
            'ASC app was not detected for this bundle. Re-run provisioning with ASC credentials or complete app creation manually.',
        };
      }
      case 'apple:configure-testflight-group':
        return await this.checkConfigureTestFlightGroup(context, config);
      case 'apple:store-signing-in-eas':
        return await this.checkStoreSigningInEas(context, config);
      case 'apple:revoke-signing-assets':
      case 'apple:remove-app-store-listing':
        return {
          status: 'failed',
          resourcesProduced: {},
          error:
            'Apple teardown state requires manual confirmation. Run teardown and complete manual cleanup in Apple portals.',
        };
      default:
        return {
          status: 'completed',
          resourcesProduced: {},
        };
    }
  }

  async validate(
    manifest: AppleManifestConfig,
    liveState: ProviderState | null,
  ): Promise<DriftReport> {
    const differences: DriftDifference[] = [];

    if (!liveState) {
      return {
        provider_id: `apple-${manifest.bundle_id}`,
        provider_type: 'apple',
        manifest_state: manifest,
        live_state: null,
        differences: [
          {
            field: 'bundle_id',
            manifest_value: manifest.bundle_id,
            live_value: null,
            conflict_type: 'missing_in_live',
          },
        ],
        orphaned_resources: [],
        requires_user_decision: false,
      };
    }

    // Check bundle ID
    const liveBundleId = await this.apiClient.getBundleId(manifest.bundle_id);
    if (!liveBundleId) {
      differences.push({
        field: 'bundle_id',
        manifest_value: manifest.bundle_id,
        live_value: null,
        conflict_type: 'missing_in_live',
      });
    }

    // Check certificates
    const liveCerts = await this.apiClient.getCertificates(manifest.team_id);
    const validCerts = liveCerts.filter(c => c.expiresAt > Date.now() / 1000);

    if (validCerts.length === 0) {
      differences.push({
        field: 'certificate',
        manifest_value: manifest.certificate_type,
        live_value: null,
        conflict_type: 'missing_in_live',
      });
    }

    // Check APNs key
    if (manifest.enable_apns) {
      const apnsMeta = liveState.credential_metadata['apns_key'];
      if (!apnsMeta) {
        differences.push({
          field: 'apns_key',
          manifest_value: 'required',
          live_value: null,
          conflict_type: 'missing_in_live',
        });
      } else if (apnsMeta.pending_manual_upload) {
        differences.push({
          field: 'apns_key',
          manifest_value: 'required',
          live_value: 'pending_manual_upload',
          conflict_type: 'value_mismatch',
        });
      }
    }

    return {
      provider_id: liveState.provider_id,
      provider_type: 'apple',
      manifest_state: manifest,
      live_state: liveState,
      differences,
      orphaned_resources: [],
      requires_user_decision: differences.some(
        d => d.live_value === 'pending_manual_upload',
      ),
    };
  }

  async reconcile(
    report: DriftReport,
    direction: ReconcileDirection,
  ): Promise<ProviderState> {
    const manifest = report.manifest_state as AppleManifestConfig;

    if (!report.live_state) {
      return this.provision(manifest);
    }

    if (direction === 'manifest→live') {
      for (const diff of report.differences) {
        if (diff.conflict_type === 'missing_in_live' && diff.field === 'bundle_id') {
          await this.apiClient.createBundleId(
            manifest.bundle_id,
            manifest.app_name,
            manifest.team_id,
          );
        }
      }
    }

    report.live_state.updated_at = Date.now();
    return report.live_state;
  }

  async extractCredentials(state: ProviderState): Promise<Record<string, string>> {
    const bundleId = state.resource_ids['bundle_id'] ?? '';
    const certId = state.resource_ids['certificate_id'] ?? '';
    const apnsKeyId = state.resource_ids['apns_key_id'] ?? '';

    return {
      bundle_id: bundleId,
      certificate_id: certId,
      apns_key_id: apnsKeyId,
    };
  }

  private generateCsrPlaceholder(): string {
    return '-----BEGIN CERTIFICATE REQUEST-----\nSTUB\n-----END CERTIFICATE REQUEST-----';
  }

  private hashConfig(config: AppleManifestConfig): string {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(config))
      .digest('hex')
      .slice(0, 16);
  }
}
