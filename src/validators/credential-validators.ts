/**
 * Provider-specific credential validators.
 *
 * Each validator either resolves with metadata about the credential
 * (e.g., file hash, extracted fields) or throws CredentialError with
 * actionable guidance for the user.
 *
 * These validators are called from the credential collection API before
 * the value is stored. They do NOT make live API calls to external services
 * (that happens in the connection services). They validate format only.
 */

import * as crypto from 'crypto';
import { CredentialError } from '../types.js';
import { validateAppleP8Key } from './apple-key-validator.js';
import type { CredentialType } from '../services/credential-service.js';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// GitHub PAT
// ---------------------------------------------------------------------------

export function validateGitHubPAT(token: string): ValidationResult {
  if (!token || typeof token !== 'string') {
    throw new CredentialError('GitHub PAT must not be empty.', 'validateGitHubPAT');
  }
  const trimmed = token.trim();
  if (!trimmed.startsWith('ghp_') && !trimmed.startsWith('github_pat_')) {
    throw new CredentialError(
      'GitHub PAT must start with "ghp_" (classic) or "github_pat_" (fine-grained). ' +
        'Generate a token at: https://github.com/settings/tokens\n' +
        'Required scopes: repo, workflow, read:org.',
      'validateGitHubPAT',
    );
  }
  if (trimmed.length < 40) {
    throw new CredentialError(
      'GitHub PAT appears incomplete. Ensure you copied the full token without trailing spaces.',
      'validateGitHubPAT',
    );
  }
  return {
    valid: true,
    metadata: { token_type: trimmed.startsWith('github_pat_') ? 'fine-grained' : 'classic' },
  };
}

// ---------------------------------------------------------------------------
// Apple .p8 file
// ---------------------------------------------------------------------------

export function validateAppleP8File(fileBuffer: Buffer, keyId?: string, teamId?: string): ValidationResult {
  const result = validateAppleP8Key(fileBuffer);
  const metadata: Record<string, unknown> = {
    credential_hash: result.credential_hash,
    file_size_bytes: fileBuffer.length,
  };
  if (keyId) metadata['key_id'] = keyId;
  if (teamId) metadata['team_id'] = teamId;
  return { valid: true, metadata };
}

// ---------------------------------------------------------------------------
// Cloudflare API token
// ---------------------------------------------------------------------------

export function validateCloudflareToken(token: string): ValidationResult {
  if (!token || typeof token !== 'string') {
    throw new CredentialError('Cloudflare API token must not be empty.', 'validateCloudflareToken');
  }
  const trimmed = token.trim();
  if (trimmed.length < 30) {
    throw new CredentialError(
      'Cloudflare API token appears too short. ' +
        'Generate a scoped API token at: https://dash.cloudflare.com/profile/api-tokens\n' +
        'Required permissions: Zone:DNS:Edit, Zone:Zone:Read.',
      'validateCloudflareToken',
    );
  }
  return { valid: true, metadata: { token_length: trimmed.length } };
}

// ---------------------------------------------------------------------------
// Google Play service account JSON
// ---------------------------------------------------------------------------

interface ServiceAccountJson {
  type?: string;
  project_id?: string;
  private_key_id?: string;
  private_key?: string;
  client_email?: string;
}

export function validateGooglePlayKey(fileBuffer: Buffer): ValidationResult {
  let parsed: ServiceAccountJson;
  try {
    parsed = JSON.parse(fileBuffer.toString('utf8')) as ServiceAccountJson;
  } catch {
    throw new CredentialError(
      'Google Play service account key must be a valid JSON file. ' +
        'Download the JSON key from: Google Cloud Console → IAM → Service Accounts → Keys.',
      'validateGooglePlayKey',
    );
  }

  const requiredFields: (keyof ServiceAccountJson)[] = [
    'type',
    'project_id',
    'private_key_id',
    'private_key',
    'client_email',
  ];
  const missing = requiredFields.filter((f) => !parsed[f]);
  if (missing.length > 0) {
    throw new CredentialError(
      `Google Play service account JSON is missing required fields: ${missing.join(', ')}. ` +
        'Ensure you downloaded the complete JSON key file from Google Cloud Console.',
      'validateGooglePlayKey',
    );
  }

  if (parsed.type !== 'service_account') {
    throw new CredentialError(
      `Invalid service account type: "${parsed.type}". Expected "service_account". ` +
        'Ensure you are using a service account key, not an OAuth client JSON.',
      'validateGooglePlayKey',
    );
  }

  if (!parsed.private_key?.includes('-----BEGIN RSA PRIVATE KEY-----') &&
      !parsed.private_key?.includes('-----BEGIN PRIVATE KEY-----')) {
    throw new CredentialError(
      'Service account private_key does not appear to be a valid PEM-encoded RSA key.',
      'validateGooglePlayKey',
    );
  }

  const fileHash = crypto
    .createHash('sha256')
    .update(fileBuffer)
    .digest('hex');

  return {
    valid: true,
    metadata: {
      project_id: parsed.project_id,
      client_email: parsed.client_email,
      private_key_id: parsed.private_key_id,
      file_hash: fileHash,
    },
  };
}

// ---------------------------------------------------------------------------
// LLM API keys (OpenAI / Anthropic / Gemini / custom OpenAI-compatible)
// ---------------------------------------------------------------------------

/**
 * Format-only validation. Live verification (calling the provider's models
 * endpoint with the key) happens in the LLM endpoint layer so that errors
 * propagate back to the user with the upstream message intact.
 */
export function validateLlmApiKey(
  kind: 'openai' | 'anthropic' | 'gemini' | 'custom',
  key: string,
): ValidationResult {
  if (!key || typeof key !== 'string') {
    throw new CredentialError(`LLM ${kind} API key must not be empty.`, 'validateLlmApiKey');
  }
  const trimmed = key.trim();
  if (trimmed.length < 10) {
    throw new CredentialError(
      `LLM ${kind} API key appears too short. Paste the complete key.`,
      'validateLlmApiKey',
    );
  }
  if (trimmed.length > 4096) {
    throw new CredentialError(
      `LLM ${kind} API key is unusually long; ensure you pasted only the key.`,
      'validateLlmApiKey',
    );
  }
  // Lightweight prefix hints — soft validation only, since key formats can
  // change. We don't reject on prefix mismatch to avoid blocking legitimate
  // new key formats from these providers.
  return {
    valid: true,
    metadata: {
      key_length: trimmed.length,
      kind,
    },
  };
}

// ---------------------------------------------------------------------------
// Expo token
// ---------------------------------------------------------------------------

export function validateExpoToken(token: string): ValidationResult {
  if (!token || typeof token !== 'string') {
    throw new CredentialError('Expo token must not be empty.', 'validateExpoToken');
  }
  const trimmed = token.trim();
  if (trimmed.length < 10) {
    throw new CredentialError(
      'Expo access token appears too short. ' +
        'Get your token at: https://expo.dev/accounts/[account]/settings/access-tokens',
      'validateExpoToken',
    );
  }
  return { valid: true, metadata: { token_length: trimmed.length } };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Routes to the correct validator for a credential type.
 * For file-based types (apple_p8, google_play_key), pass the raw file buffer.
 */
export function validateByType(
  type: CredentialType,
  value: string,
  fileBuffer?: Buffer,
): ValidationResult {
  switch (type) {
    case 'github_pat':
      return validateGitHubPAT(value);
    case 'cloudflare_token':
      return validateCloudflareToken(value);
    case 'expo_token':
      return validateExpoToken(value);
    case 'apple_p8':
      if (!fileBuffer) throw new CredentialError('apple_p8 requires a file buffer.', 'validateByType');
      return validateAppleP8File(fileBuffer);
    case 'google_play_key':
      if (!fileBuffer) throw new CredentialError('google_play_key requires a file buffer.', 'validateByType');
      return validateGooglePlayKey(fileBuffer);
    case 'apple_team_id':
      if (!/^[A-Z0-9]{10}$/.test(value.trim())) {
        throw new CredentialError(
          `Invalid Apple Team ID "${value}". Must be 10 uppercase alphanumeric characters.`,
          'validateByType',
        );
      }
      return { valid: true, metadata: {} };
    case 'domain_name': {
      const domainRegex = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
      if (!domainRegex.test(value.trim())) {
        throw new CredentialError(
          `Invalid domain name "${value}". Must be a valid hostname (e.g., example.com).`,
          'validateByType',
        );
      }
      return { valid: true, metadata: {} };
    }
    case 'llm_openai_api_key':
      return validateLlmApiKey('openai', value);
    case 'llm_anthropic_api_key':
      return validateLlmApiKey('anthropic', value);
    case 'llm_gemini_api_key':
      return validateLlmApiKey('gemini', value);
    case 'llm_custom_api_key':
      return validateLlmApiKey('custom', value);
    default:
      return { valid: true, metadata: {} };
  }
}
