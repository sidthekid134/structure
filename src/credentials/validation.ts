import { getProvider } from './providers';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export class CredentialValidator {
  validate(provider: string, credentials: Record<string, string>): ValidationResult {
    const def = getProvider(provider);
    if (!def) {
      return { valid: false, errors: [`Unknown provider: "${provider}"`] };
    }

    const errors: string[] = [];

    for (const field of def.requiredFields) {
      const value = credentials[field.name];

      if (value === undefined || value === '') {
        errors.push(`Missing required field: "${field.name}"`);
        continue;
      }

      if (field.format && !field.format.test(value)) {
        errors.push(
          `Invalid format for "${field.name}": ${field.formatDescription ?? 'format mismatch'}`
        );
      }
    }

    return { valid: errors.length === 0, errors };
  }
}
