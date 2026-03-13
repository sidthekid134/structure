import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Redirect ~/.provisioning to a temp dir so tests don't touch the real home dir.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-store-test-'));

jest.mock('os', () => ({
  ...jest.requireActual('os'),
  homedir: () => tmpDir,
}));

import { CredentialStore } from './credential-store';

const MASTER = 'correct-horse-battery-staple';

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('CredentialStore.encrypt / decrypt', () => {
  it('round-trips plaintext', async () => {
    const plaintext = JSON.stringify({ token: 'abc123', expiry: 9999 });
    const ciphertext = await CredentialStore.encrypt(plaintext, MASTER);
    const result = await CredentialStore.decrypt(ciphertext, MASTER);
    expect(result).toBe(plaintext);
  });

  it('returns a base64 string', async () => {
    const ciphertext = await CredentialStore.encrypt('secret', MASTER);
    expect(typeof ciphertext).toBe('string');
    expect(() => Buffer.from(ciphertext, 'base64')).not.toThrow();
  });

  it('does not leak plaintext in ciphertext', async () => {
    const plaintext = 'super-secret-value';
    const ciphertext = await CredentialStore.encrypt(plaintext, MASTER);
    expect(ciphertext).not.toContain(plaintext);
  });

  it('produces different ciphertext on each call (random salt/iv)', async () => {
    const a = await CredentialStore.encrypt('same', MASTER);
    const b = await CredentialStore.encrypt('same', MASTER);
    expect(a).not.toBe(b);
  });

  it('throws with the wrong master password', async () => {
    const ciphertext = await CredentialStore.encrypt('secret', MASTER);
    await expect(CredentialStore.decrypt(ciphertext, 'wrong-password')).rejects.toThrow();
  });

  it('throws when ciphertext is tampered with', async () => {
    const ciphertext = await CredentialStore.encrypt('secret', MASTER);
    const raw = Buffer.from(ciphertext, 'base64');
    // Flip a byte in the auth tag region
    raw[44] ^= 0xff;
    const tampered = raw.toString('base64');
    await expect(CredentialStore.decrypt(tampered, MASTER)).rejects.toThrow();
  });
});

describe('CredentialStore master password management', () => {
  const masterKeyPath = path.join(tmpDir, '.provisioning', 'master.key');

  afterEach(() => {
    if (fs.existsSync(masterKeyPath)) fs.unlinkSync(masterKeyPath);
  });

  it('hasMasterPassword returns false before setup', () => {
    expect(CredentialStore.hasMasterPassword()).toBe(false);
  });

  it('stores a master password hash and detects it', () => {
    CredentialStore.storeMasterPasswordHash(MASTER);
    expect(CredentialStore.hasMasterPassword()).toBe(true);
  });

  it('verifies the correct master password', () => {
    CredentialStore.storeMasterPasswordHash(MASTER);
    expect(CredentialStore.verifyMasterPassword(MASTER)).toBe(true);
  });

  it('rejects a wrong master password', () => {
    CredentialStore.storeMasterPasswordHash(MASTER);
    expect(CredentialStore.verifyMasterPassword('wrong-password')).toBe(false);
  });

  it('stores the hash with restrictive file permissions', () => {
    CredentialStore.storeMasterPasswordHash(MASTER);
    const stat = fs.statSync(masterKeyPath);
    // mode & 0o777: expect 0o600 (owner read/write only)
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
