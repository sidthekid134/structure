import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'propagation-test-'));

jest.mock('os', () => ({
  ...jest.requireActual('os'),
  homedir: () => tmpDir,
}));

import { CredentialPropagator } from './propagation';
import { Vault } from './vault';

const PASSWORD = 'test-master-password';
const vaultFile = path.join(tmpDir, '.platform', 'credentials.enc');

function propagator(): CredentialPropagator {
  return new CredentialPropagator(PASSWORD);
}

afterEach(() => {
  if (fs.existsSync(vaultFile)) fs.unlinkSync(vaultFile);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('CredentialPropagator.propagate', () => {
  it('propagates to a single destination', () => {
    const result = propagator().propagate('sk-testkey12345678901', ['openai']);
    expect(result.allSucceeded).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ destination: 'openai', success: true });
  });

  it('propagates to multiple destinations', () => {
    const result = propagator().propagate('sk-testkey12345678901', [
      'openai',
      'anthropic',
      'vertex_ai',
    ]);
    expect(result.allSucceeded).toBe(true);
    expect(result.results).toHaveLength(3);
    const destinations = result.results.map((r) => r.destination);
    expect(destinations).toContain('openai');
    expect(destinations).toContain('anthropic');
    expect(destinations).toContain('vertex_ai');
  });

  it('stores the key in the vault for each destination', () => {
    const key = 'sk-sharedkey12345678901';
    propagator().propagate(key, ['openai', 'anthropic']);

    const vault = new Vault(PASSWORD);
    expect(vault.retrieve('openai', 'api_key')).toBe(key);
    expect(vault.retrieve('anthropic', 'api_key')).toBe(key);
  });

  it('returns empty results for empty destinations list', () => {
    const result = propagator().propagate('sk-testkey12345678901', []);
    expect(result.allSucceeded).toBe(true);
    expect(result.results).toHaveLength(0);
  });

  it('handles per-destination failures independently', () => {
    // Inject a vault that throws for 'anthropic' by mocking vault.store
    const prop = propagator();
    const vaultSpy = jest
      .spyOn((prop as any).vault, 'store')
      .mockImplementationOnce(() => {
        // openai succeeds
      })
      .mockImplementationOnce(() => {
        throw new Error('storage failure');
      });

    const result = prop.propagate('sk-testkey12345678901', ['openai', 'anthropic']);

    expect(result.allSucceeded).toBe(false);
    expect(result.results[0]).toMatchObject({ destination: 'openai', success: true });
    expect(result.results[1]).toMatchObject({
      destination: 'anthropic',
      success: false,
      error: 'storage failure',
    });

    vaultSpy.mockRestore();
  });

  it('does not include the API key value in error messages', () => {
    const prop = propagator();
    jest.spyOn((prop as any).vault, 'store').mockImplementation(() => {
      throw new Error('some vault error');
    });

    const result = prop.propagate('sk-supersecret12345678', ['openai']);
    const error = result.results[0].error ?? '';
    expect(error).not.toContain('sk-supersecret12345678');
  });
});
