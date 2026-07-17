import {
  validateCloudflareAccountId,
  validateCloudflareToken,
  validateByType,
} from '../validators/credential-validators';
import { CredentialError } from '../types';

describe('validateCloudflareAccountId', () => {
  it('accepts a 32-character lowercase hex account ID', () => {
    const result = validateCloudflareAccountId('0123456789abcdef0123456789abcdef');
    expect(result.valid).toBe(true);
  });

  it('accepts a 32-character uppercase hex account ID', () => {
    const result = validateCloudflareAccountId('0123456789ABCDEF0123456789ABCDEF');
    expect(result.valid).toBe(true);
  });

  it('rejects an empty account ID', () => {
    expect(() => validateCloudflareAccountId('')).toThrow(CredentialError);
  });

  it('rejects an account ID that is not 32 hex characters', () => {
    expect(() => validateCloudflareAccountId('too-short')).toThrow(/32-character hex string/);
  });

  it('rejects a Cloudflare zone ID mistakenly passed as the account ID (still 32 hex chars is fine, but garbage is not)', () => {
    expect(() => validateCloudflareAccountId('not-a-valid-account-id-at-all!!')).toThrow(CredentialError);
  });
});

describe('validateCloudflareToken', () => {
  it('still enforces the minimum length check for account-owned tokens', () => {
    expect(() => validateCloudflareToken('short')).toThrow(/too short/);
  });

  it('accepts a sufficiently long account-owned token', () => {
    const result = validateCloudflareToken('cfat_' + 'a'.repeat(40));
    expect(result.valid).toBe(true);
  });
});

describe('validateByType dispatch for cloudflare_account_id', () => {
  it('routes to validateCloudflareAccountId', () => {
    expect(() => validateByType('cloudflare_account_id', 'nope')).toThrow(CredentialError);
    expect(validateByType('cloudflare_account_id', '0123456789abcdef0123456789abcdef').valid).toBe(true);
  });
});
