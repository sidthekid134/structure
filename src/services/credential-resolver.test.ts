import { CredentialResolver } from './credential-resolver';
import { Vault } from '../credentials/vault';

jest.mock('../credentials/vault');

describe('CredentialResolver', () => {
  let mockVault: jest.Mocked<Vault>;
  let resolver: CredentialResolver;

  beforeEach(() => {
    mockVault = new (Vault as jest.MockedClass<typeof Vault>)('password') as jest.Mocked<Vault>;
    resolver = new CredentialResolver(mockVault);
  });

  it('returns credentials for all keys in the vault for a provider', () => {
    mockVault.list.mockReturnValue(['api_key', 'secret']);
    mockVault.retrieve.mockImplementation((_provider, key) => {
      if (key === 'api_key') return 'sk-test-key';
      if (key === 'secret') return 'my-secret';
      return '';
    });

    const result = resolver.resolveCredentials('op-1', 'openai');

    expect(mockVault.list).toHaveBeenCalledWith('openai');
    expect(mockVault.retrieve).toHaveBeenCalledWith('openai', 'api_key');
    expect(mockVault.retrieve).toHaveBeenCalledWith('openai', 'secret');
    expect(result).toEqual({ api_key: 'sk-test-key', secret: 'my-secret' });
  });

  it('returns empty object when provider has no credentials', () => {
    mockVault.list.mockReturnValue([]);

    const result = resolver.resolveCredentials('op-2', 'github');

    expect(result).toEqual({});
    expect(mockVault.retrieve).not.toHaveBeenCalled();
  });

  it('passes operationId in call but uses providerName for vault lookup', () => {
    mockVault.list.mockReturnValue(['token']);
    mockVault.retrieve.mockReturnValue('ghp_test123');

    const result = resolver.resolveCredentials('op-xyz', 'github');

    expect(mockVault.list).toHaveBeenCalledWith('github');
    expect(result).toEqual({ token: 'ghp_test123' });
  });
});
