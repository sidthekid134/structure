import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { CredentialService, CREDENTIAL_TYPES } from '../credentials/credentialService';
import { CredentialError, ValidationError } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-svc-test-'));
  return path.join(dir, 'test.db');
}

function makeService(dbPath?: string): CredentialService {
  const p = dbPath ?? makeTempDb();
  return new CredentialService(p, 'test-master-passphrase-secret-32chars');
}

// Valid fixture values for each credential type
const FIXTURES = {
  github_pat:       'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  cloudflare_token: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', // 40 chars
  apple_p8:         '-----BEGIN PRIVATE KEY-----\nMIGHAgEA…\n-----END PRIVATE KEY-----',
  apple_team_id:    'ABCD123456',
  google_play_key:  JSON.stringify({
    type: 'service_account',
    private_key: '-----BEGIN RSA PRIVATE KEY-----\nMII…\n-----END RSA PRIVATE KEY-----',
    client_email: 'test@project.iam.gserviceaccount.com',
  }),
  expo_token:       'expo_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  domain_name:      'example.com',
} as const;

// ---------------------------------------------------------------------------
// encrypt / decrypt round-trip
// ---------------------------------------------------------------------------

describe('CredentialService — encrypt / decrypt', () => {
  let svc: CredentialService;

  beforeEach(() => { svc = makeService(); });
  afterEach(() => { svc.close(); });

  it('round-trips a plaintext value', () => {
    const { ciphertext, iv, authTag } = svc.encrypt('secret-value', 'proj-1', 'github_pat');
    expect(ciphertext).toBeInstanceOf(Buffer);
    expect(iv).toHaveLength(32);    // 16 bytes hex
    expect(authTag).toHaveLength(32);
    const plaintext = svc.decrypt(ciphertext, iv, authTag, 'proj-1', 'github_pat');
    expect(plaintext).toBe('secret-value');
  });

  it('uses a unique IV on every call (random IV)', () => {
    const r1 = svc.encrypt('same-value', 'proj-1', 'github_pat');
    const r2 = svc.encrypt('same-value', 'proj-1', 'github_pat');
    expect(r1.iv).not.toBe(r2.iv);
    expect(r1.ciphertext.toString('hex')).not.toBe(r2.ciphertext.toString('hex'));
  });

  it('throws CredentialError when decrypting with wrong key (different project)', () => {
    const { ciphertext, iv, authTag } = svc.encrypt('secret', 'proj-1', 'github_pat');
    expect(() => svc.decrypt(ciphertext, iv, authTag, 'proj-DIFFERENT', 'github_pat')).toThrow(CredentialError);
  });

  it('throws CredentialError on tampered ciphertext', () => {
    const { ciphertext, iv, authTag } = svc.encrypt('secret', 'proj-1', 'github_pat');
    ciphertext[0] ^= 0xff; // flip byte
    expect(() => svc.decrypt(ciphertext, iv, authTag, 'proj-1', 'github_pat')).toThrow(CredentialError);
  });

  it('throws CredentialError for empty plaintext', () => {
    expect(() => svc.encrypt('', 'proj-1', 'github_pat')).toThrow(CredentialError);
  });

  it('ciphertext is not the plaintext', () => {
    const plain = 'my-secret-token';
    const { ciphertext } = svc.encrypt(plain, 'proj-1', 'github_pat');
    expect(ciphertext.toString('utf8')).not.toContain(plain);
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('CredentialService — validateCredential', () => {
  let svc: CredentialService;
  beforeEach(() => { svc = makeService(); });
  afterEach(() => { svc.close(); });

  it.each(Object.entries(FIXTURES))(
    'accepts valid %s value',
    (type, value) => {
      expect(() => svc.validateCredential(type as never, value)).not.toThrow();
    },
  );

  it('rejects empty value for any type', () => {
    for (const type of CREDENTIAL_TYPES) {
      expect(() => svc.validateCredential(type, '')).toThrow(ValidationError);
      expect(() => svc.validateCredential(type, '   ')).toThrow(ValidationError);
    }
  });

  it('rejects invalid github_pat', () => {
    expect(() => svc.validateCredential('github_pat', 'not-a-token')).toThrow(ValidationError);
  });

  it('rejects invalid cloudflare_token (too short)', () => {
    expect(() => svc.validateCredential('cloudflare_token', 'short')).toThrow(ValidationError);
  });

  it('rejects apple_p8 without PEM header', () => {
    expect(() => svc.validateCredential('apple_p8', 'MIGHAGE…')).toThrow(ValidationError);
  });

  it('rejects apple_team_id that is not 10 uppercase chars', () => {
    expect(() => svc.validateCredential('apple_team_id', 'abc123')).toThrow(ValidationError);
    expect(() => svc.validateCredential('apple_team_id', 'abcd123456')).toThrow(ValidationError); // lowercase
  });

  it('rejects google_play_key without required fields', () => {
    expect(() =>
      svc.validateCredential('google_play_key', JSON.stringify({ type: 'not_service_account' })),
    ).toThrow(ValidationError);
  });

  it('rejects google_play_key that is not valid JSON', () => {
    expect(() => svc.validateCredential('google_play_key', 'not-json')).toThrow(ValidationError);
  });

  it('rejects expo_token that is too short', () => {
    expect(() => svc.validateCredential('expo_token', 'expo_short')).toThrow(ValidationError);
  });

  it('rejects invalid domain_name', () => {
    expect(() => svc.validateCredential('domain_name', 'not a domain')).toThrow(ValidationError);
    expect(() => svc.validateCredential('domain_name', 'nodot')).toThrow(ValidationError);
  });

  it('accepts EC PRIVATE KEY header for apple_p8', () => {
    expect(() =>
      svc.validateCredential(
        'apple_p8',
        '-----BEGIN EC PRIVATE KEY-----\nMHQCAQEEIA==\n-----END EC PRIVATE KEY-----',
      ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// storeCredential / retrieveCredential
// ---------------------------------------------------------------------------

describe('CredentialService — storeCredential / retrieveCredential', () => {
  let svc: CredentialService;
  beforeEach(() => { svc = makeService(); });
  afterEach(() => { svc.close(); });

  it('stores and retrieves a credential', () => {
    const id = svc.storeCredential('proj-1', 'github_pat', FIXTURES.github_pat);
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    const retrieved = svc.retrieveCredential(id);
    expect(retrieved).toBe(FIXTURES.github_pat);
  });

  it('returns a UUID-shaped ID', () => {
    const id = svc.storeCredential('proj-1', 'expo_token', FIXTURES.expo_token);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('stores different types for the same project independently', () => {
    const id1 = svc.storeCredential('proj-1', 'github_pat', FIXTURES.github_pat);
    const id2 = svc.storeCredential('proj-1', 'domain_name', FIXTURES.domain_name);
    expect(id1).not.toBe(id2);
    expect(svc.retrieveCredential(id1)).toBe(FIXTURES.github_pat);
    expect(svc.retrieveCredential(id2)).toBe(FIXTURES.domain_name);
  });

  it('updates in place and returns same ID when same type already exists', () => {
    const id1 = svc.storeCredential('proj-1', 'domain_name', 'example.com');
    const id2 = svc.storeCredential('proj-1', 'domain_name', 'updated.io');
    expect(id1).toBe(id2); // same row updated
    expect(svc.retrieveCredential(id1)).toBe('updated.io');
  });

  it('enforces one credential per (projectId, type) — second store updates, not duplicates', () => {
    svc.storeCredential('proj-1', 'apple_team_id', 'ABCD123456');
    svc.storeCredential('proj-1', 'apple_team_id', 'ZZZZ999999');
    const id = svc.storeCredential('proj-1', 'apple_team_id', 'XXXX111111');
    expect(svc.retrieveCredential(id)).toBe('XXXX111111');
  });

  it('stores extra metadata alongside credential', () => {
    const hash = 'abc123hash';
    const id = svc.storeCredential('proj-1', 'apple_p8', FIXTURES.apple_p8, { fileHash: hash });
    // Retrieve succeeds (metadata is used internally for iv/authTag)
    expect(svc.retrieveCredential(id)).toBe(FIXTURES.apple_p8);
  });

  it('throws ValidationError when storing invalid value', () => {
    expect(() => svc.storeCredential('proj-1', 'github_pat', 'bad-token')).toThrow(ValidationError);
  });

  it('throws CredentialError when retrieving unknown ID', () => {
    expect(() => svc.retrieveCredential('00000000-0000-0000-0000-000000000000')).toThrow(CredentialError);
  });

  it('plaintext is not stored in the database file', () => {
    const dbPath = makeTempDb();
    const svc2 = new CredentialService(dbPath, 'test-master-passphrase-secret-32chars');
    const secret = FIXTURES.github_pat;
    svc2.storeCredential('proj-1', 'github_pat', secret);
    svc2.close();

    const raw = fs.readFileSync(dbPath);
    expect(raw.toString('latin1')).not.toContain(secret);
  });
});

// ---------------------------------------------------------------------------
// deleteCredential (soft-delete)
// ---------------------------------------------------------------------------

describe('CredentialService — deleteCredential', () => {
  let svc: CredentialService;
  beforeEach(() => { svc = makeService(); });
  afterEach(() => { svc.close(); });

  it('soft-deletes a credential so it cannot be retrieved', () => {
    const id = svc.storeCredential('proj-1', 'expo_token', FIXTURES.expo_token);
    svc.deleteCredential(id);
    expect(() => svc.retrieveCredential(id)).toThrow(CredentialError);
  });

  it('throws CredentialError when deleting non-existent credential', () => {
    expect(() => svc.deleteCredential('00000000-0000-0000-0000-000000000000')).toThrow(CredentialError);
  });

  it('throws CredentialError when deleting already-deleted credential', () => {
    const id = svc.storeCredential('proj-1', 'expo_token', FIXTURES.expo_token);
    svc.deleteCredential(id);
    expect(() => svc.deleteCredential(id)).toThrow(CredentialError);
  });

  it('allows storing a new credential of the same type after soft-delete', () => {
    svc.storeCredential('proj-1', 'cloudflare_token', FIXTURES.cloudflare_token);
    const id1 = svc.storeCredential('proj-1', 'cloudflare_token', FIXTURES.cloudflare_token);
    svc.deleteCredential(id1);

    // After delete, a new credential can be stored for the same project + type
    const id2 = svc.storeCredential('proj-1', 'cloudflare_token', FIXTURES.cloudflare_token);
    expect(svc.retrieveCredential(id2)).toBe(FIXTURES.cloudflare_token);
  });
});

// ---------------------------------------------------------------------------
// purgeExpiredCredentials
// ---------------------------------------------------------------------------

describe('CredentialService — purgeExpiredCredentials', () => {
  it('purges nothing when no credentials are soft-deleted', () => {
    const svc = makeService();
    svc.storeCredential('proj-1', 'domain_name', FIXTURES.domain_name);
    expect(svc.purgeExpiredCredentials(0)).toBe(0);
    svc.close();
  });

  it('purges soft-deleted credentials past the cutoff', () => {
    const svc = makeService();
    const id = svc.storeCredential('proj-1', 'domain_name', FIXTURES.domain_name);
    svc.deleteCredential(id);
    // daysOld = 0 means anything deleted in the past is eligible
    const purged = svc.purgeExpiredCredentials(0);
    expect(purged).toBe(1);
    svc.close();
  });

  it('does not purge credentials deleted within the retention window', () => {
    const svc = makeService();
    const id = svc.storeCredential('proj-1', 'domain_name', FIXTURES.domain_name);
    svc.deleteCredential(id);
    // 30-day window → recently deleted credentials survive
    const purged = svc.purgeExpiredCredentials(30);
    expect(purged).toBe(0);
    svc.close();
  });
});
