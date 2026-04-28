import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { CredentialStore } from '../services/credential-store';
import { handleAppleKeyUpload, configureAppleSignIn } from '../handlers/apple-signin-handler';
import { validateAppleP8Key } from '../validators/apple-key-validator';
import { CredentialError } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apple-signin-test-'));
}

function makeStore(dir: string): CredentialStore {
  return new CredentialStore(dir, 'test-passphrase-apple');
}

/** Generate a real EC P-256 private key in PKCS#8 PEM format for testing */
function generateValidP8Buffer(): Buffer {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
  return Buffer.from(pem, 'utf8');
}

// ---------------------------------------------------------------------------
// validateAppleP8Key
// ---------------------------------------------------------------------------

describe('validateAppleP8Key', () => {
  it('accepts a valid EC P-256 PKCS#8 PEM key', () => {
    const buf = generateValidP8Buffer();
    const result = validateAppleP8Key(buf);
    expect(result.valid).toBe(true);
    expect(result.credential_hash).toHaveLength(64);
  });

  it('rejects a file without BEGIN PRIVATE KEY marker', () => {
    const buf = Buffer.from('not a valid pem file', 'utf8');
    expect(() => validateAppleP8Key(buf)).toThrow(CredentialError);
    expect(() => validateAppleP8Key(buf)).toThrow(/Invalid Apple .p8 key/);
  });

  it('rejects a file with truncated content (missing END marker)', () => {
    const buf = Buffer.from('-----BEGIN PRIVATE KEY-----\nABCD1234', 'utf8');
    expect(() => validateAppleP8Key(buf)).toThrow(/END PRIVATE KEY/);
  });

  it('rejects a file with multiple key blocks', () => {
    const pem1 = generateValidP8Buffer().toString('utf8');
    const pem2 = generateValidP8Buffer().toString('utf8');
    const combined = Buffer.from(`${pem1}\n${pem2}`, 'utf8');
    expect(() => validateAppleP8Key(combined)).toThrow(/exactly one key block/);
  });

  it('returns different hashes for different keys', () => {
    const buf1 = generateValidP8Buffer();
    const buf2 = generateValidP8Buffer();
    const r1 = validateAppleP8Key(buf1);
    const r2 = validateAppleP8Key(buf2);
    expect(r1.credential_hash).not.toBe(r2.credential_hash);
  });

  it('returns the same hash for the same key content', () => {
    const buf = generateValidP8Buffer();
    const r1 = validateAppleP8Key(buf);
    const r2 = validateAppleP8Key(buf);
    expect(r1.credential_hash).toBe(r2.credential_hash);
  });
});

// ---------------------------------------------------------------------------
// handleAppleKeyUpload
// ---------------------------------------------------------------------------

describe('handleAppleKeyUpload', () => {
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

  it('stores a valid APNs key and returns credential_id', async () => {
    const buf = generateValidP8Buffer();
    const result = await handleAppleKeyUpload(
      {
        project_id: 'my-project',
        p8_file_buffer: buf,
        key_id: 'ABCD123456',
        team_id: 'TEAM123456',
        key_purpose: 'apns',
      },
      store,
    );

    expect(result.credential_id).toBeTruthy();
    expect(result.key_id).toBe('ABCD123456');
    expect(result.team_id).toBe('TEAM123456');
    expect(result.credential_hash).toHaveLength(64);
  });

  it('rejects invalid PEM content', async () => {
    const buf = Buffer.from('invalid content', 'utf8');
    await expect(
      handleAppleKeyUpload(
        {
          project_id: 'my-project',
          p8_file_buffer: buf,
          key_id: 'ABCD123456',
          team_id: 'TEAM123456',
          key_purpose: 'apns',
        },
        store,
      ),
    ).rejects.toThrow(CredentialError);
  });

  it('rejects duplicate key uploads', async () => {
    const buf = generateValidP8Buffer();
    const input = {
      project_id: 'dup-project',
      p8_file_buffer: buf,
      key_id: 'ABCD123456',
      team_id: 'TEAM123456',
      key_purpose: 'apns' as const,
    };

    await handleAppleKeyUpload(input, store);

    await expect(handleAppleKeyUpload(input, store)).rejects.toThrow(/already been uploaded/);
  });

  it('allows same key for different purposes (apns vs sign_in)', async () => {
    const buf = generateValidP8Buffer();
    const baseInput = {
      project_id: 'multi-purpose-project',
      p8_file_buffer: buf,
      key_id: 'ABCD123456',
      team_id: 'TEAM123456',
    };

    const apns = await handleAppleKeyUpload({ ...baseInput, key_purpose: 'apns' }, store);
    const signIn = await handleAppleKeyUpload({ ...baseInput, key_purpose: 'sign_in' }, store);

    expect(apns.credential_id).not.toBe(signIn.credential_id);
  });

  it('retrieves and decrypts stored APNs key data', async () => {
    const buf = generateValidP8Buffer();
    const result = await handleAppleKeyUpload(
      {
        project_id: 'decrypt-project',
        p8_file_buffer: buf,
        key_id: 'XYZ9876543',
        team_id: 'MYTEAM1234',
        key_purpose: 'apns',
      },
      store,
    );

    const decrypted = store.decryptProviderCredential(result.credential_id);
    expect(decrypted).not.toBeNull();
    expect(decrypted?.['key_id']).toBe('XYZ9876543');
    expect(decrypted?.['team_id']).toBe('MYTEAM1234');
    expect(typeof decrypted?.['pem']).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// configureAppleSignIn
// ---------------------------------------------------------------------------

describe('configureAppleSignIn', () => {
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

  it('rejects invalid team ID format', async () => {
    await expect(
      configureAppleSignIn(
        {
          project_id: 'proj',
          gcp_project_id: 'gcp-proj',
          team_id: 'invalid',
          key_id: 'ABCD123456',
          service_id: 'com.example.service',
          access_token: 'fake-token',
        },
        store,
      ),
    ).rejects.toThrow(/Invalid Apple Team ID/);
  });

  it('rejects invalid key ID format', async () => {
    await expect(
      configureAppleSignIn(
        {
          project_id: 'proj',
          gcp_project_id: 'gcp-proj',
          team_id: 'ABCD123456',
          key_id: 'short',
          service_id: 'com.example.service',
          access_token: 'fake-token',
        },
        store,
      ),
    ).rejects.toThrow(/Invalid Apple Key ID/);
  });

  it('rejects missing service ID', async () => {
    await expect(
      configureAppleSignIn(
        {
          project_id: 'proj',
          gcp_project_id: 'gcp-proj',
          team_id: 'ABCD123456',
          key_id: 'ABCD123456',
          service_id: '',
          access_token: 'fake-token',
        },
        store,
      ),
    ).rejects.toThrow(/Service ID is required/);
  });

  it('configures Apple Sign-In and stores credential on success', async () => {
    const apiModule = await import('../core/gcp/gcp-api-client');
    const spy = jest
      .spyOn(apiModule, 'configureAppleSignInProvider')
      .mockResolvedValue(undefined);

    const result = await configureAppleSignIn(
      {
        project_id: 'apple-proj',
        gcp_project_id: 'gcp-apple-proj',
        team_id: 'ABCD123456',
        key_id: 'EFGH789012',
        service_id: 'com.example.app.signin',
        access_token: 'fake-token',
      },
      store,
    );

    expect(result.success).toBe(true);
    expect(result.message).toContain('gcp-apple-proj');

    const credential = store.getProviderCredentialByType('apple-proj', 'apple_sign_in');
    expect(credential).not.toBeNull();

    const data = store.decryptProviderCredential(credential!.id);
    expect(data?.['team_id']).toBe('ABCD123456');
    expect(data?.['key_id']).toBe('EFGH789012');
    expect(data?.['service_id']).toBe('com.example.app.signin');

    spy.mockRestore();
  });
});
