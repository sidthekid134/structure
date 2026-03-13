import { getProvider, listProviderIds, ProviderDefinition } from './providers';
import { CredentialValidator, ValidationResult } from './validation';
import { NotFoundError, Vault } from './vault';

export interface AddResult {
  success: boolean;
  errors: string[];
}

export interface ProviderSummary {
  id: string;
  name: string;
  description: string;
  requiredFields: string[];
}

const validator = new CredentialValidator();

export class CredentialIngestionService {
  private readonly vault: Vault;

  constructor(masterPassword: string) {
    this.vault = new Vault(masterPassword);
  }

  addCredential(provider: string, credentials: Record<string, string>): AddResult {
    const result: ValidationResult = validator.validate(provider, credentials);
    if (!result.valid) {
      return { success: false, errors: result.errors };
    }

    const def = getProvider(provider)!;
    for (const field of def.requiredFields) {
      this.vault.store(provider, field.name, credentials[field.name]);
    }

    return { success: true, errors: [] };
  }

  getCredential(provider: string, key: string): string {
    return this.vault.retrieve(provider, key);
  }

  updateCredential(provider: string, key: string, newValue: string): AddResult {
    const def = getProvider(provider);
    if (!def) {
      return { success: false, errors: [`Unknown provider: "${provider}"`] };
    }

    const field = def.requiredFields.find((f) => f.name === key);
    if (!field) {
      return { success: false, errors: [`Unknown field "${key}" for provider "${provider}"`] };
    }

    if (field.format && !field.format.test(newValue)) {
      return {
        success: false,
        errors: [
          `Invalid format for "${key}": ${field.formatDescription ?? 'format mismatch'}`,
        ],
      };
    }

    this.vault.store(provider, key, newValue);
    return { success: true, errors: [] };
  }

  deleteCredential(provider: string, key: string): void {
    this.vault.delete(provider, key);
  }

  listProviders(): ProviderSummary[] {
    return listProviderIds().map((id) => {
      const def = getProvider(id) as ProviderDefinition;
      return {
        id: def.id,
        name: def.name,
        description: def.description,
        requiredFields: def.requiredFields.map((f) => f.name),
      };
    });
  }

  listStoredKeys(provider: string): string[] {
    return this.vault.list(provider);
  }
}
