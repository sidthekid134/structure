import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { CredentialStore } from '../services/credential-store';
import {
  validateRedirectUris,
  validateClientSecret,
  validateClientId,
  createOAuthClientHandler,
} from '../handlers/oauth-client-handler';
import { GcpHttpError } from '../core/gcp/gcp-api-client';
import { testDeriveKey } from './helpers/test-key.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-client-test-'));
}

function makeStore(dir: string): CredentialStore {
  return new CredentialStore(dir, (purpose: string) => testDeriveKey('test-passphrase-oauth', purpose));
}

// ---------------------------------------------------------------------------
// validateRedirectUris
// ---------------------------------------------------------------------------

describe('validateRedirectUris', () => {
  it('accepts HTTPS URIs', () => {
    expect(() =>
      validateRedirectUris(['https://example.com/callback']),
    ).not.toThrow();
  });

  it('accepts localhost http URIs', () => {
    expect(() =>
      validateRedirectUris(['http://localhost:3000/callback', 'http://127.0.0.1/cb']),
    ).not.toThrow();
  });

  it('rejects plain HTTP URIs', () => {
    expect(() =>
      validateRedirectUris(['http://example.com/callback']),
    ).toThrow(GcpHttpError);
  });

  it('rejects malformed URIs', () => {
    expect(() => validateRedirectUris(['not-a-url'])).toThrow(GcpHttpError);
  });

  it('reports multiple invalid URIs in error message', () => {
    try {
      validateRedirectUris(['http://evil.com', 'not-a-url']);
      fail('Expected to throw');
    } catch (err) {
      expect((err as Error).message).toContain('http://evil.com');
      expect((err as Error).message).toContain('not-a-url');
    }
  });
});

// ---------------------------------------------------------------------------
// validateClientSecret
// ---------------------------------------------------------------------------

describe('validateClientSecret', () => {
  it('accepts long enough secrets', () => {
    expect(() => validateClientSecret('a'.repeat(20))).not.toThrow();
    expect(() => validateClientSecret('a'.repeat(50))).not.toThrow();
  });

  it('rejects short secrets', () => {
    expect(() => validateClientSecret('short')).toThrow(GcpHttpError);
    expect(() => validateClientSecret('')).toThrow(GcpHttpError);
  });
});

// ---------------------------------------------------------------------------
// validateClientId
// ---------------------------------------------------------------------------

describe('validateClientId', () => {
  it('accepts valid Google client IDs', () => {
    expect(() =>
      validateClientId(
        '123456789-abcdef.apps.googleusercontent.com',
        'google',
      ),
    ).not.toThrow();
  });

  it('rejects Google client IDs without the expected suffix', () => {
    expect(() => validateClientId('my-client-id', 'google')).toThrow(GcpHttpError);
  });

  it('accepts any non-empty client ID for apple', () => {
    expect(() => validateClientId('com.example.service', 'apple')).not.toThrow();
  });

  it('rejects empty client ID', () => {
    expect(() => validateClientId('', 'apple')).toThrow(GcpHttpError);
  });
});

// ---------------------------------------------------------------------------
// createOAuthClientHandler
// ---------------------------------------------------------------------------

describe('createOAuthClientHandler', () => {
  let tmpDir: string;
  let store: CredentialStore;

  beforeEach(() => {
    tmpDir = makeTempDir();
    store = makeStore(tmpDir);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates and stores an OAuth client with masked secret', async () => {
    const apiModule = await import('../core/gcp/gcp-api-client');
    const spy = jest
      .spyOn(apiModule, 'configureFirebaseOAuthProvider')
      .mockResolvedValue(undefined);

    const firebaseConfig = store.upsertFirebaseAuthConfig({ project_id: 'test-proj' });

    const result = await createOAuthClientHandler(
      {
        firebase_config_id: firebaseConfig.id,
        provider: 'google',
        client_id: '123-abc.apps.googleusercontent.com',
        client_secret: 'a'.repeat(30),
        redirect_uris: ['https://example.com/callback'],
        gcp_project_id: 'test-gcp-proj',
        access_token: 'fake-token',
      },
      store,
    );

    expect(result.client_id).toBe('123-abc.apps.googleusercontent.com');
    expect(result.masked_client_secret).not.toContain('a'.repeat(10));
    expect(result.redirect_uris).toEqual(['https://example.com/callback']);
    expect(result.provider).toBe('google');

    spy.mockRestore();
  });

  it('rejects HTTP redirect URIs before calling GCP API', async () => {
    const apiModule = await import('../core/gcp/gcp-api-client');
    const spy = jest.spyOn(apiModule, 'configureFirebaseOAuthProvider').mockResolvedValue(undefined);

    const firebaseConfig = store.upsertFirebaseAuthConfig({ project_id: 'test-proj-2' });

    await expect(
      createOAuthClientHandler(
        {
          firebase_config_id: firebaseConfig.id,
          provider: 'google',
          client_id: '123-abc.apps.googleusercontent.com',
          client_secret: 'a'.repeat(30),
          redirect_uris: ['http://example.com/callback'],
          gcp_project_id: 'test-gcp',
          access_token: 'fake-token',
        },
        store,
      ),
    ).rejects.toThrow(/HTTPS or localhost/);

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('stores encrypted credentials so decrypting retrieves the original secret', async () => {
    const apiModule = await import('../core/gcp/gcp-api-client');
    const spy = jest
      .spyOn(apiModule, 'configureFirebaseOAuthProvider')
      .mockResolvedValue(undefined);

    const firebaseConfig = store.upsertFirebaseAuthConfig({ project_id: 'test-proj-3' });
    const secret = 'my-super-secret-value-12345';

    const record = await createOAuthClientHandler(
      {
        firebase_config_id: firebaseConfig.id,
        provider: 'apple',
        client_id: 'com.example.service',
        client_secret: secret,
        redirect_uris: ['https://example.com/callback'],
        gcp_project_id: 'test-gcp',
        access_token: 'fake-token',
      },
      store,
    );

    const decrypted = store.getDecryptedClientSecret(record.id);
    expect(decrypted).toBe(secret);

    spy.mockRestore();
  });
});
