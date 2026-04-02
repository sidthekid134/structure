import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { CredentialStore } from '../services/credential-store';
import {
  enableFirebaseIdentityToolkit,
} from '../handlers/firebase-auth-handler';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'firebase-auth-test-'));
}

function makeCredentialStore(dir: string): CredentialStore {
  return new CredentialStore(dir, 'test-passphrase-firebase');
}

// ---------------------------------------------------------------------------
// enableFirebaseIdentityToolkit
// ---------------------------------------------------------------------------

describe('enableFirebaseIdentityToolkit', () => {
  let tmpDir: string;
  let store: CredentialStore;

  beforeEach(() => {
    tmpDir = makeTempDir();
    store = makeCredentialStore(tmpDir);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('validates GCP project ID format — rejects empty string', async () => {
    await expect(
      enableFirebaseIdentityToolkit(
        'proj-1',
        '',
        'fake-token',
        store,
      ),
    ).rejects.toThrow(/Invalid GCP project ID/);
  });

  it('validates GCP project ID format — rejects IDs that are too short', async () => {
    await expect(
      enableFirebaseIdentityToolkit('proj-1', 'abc', 'fake-token', store),
    ).rejects.toThrow(/Invalid GCP project ID/);
  });

  it('validates GCP project ID format — rejects uppercase chars', async () => {
    await expect(
      enableFirebaseIdentityToolkit('proj-1', 'MyProject123', 'fake-token', store),
    ).rejects.toThrow(/Invalid GCP project ID/);
  });

  it('persists firebase auth config on success (mocked GCP call)', async () => {
    // Stub the underlying GCP API call
    const apiModule = await import('../core/gcp/gcp-api-client');
    const spy = jest
      .spyOn(apiModule, 'enableIdentityToolkit')
      .mockResolvedValue(undefined);

    const result = await enableFirebaseIdentityToolkit(
      'my-project',
      'my-valid-gcp-proj',
      'fake-access-token',
      store,
    );

    expect(result.success).toBe(true);
    expect(result.identity_toolkit_enabled).toBe(true);

    const config = store.getFirebaseAuthConfig('my-project');
    expect(config).not.toBeNull();
    expect(config?.identity_toolkit_enabled).toBe(true);

    spy.mockRestore();
  });

  it('calls progress callback with correct substep sequence', async () => {
    const apiModule = await import('../core/gcp/gcp-api-client');
    const spy = jest
      .spyOn(apiModule, 'enableIdentityToolkit')
      .mockResolvedValue(undefined);

    const calls: Array<{ substep: string; status: string }> = [];
    await enableFirebaseIdentityToolkit(
      'my-project',
      'my-valid-gcp-proj',
      'fake-token',
      store,
      (substep, status) => calls.push({ substep, status }),
    );

    expect(calls.length).toBeGreaterThan(0);
    const substepNames = calls.map((c) => c.substep);
    expect(substepNames).toContain('Validating GCP project...');
    expect(substepNames).toContain('Enabling Firebase Identity Toolkit...');
    expect(substepNames).toContain('Configuring permissions...');

    spy.mockRestore();
  });

  it('returns error progress on GCP API failure', async () => {
    const apiModule = await import('../core/gcp/gcp-api-client');
    const spy = jest
      .spyOn(apiModule, 'enableIdentityToolkit')
      .mockRejectedValue(new Error('GCP 403'));

    const calls: Array<{ substep: string; status: string }> = [];
    await expect(
      enableFirebaseIdentityToolkit(
        'my-project',
        'my-valid-gcp-proj',
        'fake-token',
        store,
        (substep, status) => calls.push({ substep, status }),
      ),
    ).rejects.toThrow('GCP 403');

    spy.mockRestore();
  });
});
