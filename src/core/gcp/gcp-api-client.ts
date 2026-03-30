/**
 * Low-level GCP HTTP client.
 *
 * Exports a standalone `gcpRequest` function and `GcpHttpError`. All higher-level
 * GCP operations (CRM, IAM, Service Usage) call through here.
 */

import * as https from 'https';

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class GcpHttpError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = 'GcpHttpError';
  }
}

// ---------------------------------------------------------------------------
// Core request function
// ---------------------------------------------------------------------------

const GCP_REQUEST_TIMEOUT_MS = 30_000;

export function gcpRequest(
  method: string,
  hostname: string,
  path: string,
  accessToken?: string,
  body?: string,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'User-Agent': 'platform-studio' };
    if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body).toString();
    }

    let settled = false;
    const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

    const request = https.request({ method, hostname, path, headers }, (response) => {
      let data = '';
      response.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      response.on('end', () => {
        const statusCode = response.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          done(() => reject(new GcpHttpError(
            `GCP API ${method} ${hostname}${path} failed (${statusCode}): ${data.slice(0, 500)}`,
            statusCode,
            data,
          )));
          return;
        }
        done(() => resolve({ statusCode, body: data }));
      });
    });

    const timer = setTimeout(() => {
      done(() => {
        request.destroy();
        reject(new Error(`GCP API ${method} ${hostname}${path} timed out after ${GCP_REQUEST_TIMEOUT_MS / 1000}s`));
      });
    }, GCP_REQUEST_TIMEOUT_MS);
    request.on('response', () => clearTimeout(timer));
    request.on('error', (err) => done(() => { clearTimeout(timer); reject(new Error(`GCP API request failed: ${err.message}`)); }));
    if (body) request.write(body);
    request.end();
  });
}

// ---------------------------------------------------------------------------
// Error analysis helpers (consolidated — no duplication)
// ---------------------------------------------------------------------------

/**
 * Parses a 403 GcpHttpError to determine if a specific GCP API is disabled.
 * Returns the `services/{name}` identifier usable with Service Usage `:enable`,
 * or `null` if this is not an "API disabled" error.
 */
export function parseDisabledApiServiceName(err: unknown): string | null {
  if (!(err instanceof GcpHttpError) || err.statusCode !== 403) return null;
  const b = err.body;
  const isApiDisabled =
    b.includes('has not been used') || b.includes('It is disabled') || b.includes('it is disabled');
  if (!isApiDisabled) return null;

  // Extract service name from the standard GCP "API disabled" URL pattern:
  // https://console.developers.google.com/apis/api/{service}/overview?project=...
  const urlMatch = b.match(/\/apis\/api\/([a-z0-9._-]+\.googleapis\.com)\//);
  if (urlMatch?.[1]) return urlMatch[1];

  // Fallback: well-known service names mentioned inline
  if (b.includes('iam.googleapis.com')) return 'iam.googleapis.com';
  if (b.includes('cloudresourcemanager.googleapis.com')) return 'cloudresourcemanager.googleapis.com';
  return null;
}

/**
 * Returns a human-readable help message when a 403 error is caused by a disabled GCP API.
 * Returns `null` for non-disabled-API errors.
 */
export function formatDisabledApiHelp(gcpProjectId: string, err: unknown, hasUserOAuth = true): string | null {
  const service = parseDisabledApiServiceName(err);
  if (!service || !(err instanceof GcpHttpError)) return null;

  const reconnectHint = hasUserOAuth
    ? ''
    : ' Alternatively, run "Connect with Google" so Studio can enable APIs automatically.';
  const q = encodeURIComponent(gcpProjectId);

  if (service === 'iam.googleapis.com') {
    return (
      `Identity and Access Management (IAM) API is not enabled on GCP project "${gcpProjectId}". ` +
      `Enable it, wait a few minutes for propagation, then run sync again: ` +
      `https://console.cloud.google.com/apis/library/iam.googleapis.com?project=${q}` +
      reconnectHint
    );
  }
  if (service === 'cloudresourcemanager.googleapis.com') {
    return (
      `Cloud Resource Manager API is not enabled on GCP project "${gcpProjectId}". ` +
      `Enable it, wait a few minutes, then retry: ` +
      `https://console.cloud.google.com/apis/library/cloudresourcemanager.googleapis.com?project=${q}` +
      reconnectHint
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Token introspection
// ---------------------------------------------------------------------------

export interface TokenInfo {
  email?: string;
  scope?: string;
}

export async function fetchGoogleTokenInfo(accessToken: string): Promise<TokenInfo> {
  const res = await gcpRequest('GET', 'www.googleapis.com', `/oauth2/v1/tokeninfo?access_token=${accessToken}`);
  return JSON.parse(res.body) as TokenInfo;
}

// ---------------------------------------------------------------------------
// Project operations
// ---------------------------------------------------------------------------

export async function fetchGcpProjectSummary(
  accessToken: string,
  gcpProjectId: string,
): Promise<
  | { ok: true; projectId: string; name: string; lifecycleState?: string }
  | { ok: false; reason: 'not_found' | 'inaccessible' }
> {
  try {
    const res = await gcpRequest('GET', 'cloudresourcemanager.googleapis.com', `/v1/projects/${gcpProjectId}`, accessToken);
    const payload = JSON.parse(res.body) as { projectId?: string; name?: string; lifecycleState?: string };
    return {
      ok: true,
      projectId: payload.projectId ?? gcpProjectId,
      name: typeof payload.name === 'string' ? payload.name : '',
      lifecycleState: payload.lifecycleState,
    };
  } catch (err) {
    if (err instanceof GcpHttpError && err.statusCode === 404) return { ok: false, reason: 'not_found' };
    if (err instanceof GcpHttpError && err.statusCode === 403) return { ok: false, reason: 'inaccessible' };
    throw err;
  }
}

export async function getGcpProjectStatus(
  accessToken: string,
  projectId: string,
): Promise<'found' | 'not_found' | 'inaccessible'> {
  const s = await fetchGcpProjectSummary(accessToken, projectId);
  return s.ok ? 'found' : s.reason;
}

export async function listAccessibleGcpProjects(
  accessToken: string,
): Promise<Array<{ projectId: string; name: string }>> {
  const out: Array<{ projectId: string; name: string }> = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 50; page++) {
    const path = pageToken ? `/v1/projects?pageToken=${encodeURIComponent(pageToken)}` : '/v1/projects';
    const res = await gcpRequest('GET', 'cloudresourcemanager.googleapis.com', path, accessToken);
    const parsed = JSON.parse(res.body) as { projects?: Array<{ projectId?: string; name?: string }>; nextPageToken?: string };
    for (const p of parsed.projects ?? []) {
      if (p.projectId && typeof p.name === 'string') out.push({ projectId: p.projectId, name: p.name });
    }
    pageToken = parsed.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

export async function findGcpProjectsByDisplayName(
  accessToken: string,
  displayName: string,
): Promise<Array<{ projectId: string; name: string }>> {
  const all = await listAccessibleGcpProjects(accessToken);
  return all.filter((p) => p.name === displayName);
}

export async function deleteGcpProject(accessToken: string, projectId: string): Promise<void> {
  console.log(`[gcp-api] Deleting GCP project "${projectId}"…`);
  try {
    await gcpRequest('DELETE', 'cloudresourcemanager.googleapis.com', `/v1/projects/${projectId}`, accessToken);
    console.log(`[gcp-api] GCP project "${projectId}" marked for deletion.`);
  } catch (err) {
    if (err instanceof GcpHttpError && err.statusCode === 403) {
      throw new Error(`Permission denied deleting GCP project "${projectId}". The stored OAuth token may not be the project owner.`);
    }
    if (err instanceof GcpHttpError && err.statusCode === 404) {
      console.log(`[gcp-api] Project "${projectId}" not found — already deleted.`);
      return;
    }
    throw err;
  }
}

/**
 * Polls a GCP Long Running Operation until it completes or times out.
 * Returns the `response` payload on success, throws on LRO error.
 */
async function waitForOperation(accessToken: string, operationName: string): Promise<Record<string, unknown>> {
  // operationName is like "operations/pc.12345678901234567890"
  for (let attempt = 0; attempt < 40; attempt++) {
    const res = await gcpRequest('GET', 'cloudresourcemanager.googleapis.com', `/v1/${operationName.replace(/^\//, '')}`, accessToken);
    const op = JSON.parse(res.body) as {
      done?: boolean;
      error?: { code: number; message: string };
      response?: Record<string, unknown>;
    };
    if (op.done) {
      if (op.error) {
        const { code, message } = op.error;
        // code 8 = RESOURCE_EXHAUSTED (project quota exceeded)
        if (code === 8) {
          throw new Error(
            `GCP project quota exceeded: ${message} ` +
            'Delete unused GCP projects at console.cloud.google.com/cloud-resource-manager, ' +
            'or request a quota increase at console.cloud.google.com/iam-admin/quotas.',
          );
        }
        throw new Error(`GCP operation failed (${code}): ${message}`);
      }
      return op.response ?? {};
    }
    await sleep(1500);
  }
  throw new Error(`GCP operation "${operationName}" did not complete within 60 seconds.`);
}

export async function createGcpProject(
  accessToken: string,
  projectId: string,
  displayName: string,
): Promise<'created' | 'already_exists' | 'conflict'> {
  console.log(`[gcp-api] Creating GCP project "${projectId}" ("${displayName}")…`);
  try {
    const res = await gcpRequest('POST', 'cloudresourcemanager.googleapis.com', '/v1/projects', accessToken,
      JSON.stringify({ projectId, name: displayName }));

    // The CRM v1 create endpoint returns a Long Running Operation — wait for it.
    const body = JSON.parse(res.body) as { name?: string; done?: boolean; error?: { code: number; message: string } };
    if (body.name) {
      console.log(`[gcp-api] Project creation LRO started: ${body.name}`);
      if (!body.done) {
        await waitForOperation(accessToken, body.name);
      } else if (body.error) {
        throw new Error(`GCP project creation failed (${body.error.code}): ${body.error.message}`);
      }
    }

    console.log(`[gcp-api] GCP project "${projectId}" created — waiting for ACTIVE state.`);
    return 'created';
  } catch (err) {
    if (err instanceof GcpHttpError && err.statusCode === 409) {
      console.log(`[gcp-api] Project "${projectId}" already exists — checking status.`);
      const status = await getGcpProjectStatus(accessToken, projectId);
      return status === 'found' ? 'already_exists' : 'conflict';
    }
    if (err instanceof GcpHttpError && err.statusCode === 403) {
      throw new Error(
        `Permission denied while creating GCP project "${projectId}". ` +
          'Grant the signed-in Google user project creation permissions (Project Creator or equivalent), then retry.',
      );
    }
    console.error(`[gcp-api] createGcpProject failed:`, (err as Error).message);
    throw err;
  }
}

export async function waitForProjectActive(accessToken: string, projectId: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    console.log(`[gcp-api] waitForProjectActive "${projectId}" attempt ${attempt + 1}/20…`);
    try {
      const res = await gcpRequest('GET', 'cloudresourcemanager.googleapis.com', `/v1/projects/${projectId}`, accessToken);
      const payload = JSON.parse(res.body) as { lifecycleState?: string };
      if (payload.lifecycleState === 'ACTIVE') {
        console.log(`[gcp-api] Project "${projectId}" is ACTIVE.`);
        return;
      }
      console.log(`[gcp-api] Project "${projectId}" state: ${payload.lifecycleState ?? 'unknown'} — retrying.`);
    } catch (err) {
      if (err instanceof GcpHttpError && (err.statusCode === 403 || err.statusCode === 404)) {
        console.log(`[gcp-api] Project "${projectId}" not yet visible (${err.statusCode}) — retrying.`);
      } else {
        throw err;
      }
    }
    await sleep(1500);
  }
  throw new Error(`Timed out waiting for GCP project "${projectId}" to become ACTIVE.`);
}

// ---------------------------------------------------------------------------
// IAM operations
// ---------------------------------------------------------------------------

const PROVISIONER_PROJECT_ROLES = [
  'roles/firebase.admin',
  'roles/iam.serviceAccountAdmin',
  'roles/iam.serviceAccountKeyAdmin',
  'roles/serviceusage.serviceUsageAdmin',
  'roles/cloudkms.admin',
] as const;

export type ProvisionerRole = (typeof PROVISIONER_PROJECT_ROLES)[number];
export { PROVISIONER_PROJECT_ROLES };

export async function getIamPolicy(
  accessToken: string,
  gcpProjectId: string,
): Promise<{ bindings: Array<{ role: string; members: string[] }>; etag?: string }> {
  const res = await gcpRequest(
    'POST',
    'cloudresourcemanager.googleapis.com',
    `/v1/projects/${gcpProjectId}:getIamPolicy`,
    accessToken,
    JSON.stringify({}),
  );
  const policy = JSON.parse(res.body) as { bindings?: Array<{ role: string; members: string[] }>; etag?: string };
  return { bindings: policy.bindings ?? [], etag: policy.etag };
}

export async function setIamPolicy(
  accessToken: string,
  gcpProjectId: string,
  bindings: Array<{ role: string; members: string[] }>,
  etag?: string,
): Promise<void> {
  await gcpRequest(
    'POST',
    'cloudresourcemanager.googleapis.com',
    `/v1/projects/${gcpProjectId}:setIamPolicy`,
    accessToken,
    JSON.stringify({ policy: { bindings, etag } }),
  );
}

export async function findMissingProvisionerRoles(
  accessToken: string,
  gcpProjectId: string,
  member: string,
): Promise<string[]> {
  const { bindings } = await getIamPolicy(accessToken, gcpProjectId);
  return PROVISIONER_PROJECT_ROLES.filter((role) => {
    const existing = bindings.find((b) => b.role === role);
    return !existing || !existing.members.includes(member);
  });
}

export async function grantProvisionerRoles(accessToken: string, gcpProjectId: string, saEmail: string): Promise<void> {
  const member = `serviceAccount:${saEmail}`;
  let { bindings, etag } = await getIamPolicy(accessToken, gcpProjectId).catch((err) => {
    if (err instanceof GcpHttpError && err.statusCode === 403) {
      throw new Error(
        `Permission denied reading IAM policy for project "${gcpProjectId}". ` +
          'The signed-in user needs resourcemanager.projects.getIamPolicy.',
      );
    }
    throw err;
  });

  bindings = bindings.map((b) => ({ role: b.role, members: [...b.members] }));
  let changed = false;
  for (const role of PROVISIONER_PROJECT_ROLES) {
    const existing = bindings.find((b) => b.role === role);
    if (existing) {
      if (!existing.members.includes(member)) { existing.members.push(member); changed = true; }
    } else {
      bindings.push({ role, members: [member] }); changed = true;
    }
  }
  if (!changed) return;

  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await setIamPolicy(accessToken, gcpProjectId, bindings, etag);
      return;
    } catch (err) {
      if (err instanceof GcpHttpError && err.statusCode === 403) {
        throw new Error(
          `Permission denied setting IAM policy for project "${gcpProjectId}". ` +
            'The signed-in user needs resourcemanager.projects.setIamPolicy.',
        );
      }
      const isPropagation = err instanceof GcpHttpError && err.statusCode === 400 && err.message.includes('does not exist');
      if (isPropagation && attempt < MAX_ATTEMPTS) {
        const waitMs = attempt * 3000;
        console.log(`[gcp-api] SA not yet propagated for IAM binding (attempt ${attempt}/${MAX_ATTEMPTS}), waiting ${waitMs}ms…`);
        await sleep(waitMs);
        continue;
      }
      throw err;
    }
  }
}

export async function removeProvisionerRoles(accessToken: string, gcpProjectId: string, saEmail: string): Promise<void> {
  const member = `serviceAccount:${saEmail}`;
  const { bindings, etag } = await getIamPolicy(accessToken, gcpProjectId);
  const updated = bindings.map((b) => ({ role: b.role, members: [...b.members] }));
  let changed = false;
  for (const role of PROVISIONER_PROJECT_ROLES) {
    const binding = updated.find((b) => b.role === role);
    if (binding && binding.members.includes(member)) {
      binding.members = binding.members.filter((m) => m !== member);
      changed = true;
    }
  }
  if (!changed) return;
  const nonEmpty = updated.filter((b) => b.members.length > 0);
  await setIamPolicy(accessToken, gcpProjectId, nonEmpty, etag);
}

// ---------------------------------------------------------------------------
// Service Account operations
// ---------------------------------------------------------------------------

export const GCP_PROVISIONER_SA_ID = 'platform-provisioner';

export function provisionerSaEmail(gcpProjectId: string): string {
  return `${GCP_PROVISIONER_SA_ID}@${gcpProjectId}.iam.gserviceaccount.com`;
}

export async function ensureProvisionerServiceAccount(accessToken: string, gcpProjectId: string): Promise<string> {
  const saEmail = provisionerSaEmail(gcpProjectId);
  try {
    await gcpRequest('GET', 'iam.googleapis.com', `/v1/projects/${gcpProjectId}/serviceAccounts/${encodeURIComponent(saEmail)}`, accessToken);
    return saEmail;
  } catch (err) {
    if (!(err instanceof GcpHttpError) || err.statusCode !== 404) throw err;
  }

  try {
    const res = await gcpRequest(
      'POST', 'iam.googleapis.com', `/v1/projects/${gcpProjectId}/serviceAccounts`, accessToken,
      JSON.stringify({
        accountId: GCP_PROVISIONER_SA_ID,
        serviceAccount: { displayName: 'Platform Provisioner', description: 'Auto-created by Studio for project-scoped infrastructure provisioning.' },
      }),
    );
    const created = JSON.parse(res.body) as { email?: string };
    if (!created.email) throw new Error(`Failed to create provisioner service account: ${res.body}`);
    return created.email;
  } catch (err) {
    if (err instanceof GcpHttpError && err.statusCode === 409) return saEmail;
    throw err;
  }
}

export async function deleteServiceAccount(accessToken: string, gcpProjectId: string, saEmail: string): Promise<'deleted' | 'not_found'> {
  try {
    await gcpRequest('DELETE', 'iam.googleapis.com', `/v1/projects/${gcpProjectId}/serviceAccounts/${encodeURIComponent(saEmail)}`, accessToken);
    return 'deleted';
  } catch (err) {
    if (err instanceof GcpHttpError && err.statusCode === 404) return 'not_found';
    throw err;
  }
}

export async function deleteServiceAccountKey(
  accessToken: string,
  gcpProjectId: string,
  saEmail: string,
  keyId: string,
): Promise<'deleted' | 'not_found'> {
  try {
    await gcpRequest(
      'DELETE', 'iam.googleapis.com',
      `/v1/projects/${gcpProjectId}/serviceAccounts/${encodeURIComponent(saEmail)}/keys/${keyId}`,
      accessToken,
    );
    return 'deleted';
  } catch (err) {
    if (err instanceof GcpHttpError && err.statusCode === 404) return 'not_found';
    throw err;
  }
}

export async function createServiceAccountKey(accessToken: string, gcpProjectId: string, saEmail: string): Promise<string> {
  const res = await gcpRequest(
    'POST', 'iam.googleapis.com',
    `/v1/projects/${gcpProjectId}/serviceAccounts/${encodeURIComponent(saEmail)}/keys`,
    accessToken,
    JSON.stringify({ privateKeyType: 'TYPE_GOOGLE_CREDENTIALS_FILE' }),
  );
  const keyResponse = JSON.parse(res.body) as { privateKeyData?: string };
  if (!keyResponse.privateKeyData) throw new Error(`Failed to create service account key: ${res.body}`);
  return Buffer.from(keyResponse.privateKeyData, 'base64').toString('utf8');
}

// ---------------------------------------------------------------------------
// Service Usage (API enablement)
// ---------------------------------------------------------------------------

export async function isServiceEnabled(accessToken: string, gcpProjectId: string, service: string): Promise<boolean> {
  try {
    const res = await gcpRequest(
      'GET', 'serviceusage.googleapis.com',
      `/v1/projects/${encodeURIComponent(gcpProjectId)}/services/${encodeURIComponent(service)}`,
      accessToken,
    );
    const body = JSON.parse(res.body) as { state?: string };
    return body.state === 'ENABLED';
  } catch (err) {
    if (err instanceof GcpHttpError && err.statusCode === 404) return false;
    throw err;
  }
}

export async function enableProjectService(gcpProjectId: string, accessToken: string, serviceName: string): Promise<boolean> {
  try {
    await gcpRequest(
      'POST', 'serviceusage.googleapis.com',
      `/v1/projects/${encodeURIComponent(gcpProjectId)}/services/${encodeURIComponent(serviceName)}:enable`,
      accessToken, '{}',
    );
    console.log(`[gcp-api] Service Usage enable requested for ${serviceName} on ${gcpProjectId}.`);
    return true;
  } catch (err) {
    if (err instanceof GcpHttpError) {
      const b = err.body;
      if (err.statusCode === 409 || b.includes('already been enabled') || b.includes('already enabled') || b.includes('ALREADY_EXISTS') || b.includes('already exists')) {
        return true;
      }
      console.log(`[gcp-api] Failed to enable ${serviceName} on ${gcpProjectId} (${err.statusCode}): ${b.slice(0, 300)}`);
    } else {
      console.log(`[gcp-api] Failed to enable ${serviceName} on ${gcpProjectId}: ${(err as Error).message}`);
    }
    return false;
  }
}

export async function ensureRequiredProjectApis(accessToken: string, gcpProjectId: string): Promise<void> {
  const apis = [
    'serviceusage.googleapis.com',
    'iam.googleapis.com',
    'cloudresourcemanager.googleapis.com',
    'firebase.googleapis.com',
  ];
  console.log(`[gcp-api] Enabling required APIs on "${gcpProjectId}"…`);
  let anyEnabled = false;
  for (const api of apis) {
    const ok = await enableProjectService(gcpProjectId, accessToken, api);
    if (ok) anyEnabled = true;
  }
  if (anyEnabled) {
    console.log(`[gcp-api] Waiting for API propagation on ${gcpProjectId}…`);
    await sleep(4000);
  }
  console.log(`[gcp-api] Required APIs ready on "${gcpProjectId}".`);
}

// ---------------------------------------------------------------------------
// Firebase Management API — app registration
// ---------------------------------------------------------------------------

export interface FirebaseIosApp {
  appId: string;
  bundleId: string;
  displayName: string;
}

export interface FirebaseAndroidApp {
  appId: string;
  packageName: string;
  displayName: string;
}

/** Poll a Firebase long-running operation until it is done (up to ~60s). */
async function pollFirebaseOperation(accessToken: string, operationName: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    const res = await gcpRequest('GET', 'firebase.googleapis.com', `/v1/${operationName}`, accessToken);
    const op = JSON.parse(res.body) as { done?: boolean; response?: Record<string, unknown>; error?: { message: string } };
    if (op.error) throw new Error(`Firebase operation error: ${op.error.message}`);
    if (op.done && op.response) return op.response;
  }
  throw new Error('Firebase operation did not complete within 60s.');
}

export async function listFirebaseIosApps(accessToken: string, gcpProjectId: string): Promise<FirebaseIosApp[]> {
  const res = await gcpRequest('GET', 'firebase.googleapis.com', `/v1beta1/projects/${gcpProjectId}/iosApps`, accessToken);
  const body = JSON.parse(res.body) as { apps?: Array<{ appId: string; bundleId: string; displayName?: string }> };
  return (body.apps ?? []).map((a) => ({ appId: a.appId, bundleId: a.bundleId, displayName: a.displayName ?? '' }));
}

/** Register a new iOS app on the Firebase project. Returns the new appId. */
export async function registerFirebaseIosApp(
  accessToken: string,
  gcpProjectId: string,
  bundleId: string,
  displayName: string,
): Promise<string> {
  const res = await gcpRequest(
    'POST', 'firebase.googleapis.com',
    `/v1beta1/projects/${gcpProjectId}/iosApps`,
    accessToken,
    JSON.stringify({ bundleId, displayName }),
  );
  const op = JSON.parse(res.body) as { name: string };
  if (!op.name) throw new Error(`iOS app registration did not return an operation name: ${res.body}`);
  const response = await pollFirebaseOperation(accessToken, op.name) as { appId?: string };
  if (!response.appId) throw new Error('iOS app registration completed but no appId was returned.');
  return response.appId;
}

export async function listFirebaseAndroidApps(accessToken: string, gcpProjectId: string): Promise<FirebaseAndroidApp[]> {
  const res = await gcpRequest('GET', 'firebase.googleapis.com', `/v1beta1/projects/${gcpProjectId}/androidApps`, accessToken);
  const body = JSON.parse(res.body) as { apps?: Array<{ appId: string; packageName: string; displayName?: string }> };
  return (body.apps ?? []).map((a) => ({ appId: a.appId, packageName: a.packageName, displayName: a.displayName ?? '' }));
}

/** Register a new Android app on the Firebase project. Returns the new appId. */
export async function registerFirebaseAndroidApp(
  accessToken: string,
  gcpProjectId: string,
  packageName: string,
  displayName: string,
): Promise<string> {
  const res = await gcpRequest(
    'POST', 'firebase.googleapis.com',
    `/v1beta1/projects/${gcpProjectId}/androidApps`,
    accessToken,
    JSON.stringify({ packageName, displayName }),
  );
  const op = JSON.parse(res.body) as { name: string };
  if (!op.name) throw new Error(`Android app registration did not return an operation name: ${res.body}`);
  const response = await pollFirebaseOperation(accessToken, op.name) as { appId?: string };
  if (!response.appId) throw new Error('Android app registration completed but no appId was returned.');
  return response.appId;
}

// ---------------------------------------------------------------------------
// Firebase Rules API — Firestore and Storage security rules
// ---------------------------------------------------------------------------

/** Deploy Firestore security rules to the given GCP project. */
export async function deployFirestoreRules(accessToken: string, gcpProjectId: string, rulesContent: string): Promise<void> {
  const createRes = await gcpRequest(
    'POST', 'firebaserules.googleapis.com',
    `/v1/projects/${gcpProjectId}/rulesets`,
    accessToken,
    JSON.stringify({ source: { files: [{ name: 'firestore.rules', content: rulesContent }] } }),
  );
  const ruleset = JSON.parse(createRes.body) as { name?: string };
  if (!ruleset.name) throw new Error(`Firestore ruleset creation returned no name: ${createRes.body}`);

  await gcpRequest(
    'PUT', 'firebaserules.googleapis.com',
    `/v1/projects/${gcpProjectId}/releases/cloud.firestore`,
    accessToken,
    JSON.stringify({ release: { name: `projects/${gcpProjectId}/releases/cloud.firestore`, rulesetName: ruleset.name } }),
  );
}

/** Deploy Cloud Storage security rules to the project's default bucket. */
export async function deployStorageRules(accessToken: string, gcpProjectId: string, rulesContent: string): Promise<void> {
  const bucket = `${gcpProjectId}.appspot.com`;
  const createRes = await gcpRequest(
    'POST', 'firebaserules.googleapis.com',
    `/v1/projects/${gcpProjectId}/rulesets`,
    accessToken,
    JSON.stringify({ source: { files: [{ name: 'storage.rules', content: rulesContent }] } }),
  );
  const ruleset = JSON.parse(createRes.body) as { name?: string };
  if (!ruleset.name) throw new Error(`Storage ruleset creation returned no name: ${createRes.body}`);

  const releaseName = `firebase.storage/${bucket}`;
  await gcpRequest(
    'PUT', 'firebaserules.googleapis.com',
    `/v1/projects/${gcpProjectId}/releases/${encodeURIComponent(releaseName)}`,
    accessToken,
    JSON.stringify({ release: { name: `projects/${gcpProjectId}/releases/${releaseName}`, rulesetName: ruleset.name } }),
  );
}

/** Returns the active ruleset name for the cloud.firestore release, or null if none is set. */
export async function getActiveFirestoreRulesetName(accessToken: string, gcpProjectId: string): Promise<string | null> {
  try {
    const res = await gcpRequest('GET', 'firebaserules.googleapis.com', `/v1/projects/${gcpProjectId}/releases/cloud.firestore`, accessToken);
    const release = JSON.parse(res.body) as { rulesetName?: string };
    return release.rulesetName?.trim() || null;
  } catch (err) {
    if (err instanceof GcpHttpError && (err.statusCode === 404 || err.statusCode === 400)) return null;
    throw err;
  }
}

/** Returns the active ruleset name for the firebase.storage release, or null if none is set. */
export async function getActiveStorageRulesetName(accessToken: string, gcpProjectId: string): Promise<string | null> {
  const bucket = `${gcpProjectId}.appspot.com`;
  const releaseName = `firebase.storage/${bucket}`;
  try {
    const res = await gcpRequest('GET', 'firebaserules.googleapis.com', `/v1/projects/${gcpProjectId}/releases/${encodeURIComponent(releaseName)}`, accessToken);
    const release = JSON.parse(res.body) as { rulesetName?: string };
    return release.rulesetName?.trim() || null;
  } catch (err) {
    if (err instanceof GcpHttpError && (err.statusCode === 404 || err.statusCode === 400)) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
