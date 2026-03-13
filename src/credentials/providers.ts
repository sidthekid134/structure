export interface ProviderField {
  name: string;
  description: string;
  format?: RegExp;
  formatDescription?: string;
}

export interface ProviderDefinition {
  id: string;
  name: string;
  description: string;
  requiredFields: ProviderField[];
}

export const PROVIDERS: Record<string, ProviderDefinition> = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    description: 'OpenAI API credentials',
    requiredFields: [
      {
        name: 'api_key',
        description: 'OpenAI API key',
        format: /^sk-[A-Za-z0-9_-]{20,}$/,
        formatDescription: 'Must start with "sk-"',
      },
    ],
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    description: 'Anthropic Claude API credentials',
    requiredFields: [
      {
        name: 'api_key',
        description: 'Anthropic API key',
        format: /^sk-ant-[A-Za-z0-9_-]{20,}$/,
        formatDescription: 'Must start with "sk-ant-"',
      },
    ],
  },
  vertex_ai: {
    id: 'vertex_ai',
    name: 'Vertex AI',
    description: 'Google Cloud Vertex AI credentials',
    requiredFields: [
      {
        name: 'project_id',
        description: 'Google Cloud project ID',
      },
      {
        name: 'service_account_key',
        description: 'Service account JSON key (base64-encoded)',
      },
    ],
  },
  firebase: {
    id: 'firebase',
    name: 'Firebase',
    description: 'Google Firebase credentials',
    requiredFields: [
      {
        name: 'project_id',
        description: 'Firebase project ID',
      },
      {
        name: 'service_account_key',
        description: 'Service account JSON key (base64-encoded)',
      },
    ],
  },
  apple: {
    id: 'apple',
    name: 'Apple',
    description: 'Apple Developer credentials',
    requiredFields: [
      {
        name: 'key_id',
        description: 'Apple key ID (10-character alphanumeric)',
        format: /^[A-Z0-9]{10}$/,
        formatDescription: 'Must be a 10-character uppercase alphanumeric string',
      },
      {
        name: 'team_id',
        description: 'Apple team ID (10-character alphanumeric)',
        format: /^[A-Z0-9]{10}$/,
        formatDescription: 'Must be a 10-character uppercase alphanumeric string',
      },
      {
        name: 'private_key',
        description: 'Apple private key (.p8 file contents)',
      },
    ],
  },
  github: {
    id: 'github',
    name: 'GitHub',
    description: 'GitHub API credentials',
    requiredFields: [
      {
        name: 'token',
        description: 'GitHub personal access token or app token',
        format: /^(ghp_|gho_|github_pat_|v1\.)[A-Za-z0-9_]{20,}$/,
        formatDescription: 'Must start with "ghp_", "gho_", "github_pat_", or "v1."',
      },
    ],
  },
};

export function getProvider(id: string): ProviderDefinition | undefined {
  return PROVIDERS[id];
}

export function listProviderIds(): string[] {
  return Object.keys(PROVIDERS);
}
