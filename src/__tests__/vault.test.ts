import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { VaultManager } from '../vault';
import { VaultError, ValidationError } from '../types';

const PASSPHRASE = 'vault-test-passphrase-secure!';

function makeTempVaultPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-'));
  return path.join(dir, 'credentials.enc');
}

/** 32-byte test key derived deterministically from path (same pattern as legacy tests). */
function testMasterKey(vaultPath: string): Buffer {
  return crypto.createHash('sha256').update(`${PASSPHRASE}:${vaultPath}`, 'utf8').digest();
}

describe('VaultManager', () => {
  it('loads an empty vault when file does not exist', () => {
    const vaultPath = makeTempVaultPath();
    const vm = new VaultManager(vaultPath);
    const data = vm.loadVault(testMasterKey(vaultPath));
    expect(data.entries).toEqual({});
    expect(data.schemaVersion).toBe('1.0');
  });

  it('saves and reloads vault data correctly', () => {
    const vaultPath = makeTempVaultPath();
    const vm = new VaultManager(vaultPath);
    const mk = testMasterKey(vaultPath);

    vm.setCredential(mk, 'github', 'token', 'ghp_test_token');

    const data = vm.loadVault(mk);
    expect(data.entries['github'].credentials['token']).toBe('ghp_test_token');
  });

  it('vault file exists and is not plaintext after save', () => {
    const vaultPath = makeTempVaultPath();
    const vm = new VaultManager(vaultPath);
    const mk = testMasterKey(vaultPath);
    vm.setCredential(mk, 'eas', 'token', 'eas_secret');

    const raw = fs.readFileSync(vaultPath, 'utf8');
    expect(raw).not.toContain('eas_secret');
    expect(raw).not.toContain('eas');
  });

  it('vault file has restricted permissions (0o600)', () => {
    const vaultPath = makeTempVaultPath();
    const vm = new VaultManager(vaultPath);
    const mk = testMasterKey(vaultPath);
    vm.setCredential(mk, 'firebase', 'apiKey', 'fb_key_value');

    const stat = fs.statSync(vaultPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('updates an existing credential without losing others', () => {
    const vaultPath = makeTempVaultPath();
    const vm = new VaultManager(vaultPath);
    const mk = testMasterKey(vaultPath);

    vm.setCredential(mk, 'github', 'token', 'token_v1');
    vm.setCredential(mk, 'github', 'owner', 'my-org');
    vm.setCredential(mk, 'github', 'token', 'token_v2');

    const data = vm.loadVault(mk);
    expect(data.entries['github'].credentials['token']).toBe('token_v2');
    expect(data.entries['github'].credentials['owner']).toBe('my-org');
  });

  it('getCredential returns undefined for missing key', () => {
    const vaultPath = makeTempVaultPath();
    const vm = new VaultManager(vaultPath);
    const mk = testMasterKey(vaultPath);
    const val = vm.getCredential(mk, 'eas', 'nonexistent');
    expect(val).toBeUndefined();
  });

  it('getCredential returns the stored value', () => {
    const vaultPath = makeTempVaultPath();
    const vm = new VaultManager(vaultPath);
    const mk = testMasterKey(vaultPath);
    vm.setCredential(mk, 'eas', 'token', 'my_eas_token');
    const val = vm.getCredential(mk, 'eas', 'token');
    expect(val).toBe('my_eas_token');
  });

  it('throws when loading with wrong master key', () => {
    const vaultPath = makeTempVaultPath();
    const vm = new VaultManager(vaultPath);
    const mk = testMasterKey(vaultPath);
    vm.setCredential(mk, 'eas', 'token', 'secret');

    const wrong = crypto.randomBytes(32);
    expect(() => vm.loadVault(wrong)).toThrow();
  });

  it('throws ValidationError on invalid vault path', () => {
    expect(() => new VaultManager('./relative/path.enc')).toThrow(ValidationError);
  });

  it('rejects non-32-byte master key', () => {
    const vaultPath = makeTempVaultPath();
    const vm = new VaultManager(vaultPath);
    expect(() => vm.loadVault(Buffer.alloc(16, 1))).toThrow(VaultError);
  });

  it('creates parent directory if it does not exist', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-mkdir-'));
    const nested = path.join(base, 'deep', 'nested', 'credentials.enc');
    const vm = new VaultManager(nested);
    const mk = testMasterKey(nested);
    vm.setCredential(mk, 'eas', 'token', 'tok');
    expect(fs.existsSync(nested)).toBe(true);
  });

  it('leaves no temp files after a successful save', () => {
    const vaultPath = makeTempVaultPath();
    const vm = new VaultManager(vaultPath);
    const mk = testMasterKey(vaultPath);
    vm.setCredential(mk, 'eas', 'token', 'tok');

    const dir = path.dirname(vaultPath);
    const files = fs.readdirSync(dir);
    const tmpFiles = files.filter((f) => f.startsWith('.vault-tmp-'));
    expect(tmpFiles).toHaveLength(0);
  });

  afterEach(() => {
    // No persistent state — each test creates its own temp directory.
  });
});
