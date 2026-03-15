import { InputValidator } from '../validation';
import { ValidationError } from '../types';
import * as crypto from 'crypto';

describe('InputValidator.validateCredentialInput', () => {
  it('passes for valid inputs', () => {
    expect(() =>
      InputValidator.validateCredentialInput('eas', 'token', 'abc123'),
    ).not.toThrow();
  });

  it('rejects empty providerId', () => {
    expect(() =>
      InputValidator.validateCredentialInput('', 'key', 'val'),
    ).toThrow(ValidationError);
  });

  it('rejects providerId with spaces', () => {
    expect(() =>
      InputValidator.validateCredentialInput('my provider', 'key', 'val'),
    ).toThrow(ValidationError);
  });

  it('rejects empty key', () => {
    expect(() =>
      InputValidator.validateCredentialInput('eas', '', 'val'),
    ).toThrow(ValidationError);
  });

  it('rejects empty value', () => {
    expect(() =>
      InputValidator.validateCredentialInput('eas', 'token', ''),
    ).toThrow(ValidationError);
  });
});

describe('InputValidator.validateVaultPath', () => {
  it('passes for a valid absolute .enc path', () => {
    expect(() =>
      InputValidator.validateVaultPath('/home/user/.platform/credentials.enc'),
    ).not.toThrow();
  });

  it('rejects relative paths', () => {
    expect(() =>
      InputValidator.validateVaultPath('./credentials.enc'),
    ).toThrow(ValidationError);
  });

  it('rejects paths without .enc extension', () => {
    expect(() =>
      InputValidator.validateVaultPath('/home/user/.platform/credentials'),
    ).toThrow(ValidationError);
  });

  it('rejects path traversal sequences', () => {
    expect(() =>
      InputValidator.validateVaultPath('/home/user/../etc/credentials.enc'),
    ).toThrow(ValidationError);
  });

  it('rejects empty string', () => {
    expect(() => InputValidator.validateVaultPath('')).toThrow(ValidationError);
  });
});

describe('InputValidator.validateEncryptionKey', () => {
  it('passes for a 32-byte Buffer', () => {
    expect(() =>
      InputValidator.validateEncryptionKey(crypto.randomBytes(32)),
    ).not.toThrow();
  });

  it('rejects a Buffer with wrong length', () => {
    expect(() =>
      InputValidator.validateEncryptionKey(crypto.randomBytes(16)),
    ).toThrow(ValidationError);
  });

  it('rejects a non-Buffer', () => {
    expect(() =>
      InputValidator.validateEncryptionKey('not-a-buffer' as never),
    ).toThrow(ValidationError);
  });
});

describe('InputValidator.validatePassphrase', () => {
  it('passes for a strong passphrase', () => {
    expect(() =>
      InputValidator.validatePassphrase('my-strong-passphrase!'),
    ).not.toThrow();
  });

  it('rejects passphrase shorter than 12 chars', () => {
    expect(() => InputValidator.validatePassphrase('short')).toThrow(
      ValidationError,
    );
  });

  it('rejects empty passphrase', () => {
    expect(() => InputValidator.validatePassphrase('')).toThrow(ValidationError);
  });

  it('rejects all-whitespace passphrase', () => {
    expect(() => InputValidator.validatePassphrase('            ')).toThrow(
      ValidationError,
    );
  });
});
