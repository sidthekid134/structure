import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Redirect vault file to a temp dir so tests don't touch ~/.platform
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-'));
const vaultFile = path.join(tmpDir, '.platform', 'credentials.enc');

jest.mock('os', () => ({
  ...jest.requireActual('os'),
  homedir: () => tmpDir,
}));

import { NotFoundError, Vault } from './vault';

const PASSWORD = 'test-master-password';

afterEach(() => {
  if (fs.existsSync(vaultFile)) fs.unlinkSync(vaultFile);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Vault', () => {
  it('stores and retrieves a credential', () => {
    const vault = new Vault(PASSWORD);
    vault.store('aws', 'access_key', 'AKIA123');
    expect(vault.retrieve('aws', 'access_key')).toBe('AKIA123');
  });

  it('updates an existing credential', () => {
    const vault = new Vault(PASSWORD);
    vault.store('aws', 'secret', 'old');
    vault.store('aws', 'secret', 'new');
    expect(vault.retrieve('aws', 'secret')).toBe('new');
  });

  it('throws NotFoundError for missing credential', () => {
    const vault = new Vault(PASSWORD);
    expect(() => vault.retrieve('aws', 'nonexistent')).toThrow(NotFoundError);
    expect(() => vault.retrieve('aws', 'nonexistent')).toThrow(
      'Credential not found: provider="aws", key="nonexistent"'
    );
  });

  it('lists keys for a provider without exposing values', () => {
    const vault = new Vault(PASSWORD);
    vault.store('gcp', 'key_id', 'id-value');
    vault.store('gcp', 'key_secret', 'secret-value');
    vault.store('aws', 'access_key', 'ak');
    const keys = vault.list('gcp');
    expect(keys.sort()).toEqual(['key_id', 'key_secret']);
    expect(keys).not.toContain('secret-value');
  });

  it('returns empty list for provider with no credentials', () => {
    const vault = new Vault(PASSWORD);
    expect(vault.list('unknown')).toEqual([]);
  });

  it('vault file is unreadable plaintext', () => {
    const vault = new Vault(PASSWORD);
    vault.store('aws', 'secret', 'plaintext-secret');
    const raw = fs.readFileSync(vaultFile, 'utf8');
    expect(raw).not.toContain('plaintext-secret');
  });

  it('wrong password cannot decrypt vault', () => {
    const vault = new Vault(PASSWORD);
    vault.store('aws', 'key', 'value');
    const wrong = new Vault('wrong-password');
    expect(() => wrong.retrieve('aws', 'key')).toThrow();
  });

  it('persists across Vault instances', () => {
    new Vault(PASSWORD).store('stripe', 'api_key', 'sk_test_123');
    expect(new Vault(PASSWORD).retrieve('stripe', 'api_key')).toBe('sk_test_123');
  });
});
