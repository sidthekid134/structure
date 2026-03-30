/**
 * Tests for credential REST endpoints.
 *
 * Covers:
 *   - POST /api/projects/:projectId/credentials/:credentialType (JSON body)
 *   - POST /api/projects/:projectId/credentials/:credentialType (multipart file)
 *   - File upload middleware (size limit, multipart parsing)
 *   - Live API validators (mocked)
 *   - checkDependencies cross-provider enforcement
 *   - validateAppleP8File / validateGooglePlayKeyFile
 *   - Response shape: no plaintext in success or error responses
 *   - Unknown credential type → 400
 *   - Validation failures → 422 with actionable message
 */

import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { CredentialService } from '../credentials/credentialService';
import {
  validateAppleP8File,
  validateGooglePlayKeyFile,
  validateGitHubPATLive,
  validateCloudflareTokenLive,
  validateExpoTokenLive,
  checkDependencies,
  fileUploadHandler,
} from '../credentials/credentialRouter';
import { CredentialError } from '../types';
import { StudioServer } from '../studio/server';

// ---------------------------------------------------------------------------
// Mock outbound HTTPS calls
// ---------------------------------------------------------------------------

jest.mock('https', () => {
  const actual = jest.requireActual<typeof import('https')>('https');
  return {
    ...actual,
    request: jest.fn(),
  };
});

import * as https from 'https';
const mockHttpsRequest = https.request as jest.Mock;

// Helper: build a fake IncomingMessage-like readable for mockHttpsRequest
function mockHttpsResponse(
  statusCode: number,
  body: string,
  headers: Record<string, string> = {},
): void {
  const { EventEmitter } = jest.requireActual<typeof import('events')>('events');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reqEmitter: any = new EventEmitter();
  reqEmitter.end = jest.fn();
  reqEmitter.setTimeout = jest.fn();
  reqEmitter.destroy = jest.fn();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resEmitter: any = new EventEmitter();
  resEmitter.statusCode = statusCode;
  resEmitter.headers = headers;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockHttpsRequest.mockImplementationOnce((_opts: unknown, callback: (res: any) => void) => {
    callback(resEmitter);
    setImmediate(() => {
      resEmitter.emit('data', Buffer.from(body));
      resEmitter.emit('end');
    });
    return reqEmitter;
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cred-router-test-'));
}

const MASTER_PASS = 'test-master-passphrase-32bytes!';

function makeService(dir: string): CredentialService {
  return new CredentialService(path.join(dir, 'creds.sqlite'), MASTER_PASS);
}

// Build a valid Apple .p8 PEM string
const VALID_P8 =
  '-----BEGIN PRIVATE KEY-----\n' +
  'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgABC123fake\n' +
  '-----END PRIVATE KEY-----\n';

// Build a valid Google Play JSON key
const VALID_GP_KEY = JSON.stringify({
  type: 'service_account',
  project_id: 'my-project',
  private_key_id: 'key123',
  private_key: '-----BEGIN RSA PRIVATE KEY-----\nFAKE\n-----END RSA PRIVATE KEY-----\n',
  client_email: 'svc@my-project.iam.gserviceaccount.com',
  client_id: '123456',
  auth_uri: 'https://accounts.google.com/o/oauth2/auth',
  token_uri: 'https://oauth2.googleapis.com/token',
});

// A valid Cloudflare token (40 base64url chars)
const VALID_CF_TOKEN = 'A'.repeat(40);

// A valid Expo token
const VALID_EXPO_TOKEN = 'expo_' + 'a'.repeat(35);

// A valid GitHub PAT (classic 40-char hex)
const VALID_GH_PAT = 'a'.repeat(40);

// ---------------------------------------------------------------------------
// HTTP helpers for integration tests
// ---------------------------------------------------------------------------

function postWithStatus(
  url: string,
  payload: unknown,
  contentType = 'application/json',
): Promise<{ statusCode: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const bodyStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          'Content-Length': Buffer.byteLength(bodyStr),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c.toString(); });
        res.on('end', () => {
          try { resolve({ statusCode: res.statusCode ?? 0, body: JSON.parse(data) }); }
          catch (e) { reject(e); }
        });
      },
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

/**
 * Sends a multipart/form-data POST with a single "file" field.
 */
function postMultipart(
  url: string,
  filename: string,
  fileContent: Buffer | string,
  mimeType = 'application/octet-stream',
): Promise<{ statusCode: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const boundary = '----TestBoundary' + crypto.randomBytes(8).toString('hex');
    const fileBuf = typeof fileContent === 'string' ? Buffer.from(fileContent, 'utf8') : fileContent;

    const head =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`;
    const tail = `\r\n--${boundary}--\r\n`;

    const bodyBuf = Buffer.concat([Buffer.from(head), fileBuf, Buffer.from(tail)]);

    const req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': bodyBuf.length,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c.toString(); });
        res.on('end', () => {
          try { resolve({ statusCode: res.statusCode ?? 0, body: JSON.parse(data) }); }
          catch (e) { reject(e); }
        });
      },
    );
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Unit tests — pure validators
// ---------------------------------------------------------------------------

describe('validateAppleP8File', () => {
  let dir: string;
  let svc: CredentialService;

  beforeEach(() => {
    dir = makeTempDir();
    svc = makeService(dir);
  });
  afterEach(() => { svc.close(); });

  it('accepts a valid BEGIN PRIVATE KEY PEM', () => {
    const result = validateAppleP8File(Buffer.from(VALID_P8), 'proj1', svc);
    expect(typeof result.value).toBe('string');
    expect(typeof result.fileHash).toBe('string');
    expect(result.fileHash).toHaveLength(64); // SHA-256 hex
  });

  it('accepts a valid BEGIN EC PRIVATE KEY PEM', () => {
    const pem =
      '-----BEGIN EC PRIVATE KEY-----\nFAKEKEYDATA\n-----END EC PRIVATE KEY-----\n';
    const result = validateAppleP8File(Buffer.from(pem), 'proj1', svc);
    expect(result.value).toContain('EC PRIVATE KEY');
  });

  it('throws CredentialError for non-PEM content', () => {
    expect(() =>
      validateAppleP8File(Buffer.from('not a key file'), 'proj1', svc),
    ).toThrow(CredentialError);
  });

  it('throws CredentialError if same hash already uploaded', () => {
    // Store the credential first
    svc.storeCredential('proj1', 'apple_p8', VALID_P8, {
      fileHash: crypto.createHash('sha256').update(VALID_P8).digest('hex'),
    });
    expect(() =>
      validateAppleP8File(Buffer.from(VALID_P8), 'proj1', svc),
    ).toThrow(/already been uploaded/);
  });

  it('does not throw when a different hash is uploaded (update)', () => {
    const otherP8 =
      '-----BEGIN PRIVATE KEY-----\nDIFFERENT_CONTENT\n-----END PRIVATE KEY-----\n';
    svc.storeCredential('proj1', 'apple_p8', VALID_P8, {
      fileHash: crypto.createHash('sha256').update(VALID_P8).digest('hex'),
    });
    // Different content → different hash → allowed
    expect(() =>
      validateAppleP8File(Buffer.from(otherP8), 'proj1', svc),
    ).not.toThrow();
  });
});

describe('validateGooglePlayKeyFile', () => {
  it('accepts a valid service account JSON', () => {
    const result = validateGooglePlayKeyFile(Buffer.from(VALID_GP_KEY));
    expect(typeof result.value).toBe('string');
    const parsed = JSON.parse(result.value) as Record<string, unknown>;
    expect(parsed['type']).toBe('service_account');
  });

  it('throws CredentialError for invalid JSON', () => {
    expect(() => validateGooglePlayKeyFile(Buffer.from('{not valid json'))).toThrow(CredentialError);
  });

  it('throws CredentialError when type is not service_account', () => {
    const bad = JSON.stringify({ ...JSON.parse(VALID_GP_KEY), type: 'user_account' });
    expect(() => validateGooglePlayKeyFile(Buffer.from(bad))).toThrow(/"service_account"/);
  });

  it('throws CredentialError listing missing fields', () => {
    const bad = JSON.stringify({ type: 'service_account', project_id: 'p' }); // missing several fields
    expect(() => validateGooglePlayKeyFile(Buffer.from(bad))).toThrow(/missing required fields/);
  });
});

// ---------------------------------------------------------------------------
// Unit tests — checkDependencies
// ---------------------------------------------------------------------------

describe('checkDependencies', () => {
  let dir: string;
  let svc: CredentialService;

  beforeEach(() => {
    dir = makeTempDir();
    svc = makeService(dir);
  });
  afterEach(() => { svc.close(); });

  it('passes when credential type has no dependencies', () => {
    expect(() => checkDependencies('proj1', 'github_pat', svc)).not.toThrow();
    expect(() => checkDependencies('proj1', 'expo_token', svc)).not.toThrow();
  });

  it('throws when cloudflare_token is missing before domain_name', () => {
    expect(() => checkDependencies('proj1', 'domain_name', svc)).toThrow(CredentialError);
    expect(() => checkDependencies('proj1', 'domain_name', svc)).toThrow(/cloudflare_token/);
  });

  it('passes domain_name after cloudflare_token is stored', () => {
    svc.storeCredential('proj1', 'cloudflare_token', VALID_CF_TOKEN);
    expect(() => checkDependencies('proj1', 'domain_name', svc)).not.toThrow();
  });

  it('throws when apple_team_id is missing before apple_p8', () => {
    expect(() => checkDependencies('proj1', 'apple_p8', svc)).toThrow(CredentialError);
    expect(() => checkDependencies('proj1', 'apple_p8', svc)).toThrow(/apple_team_id/);
  });

  it('passes apple_p8 after apple_team_id is stored', () => {
    svc.storeCredential('proj1', 'apple_team_id', 'ABCDEF1234');
    expect(() => checkDependencies('proj1', 'apple_p8', svc)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Unit tests — live validators (mocked https)
// ---------------------------------------------------------------------------

describe('validateGitHubPATLive', () => {
  it('resolves for valid token with required scopes', async () => {
    mockHttpsResponse(200, '{"login":"user"}', {
      'x-oauth-scopes': 'repo, workflow, admin:org',
    });
    await expect(validateGitHubPATLive('a'.repeat(40))).resolves.toBeUndefined();
  });

  it('throws CredentialError for 401', async () => {
    mockHttpsResponse(401, '{"message":"Bad credentials"}');
    await expect(validateGitHubPATLive('a'.repeat(40))).rejects.toMatchObject({
      name: 'CredentialError',
      message: expect.stringMatching(/invalid or expired/),
    });
  });

  it('throws CredentialError listing missing scopes', async () => {
    mockHttpsResponse(200, '{"login":"user"}', { 'x-oauth-scopes': 'repo' });
    await expect(validateGitHubPATLive('a'.repeat(40))).rejects.toThrow(/missing required scopes/);
  });
});

describe('validateCloudflareTokenLive', () => {
  it('resolves for valid token', async () => {
    mockHttpsResponse(200, JSON.stringify({ success: true, result: [] }));
    await expect(validateCloudflareTokenLive(VALID_CF_TOKEN)).resolves.toBeUndefined();
  });

  it('throws CredentialError for 403', async () => {
    mockHttpsResponse(403, JSON.stringify({ success: false }));
    await expect(validateCloudflareTokenLive(VALID_CF_TOKEN)).rejects.toThrow(CredentialError);
  });

  it('throws CredentialError when success=false', async () => {
    mockHttpsResponse(200, JSON.stringify({ success: false }));
    await expect(validateCloudflareTokenLive(VALID_CF_TOKEN)).rejects.toThrow(/Account:Read/);
  });
});

describe('validateExpoTokenLive', () => {
  it('resolves for valid token', async () => {
    mockHttpsResponse(200, JSON.stringify({ id: 'user123', username: 'tester' }));
    await expect(validateExpoTokenLive(VALID_EXPO_TOKEN)).resolves.toBeUndefined();
  });

  it('throws CredentialError for 401', async () => {
    mockHttpsResponse(401, '{"errors":[{"code":"UNAUTHORIZED"}]}');
    await expect(validateExpoTokenLive(VALID_EXPO_TOKEN)).rejects.toThrow(/invalid or expired/);
  });

  it('throws CredentialError when id is missing', async () => {
    mockHttpsResponse(200, JSON.stringify({ username: 'ghost' }));
    await expect(validateExpoTokenLive(VALID_EXPO_TOKEN)).rejects.toThrow(/valid account/);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — full HTTP round-trip via StudioServer
// ---------------------------------------------------------------------------

describe('POST /api/projects/:projectId/credentials/:credentialType', () => {
  let server: StudioServer;
  let port: number;
  let storeDir: string;

  beforeEach(async () => {
    storeDir = makeTempDir();
    port = 35000 + Math.floor(Math.random() * 5000);
    process.env['STUDIO_VAULT_PASSPHRASE'] = MASTER_PASS;
    server = new StudioServer({ port, host: '127.0.0.1', storeDir });
    await server.listen();
  });

  afterEach(async () => {
    await server.close();
    delete process.env['STUDIO_VAULT_PASSPHRASE'];
  });

  const base = () => `http://127.0.0.1:${port}/api`;

  // ---- Unknown credential type ----

  it('returns 400 for unknown credentialType', async () => {
    const { statusCode, body } = await postWithStatus(
      `${base()}/projects/proj1/credentials/unknown_type`,
      { value: 'something' },
    );
    expect(statusCode).toBe(400);
    expect((body as Record<string, string>).error).toMatch(/Unknown credential type/);
  });

  // ---- Missing value ----

  it('returns 400 when value is missing for text credential', async () => {
    const { statusCode, body } = await postWithStatus(
      `${base()}/projects/proj1/credentials/github_pat`,
      {},
    );
    expect(statusCode).toBe(400);
    expect((body as Record<string, string>).error).toMatch(/"value"/);
  });

  // ---- Format validation failure ----

  it('returns 422 for invalid GitHub PAT format', async () => {
    const { statusCode, body } = await postWithStatus(
      `${base()}/projects/proj1/credentials/github_pat`,
      { value: 'not-a-valid-pat' },
    );
    expect(statusCode).toBe(422);
    expect((body as Record<string, string>).error).toBeTruthy();
    // Plaintext must not appear in error
    expect(JSON.stringify(body)).not.toContain('not-a-valid-pat');
  });

  it('returns 422 for invalid Cloudflare token format', async () => {
    const { statusCode, body } = await postWithStatus(
      `${base()}/projects/proj1/credentials/cloudflare_token`,
      { value: 'short' },
    );
    expect(statusCode).toBe(422);
  });

  it('returns 422 for invalid Apple Team ID format', async () => {
    const { statusCode, body } = await postWithStatus(
      `${base()}/projects/proj1/credentials/apple_team_id`,
      { value: 'bad-id' },
    );
    expect(statusCode).toBe(422);
  });

  it('returns 422 for invalid domain name', async () => {
    const { statusCode } = await postWithStatus(
      `${base()}/projects/proj1/credentials/domain_name`,
      { value: 'not_a_domain' },
    );
    // dependency check fires first (no cloudflare_token), also 422
    expect(statusCode).toBe(422);
  });

  // ---- Dependency enforcement ----

  it('returns 422 when domain_name is stored without cloudflare_token', async () => {
    const { statusCode, body } = await postWithStatus(
      `${base()}/projects/proj1/credentials/domain_name`,
      { value: 'example.com' },
    );
    expect(statusCode).toBe(422);
    expect((body as Record<string, string>).error).toMatch(/cloudflare_token/);
  });

  // ---- File upload — missing file ----

  it('returns 400 when apple_p8 is submitted as JSON without file', async () => {
    const { statusCode, body } = await postWithStatus(
      `${base()}/projects/proj1/credentials/apple_p8`,
      { value: VALID_P8 },
    );
    expect(statusCode).toBe(400);
    expect((body as Record<string, string>).error).toMatch(/file upload/);
  });

  it('returns 400 when google_play_key is submitted as JSON without file', async () => {
    const { statusCode, body } = await postWithStatus(
      `${base()}/projects/proj1/credentials/google_play_key`,
      { value: VALID_GP_KEY },
    );
    expect(statusCode).toBe(400);
    expect((body as Record<string, string>).error).toMatch(/file upload/);
  });

  // ---- File upload — size limit ----

  it('returns 413 when file exceeds 10KB', async () => {
    const bigFile = Buffer.alloc(11 * 1024, 'X');
    const { statusCode } = await postMultipart(
      `${base()}/projects/proj1/credentials/apple_p8`,
      'key.p8',
      bigFile,
    );
    expect(statusCode).toBe(413);
  });

  // ---- Successful google_play_key upload ----

  it('stores google_play_key from multipart upload and returns receipt', async () => {
    const { statusCode, body } = await postMultipart(
      `${base()}/projects/proj1/credentials/google_play_key`,
      'service-account.json',
      Buffer.from(VALID_GP_KEY),
      'application/json',
    );
    expect(statusCode).toBe(201);
    const b = body as Record<string, unknown>;
    expect(typeof b['credentialId']).toBe('string');
    expect(b['type']).toBe('google_play_key');
    expect(typeof b['validatedAt']).toBe('string');
    // Plaintext must not appear in response
    expect(JSON.stringify(body)).not.toContain('service_account');
    expect(JSON.stringify(body)).not.toContain('FAKE');
  });

  // ---- Successful apple_p8 upload (with dependency satisfied) ----

  it('stores apple_p8 from multipart upload after team ID is present', async () => {
    // Store team ID first
    await postWithStatus(
      `${base()}/projects/proj1/credentials/apple_team_id`,
      { value: 'TEAM123456' },
    );

    const { statusCode, body } = await postMultipart(
      `${base()}/projects/proj1/credentials/apple_p8`,
      'AuthKey_ABC123.p8',
      Buffer.from(VALID_P8),
      'application/x-pkcs12',
    );
    expect(statusCode).toBe(201);
    const b = body as Record<string, unknown>;
    expect(b['type']).toBe('apple_p8');
    // Plaintext never in response
    expect(JSON.stringify(body)).not.toContain('PRIVATE KEY');
  });

  // ---- Successful text credentials (with live validation mocked) ----

  it('stores cloudflare_token after live validation succeeds', async () => {
    mockHttpsResponse(200, JSON.stringify({ success: true }));
    const { statusCode, body } = await postWithStatus(
      `${base()}/projects/proj1/credentials/cloudflare_token`,
      { value: VALID_CF_TOKEN },
    );
    expect(statusCode).toBe(201);
    const b = body as Record<string, unknown>;
    expect(b['credentialId']).toBeTruthy();
    expect(b['type']).toBe('cloudflare_token');
    expect(JSON.stringify(body)).not.toContain(VALID_CF_TOKEN);
  });

  it('stores expo_token after live validation succeeds', async () => {
    mockHttpsResponse(200, JSON.stringify({ id: 'uid', username: 'tester' }));
    const { statusCode, body } = await postWithStatus(
      `${base()}/projects/proj1/credentials/expo_token`,
      { value: VALID_EXPO_TOKEN },
    );
    expect(statusCode).toBe(201);
    expect((body as Record<string, unknown>)['type']).toBe('expo_token');
    expect(JSON.stringify(body)).not.toContain(VALID_EXPO_TOKEN);
  });

  it('stores github_pat after live validation succeeds', async () => {
    mockHttpsResponse(200, '{"login":"user"}', {
      'x-oauth-scopes': 'repo, workflow, admin:org',
    });
    const { statusCode, body } = await postWithStatus(
      `${base()}/projects/proj1/credentials/github_pat`,
      { value: VALID_GH_PAT },
    );
    expect(statusCode).toBe(201);
    expect((body as Record<string, unknown>)['type']).toBe('github_pat');
    expect(JSON.stringify(body)).not.toContain(VALID_GH_PAT);
  });

  it('returns 422 when GitHub live validation fails (bad token)', async () => {
    mockHttpsResponse(401, '{"message":"Bad credentials"}');
    const { statusCode, body } = await postWithStatus(
      `${base()}/projects/proj1/credentials/github_pat`,
      { value: VALID_GH_PAT },
    );
    expect(statusCode).toBe(422);
    expect((body as Record<string, string>).error).toMatch(/invalid or expired/);
    expect(JSON.stringify(body)).not.toContain(VALID_GH_PAT);
  });

  it('returns 422 when Cloudflare live validation fails', async () => {
    mockHttpsResponse(403, JSON.stringify({ success: false }));
    const { statusCode } = await postWithStatus(
      `${base()}/projects/proj1/credentials/cloudflare_token`,
      { value: VALID_CF_TOKEN },
    );
    expect(statusCode).toBe(422);
  });

  // ---- Idempotency: updating an existing credential ----

  it('updates an existing credential (upsert) and returns new credentialId', async () => {
    mockHttpsResponse(200, JSON.stringify({ success: true }));
    const first = await postWithStatus(
      `${base()}/projects/proj1/credentials/cloudflare_token`,
      { value: VALID_CF_TOKEN },
    );
    expect(first.statusCode).toBe(201);

    mockHttpsResponse(200, JSON.stringify({ success: true }));
    const second = await postWithStatus(
      `${base()}/projects/proj1/credentials/cloudflare_token`,
      { value: VALID_CF_TOKEN },
    );
    expect(second.statusCode).toBe(201);
    // Same credential ID on update (CredentialService returns existing ID)
    expect((first.body as Record<string, string>).credentialId).toBe(
      (second.body as Record<string, string>).credentialId,
    );
  });

  // ---- Cross-project isolation ----

  it('stores same credential type for different projects independently', async () => {
    mockHttpsResponse(200, JSON.stringify({ success: true }));
    const r1 = await postWithStatus(
      `${base()}/projects/proj-A/credentials/cloudflare_token`,
      { value: VALID_CF_TOKEN },
    );
    mockHttpsResponse(200, JSON.stringify({ success: true }));
    const r2 = await postWithStatus(
      `${base()}/projects/proj-B/credentials/cloudflare_token`,
      { value: VALID_CF_TOKEN },
    );
    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(201);
    expect((r1.body as Record<string, string>).credentialId).not.toBe(
      (r2.body as Record<string, string>).credentialId,
    );
  });

  // ---- domain_name with dependency satisfied ----

  it('stores domain_name after cloudflare_token is present', async () => {
    // Store cloudflare_token first
    mockHttpsResponse(200, JSON.stringify({ success: true }));
    await postWithStatus(
      `${base()}/projects/proj1/credentials/cloudflare_token`,
      { value: VALID_CF_TOKEN },
    );

    const { statusCode, body } = await postWithStatus(
      `${base()}/projects/proj1/credentials/domain_name`,
      { value: 'myapp.example.com' },
    );
    expect(statusCode).toBe(201);
    expect((body as Record<string, unknown>)['type']).toBe('domain_name');
  });
});
