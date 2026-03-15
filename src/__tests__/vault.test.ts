import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { VaultManager } from '../vault';
import { VaultError, ValidationError } from '../types';

const PASSPHRASE = 'vault-test-passphrase-secure!';

function makeTempVaultPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-'));
  return path.join(dir, 'credentials.enc');
}

describe('VaultManager', () => {
  it('loads an empty vault when file does not exist', () => {
    const vaultPath = makeTempVaultPath();
    const vm = new VaultManager(vaultPath);
    const data = vm.loadVault(PASSPHRASE);
    expect(data.entries).toEqual({});
    expect(data.schemaVersion).toBe('1.0');
  });

  it('saves and reloads vault data correctly', () => {
    const vaultPath = makeTempVaultPath();
    const vm = new VaultManager(vaultPath);

    vm.setCredential(PASSPHRASE, 'github', 'token', 'ghp_test_token');

    const data = vm.loadVault(PASSPHRASE);
    expect(data.entries['github'].credentials['token']).toBe('ghp_test_token');
  });

  it('vault file exists and is not plaintext after save', () => {
    const vaultPath = makeTempVaultPath();
    const vm = new VaultManager(vaultPath);
    vm.setCredential(PASSPHRASE, 'eas', 'token', 'eas_secret');

    const raw = fs.readFileSync(vaultPath, 'utf8');
    expect(raw).not.toContain('eas_secret');
    expect(raw).not.toContain('eas');
  });

  it('vault file has restricted permissions (0o600)', () => {
    const vaultPath = makeTempVaultPath();
    const vm = new VaultManager(vaultPath);
    vm.setCredential(PASSPHRASE, 'firebase', 'apiKey', 'fb_key_value');

    const stat = fs.statSync(vaultPath);
    // Check owner read/write only (0o600)
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('updates an existing credential without losing others', () => {
    const vaultPath = makeTempVaultPath();
    const vm = new VaultManager(vaultPath);

    vm.setCredential(PASSPHRASE, 'github', 'token', 'token_v1');
    vm.setCredential(PASSPHRASE, 'github', 'owner', 'my-org');
    vm.setCredential(PASSPHRASE, 'github', 'token', 'token_v2');

    const data = vm.loadVault(PASSPHRASE);
    expect(data.entries['github'].credentials['token']).toBe('token_v2');
    expect(data.entries['github'].credentials['owner']).toBe('my-org');
  });

  it('getCredential returns undefined for missing key', () => {
    const vaultPath = makeTempVaultPath();
    const vm = new VaultManager(vaultPath);
    const val = vm.getCredential(PASSPHRASE, 'eas', 'nonexistent');
    expect(val).toBeUndefined();
  });

  it('getCredential returns the stored value', () => {
    const vaultPath = makeTempVaultPath();
    const vm = new VaultManager(vaultPath);
    vm.setCredential(PASSPHRASE, 'eas', 'token', 'my_eas_token');
    const val = vm.getCredential(PASSPHRASE, 'eas', 'token');
    expect(val).toBe('my_eas_token');
  });

  it('throws CryptoError when loading with wrong passphrase', () => {
    const vaultPath = makeTempVaultPath();
    const vm = new VaultManager(vaultPath);
    vm.setCredential(PASSPHRASE, 'eas', 'token', 'secret');

    expect(() => vm.loadVault('wrong-passphrase-123!')).toThrow();
  });

  it('throws ValidationError on invalid vault path', () => {
    expect(() => new VaultManager('./relative/path.enc')).toThrow(ValidationError);
  });

  it('throws ValidationError on weak passphrase', () => {
    const vaultPath = makeTempVaultPath();
    const vm = new VaultManager(vaultPath);
    expect(() => vm.loadVault('weak')).toThrow(ValidationError);
  });

  it('creates parent directory if it does not exist', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-mkdir-'));
    const nested = path.join(base, 'deep', 'nested', 'credentials.enc');
    const vm = new VaultManager(nested);
    vm.setCredential(PASSPHRASE, 'eas', 'token', 'tok');
    expect(fs.existsSync(nested)).toBe(true);
  });

  it('leaves no temp files after a successful save', () => {
    const vaultPath = makeTempVaultPath();
    const vm = new VaultManager(vaultPath);
    vm.setCredential(PASSPHRASE, 'eas', 'token', 'tok');

    const dir = path.dirname(vaultPath);
    const files = fs.readdirSync(dir);
    const tmpFiles = files.filter((f) => f.startsWith('.vault-tmp-'));
    expect(tmpFiles).toHaveLength(0);
  });

  afterEach(() => {
    // No persistent state — each test creates its own temp directory.
  });
});
