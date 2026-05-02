import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { CredentialStore } from '../services/credential-store';
import { testDeriveKey } from './helpers/test-key.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-flow-test-'));
}

function makeStore(dir: string): CredentialStore {
  return new CredentialStore(dir, (purpose: string) => testDeriveKey('test-passphrase-flow', purpose));
}

// ---------------------------------------------------------------------------
// OAuth Session State (via CredentialStore)
// ---------------------------------------------------------------------------

describe('OAuth Session State', () => {
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

  it('creates a session with a unique state_token', () => {
    const session = store.createOAuthSession('proj-1', 'google', 'https://example.com/callback');
    expect(session.id).toBeTruthy();
    expect(session.state_token).toHaveLength(64);
    expect(session.completed).toBe(false);
    expect(session.access_token).toBeNull();
  });

  it('expires_at is approximately TTL seconds from now', () => {
    const before = Date.now();
    const session = store.createOAuthSession('proj-1', 'google', 'https://example.com/callback', 3600);
    const after = Date.now();
    expect(session.expires_at).toBeGreaterThanOrEqual(before + 3600 * 1000 - 100);
    expect(session.expires_at).toBeLessThanOrEqual(after + 3600 * 1000 + 100);
  });

  it('retrieves a session by ID', () => {
    const session = store.createOAuthSession('proj-1', 'google', 'https://example.com/callback');
    const retrieved = store.getOAuthSession(session.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe(session.id);
    expect(retrieved?.state_token).toBe(session.state_token);
  });

  it('returns null for unknown session ID', () => {
    const retrieved = store.getOAuthSession('non-existent-id');
    expect(retrieved).toBeNull();
  });

  it('validates state token and completes session', () => {
    const session = store.createOAuthSession('proj-1', 'google', 'https://example.com/callback');
    const ok = store.validateAndCompleteOAuthSession(session.id, session.state_token, 'access-token-abc');
    expect(ok).toBe(true);

    const updated = store.getOAuthSession(session.id);
    expect(updated?.completed).toBe(true);
    expect(updated?.access_token).toBe('access-token-abc');
  });

  it('rejects completion with wrong state token (CSRF protection)', () => {
    const session = store.createOAuthSession('proj-1', 'google', 'https://example.com/callback');
    const ok = store.validateAndCompleteOAuthSession(session.id, 'wrong-state-token', 'token');
    expect(ok).toBe(false);
  });

  it('rejects completing an already-completed session', () => {
    const session = store.createOAuthSession('proj-1', 'google', 'https://example.com/callback');
    store.validateAndCompleteOAuthSession(session.id, session.state_token, 'token-1');
    const second = store.validateAndCompleteOAuthSession(session.id, session.state_token, 'token-2');
    expect(second).toBe(false);
  });

  it('rejects completing an expired session', () => {
    const session = store.createOAuthSession('proj-2', 'apple', 'https://example.com/callback', -1);
    const ok = store.validateAndCompleteOAuthSession(session.id, session.state_token, 'token');
    expect(ok).toBe(false);
  });

  it('cleans up expired sessions', () => {
    store.createOAuthSession('proj-3', 'google', 'https://example.com/callback', -1);
    store.createOAuthSession('proj-3', 'google', 'https://example.com/callback', 3600);

    const deleted = store.cleanupExpiredSessions();
    expect(deleted).toBe(1);
  });

  it('generates unique state tokens per session', () => {
    const s1 = store.createOAuthSession('proj-4', 'google', 'https://example.com/callback');
    const s2 = store.createOAuthSession('proj-4', 'google', 'https://example.com/callback');
    expect(s1.state_token).not.toBe(s2.state_token);
  });

  it('stores active Google account email in access token field after completion', () => {
    const session = store.createOAuthSession('proj-5', 'google', 'https://example.com/cb');
    const fakeToken = 'ya29.fake-google-access-token';
    store.validateAndCompleteOAuthSession(session.id, session.state_token, fakeToken);
    const completed = store.getOAuthSession(session.id);
    expect(completed?.access_token).toBe(fakeToken);
  });
});

// ---------------------------------------------------------------------------
// validatePlayFingerprint (cross-import test)
// ---------------------------------------------------------------------------

describe('validatePlayFingerprint', () => {
  it('accepts colon-separated SHA-1', async () => {
    const { validatePlayFingerprint } = await import('../validators/play-fingerprint-validator');
    const result = validatePlayFingerprint('AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD');
    expect(result.valid).toBe(true);
    expect(result.raw_hex).toHaveLength(40);
  });

  it('accepts raw 40-char hex', async () => {
    const { validatePlayFingerprint } = await import('../validators/play-fingerprint-validator');
    const result = validatePlayFingerprint('aabbccddeeff00112233445566778899aabbccdd');
    expect(result.valid).toBe(true);
    expect(result.normalized).toMatch(/^([0-9A-F]{2}:){19}[0-9A-F]{2}$/);
  });

  it('rejects invalid format', async () => {
    const { validatePlayFingerprint } = await import('../validators/play-fingerprint-validator');
    const { CredentialError: CE } = await import('../types');
    expect(() => validatePlayFingerprint('not-a-fingerprint')).toThrow(CE);
    expect(() => validatePlayFingerprint('')).toThrow(CE);
  });
});
