import { Vault } from '../credentials/vault';

export class CredentialResolver {
  private vault: Vault;

  constructor(vault: Vault) {
    this.vault = vault;
  }

  resolveCredentials(operationId: string, providerName: string): Record<string, string> {
    const keys = this.vault.list(providerName);
    if (keys.length === 0) {
      throw new Error(
        `No credentials found for provider "${providerName}" (operationId=${operationId})`
      );
    }
    const credentials: Record<string, string> = {};
    for (const key of keys) {
      credentials[key] = this.vault.retrieve(providerName, key);
    }
    return credentials;
  }
}
