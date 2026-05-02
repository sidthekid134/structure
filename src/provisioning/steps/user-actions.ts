import type { UserActionNode } from '../graph.types.js';

export const USER_ACTIONS: UserActionNode[] = [
  {
    type: 'user-action',
    key: 'user:enroll-apple-developer',
    label: 'Apple Developer Program',
    description:
      'Enroll in the Apple Developer Program ($99/year). Required for App IDs, certificates, and App Store distribution.',
    category: 'account-enrollment',
    provider: 'apple',
    verification: { type: 'api-check', description: 'Verify team ID via App Store Connect API' },
    helpUrl: 'https://developer.apple.com/programs/enroll/',
    platforms: ['ios'],
    dependencies: [],
    produces: [
      {
        key: 'apple_team_id',
        label: 'Apple Team ID',
        description: 'Team ID from Apple Developer account',
      },
    ],
  },
  {
    type: 'user-action',
    key: 'user:connect-apple-integration',
    label: 'Connect Apple Developer Integration',
    description:
      'Provide your Apple Team ID and App Store Connect API credentials (Issuer ID, Key ID, .p8 file). Studio uses these at the org level to register App IDs, manage APNs keys, and automate App Store submissions across all projects.',
    category: 'credential-upload',
    provider: 'apple',
    verification: { type: 'api-check', description: 'Verify org-level Apple integration is configured' },
    interactiveAction: { type: 'integration-connect', provider: 'apple', label: 'Set Up Apple Integration' },
    platforms: ['ios'],
    dependencies: [{ nodeKey: 'user:enroll-apple-developer', required: true }],
    produces: [
      { key: 'apple_integration_connected', label: 'Apple Integration', description: 'Org Apple integration configured with team_id and ASC credentials' },
    ],
  },
  {
    type: 'user-action',
    key: 'user:enroll-google-play',
    label: 'Google Play Developer Account',
    description:
      'Register a Google Play Developer account ($25 one-time). Required for Play Console app listings.',
    category: 'account-enrollment',
    provider: 'google-play',
    verification: { type: 'manual-confirm' },
    helpUrl: 'https://play.google.com/console/signup',
    platforms: ['android'],
    dependencies: [],
    produces: [
      {
        key: 'play_developer_id',
        label: 'Play Developer ID',
        description: 'Google Play developer account ID',
      },
    ],
  },
  {
    type: 'user-action',
    key: 'user:setup-gcp-billing',
    label: 'GCP Billing Account',
    description:
      'Create or link a Google Cloud billing account. Required for Firebase project creation with paid services.',
    category: 'account-enrollment',
    provider: 'firebase',
    verification: {
      type: 'api-check',
      description: 'Verify billing account via Cloud Billing API',
    },
    helpUrl: 'https://console.cloud.google.com/billing',
    dependencies: [],
    produces: [
      {
        key: 'gcp_billing_account_id',
        label: 'Billing Account ID',
        description: 'GCP billing account identifier',
      },
    ],
  },
  {
    type: 'user-action',
    key: 'user:connect-gcp-integration',
    label: 'Sign in with Google',
    description:
      'Sign in with a Google account that has Owner or Editor access to the target GCP project. Studio uses this OAuth session to create and configure Cloud resources on your behalf.',
    category: 'credential-upload',
    provider: 'firebase',
    verification: { type: 'api-check', description: 'Verify stored GCP OAuth refresh token' },
    interactiveAction: { type: 'oauth', provider: 'firebase', label: 'Sign in with Google' },
    dependencies: [{ nodeKey: 'user:setup-gcp-billing', required: true }],
    produces: [
      { key: 'gcp_oauth_connected', label: 'GCP Connected', description: 'GCP OAuth refresh token stored in vault' },
    ],
  },
  {
    type: 'user-action',
    key: 'user:provide-cloudflare-token',
    label: 'Connect Cloudflare API Token',
    description:
      'Provide a Cloudflare API token with Zone:Read and DNS:Edit permissions so Studio can manage domain, DNS, SSL, and auth routing.',
    category: 'credential-upload',
    provider: 'cloudflare',
    verification: { type: 'credential-upload', secretKey: 'cloudflare_token' },
    helpUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    dependencies: [],
    produces: [
      {
        key: 'cloudflare_token',
        label: 'Cloudflare Token',
        description: 'Cloudflare API token stored in project credentials',
      },
    ],
  },
  {
    type: 'user-action',
    key: 'user:confirm-dns-nameservers',
    label: 'Verify Main Domain Ownership',
    description: "Point your domain's nameservers to Cloudflare at your registrar.",
    category: 'external-configuration',
    provider: 'cloudflare',
    verification: {
      type: 'api-check',
      description: 'Cloudflare zone activation check',
    },
    helpUrl: 'https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/',
    dependencies: [
      { nodeKey: 'user:provide-cloudflare-token', required: true },
      { nodeKey: 'cloudflare:add-domain-zone', required: true },
    ],
    produces: [
      {
        key: 'cloudflare_zone_status',
        label: 'Zone Activation Status',
        description: 'Cloudflare zone activation status for the main domain',
      },
    ],
  },
  {
    type: 'user-action',
    key: 'user:provide-github-pat',
    label: 'GitHub Personal Access Token',
    description: 'Generate a GitHub PAT with repo, workflow, and admin:org scopes.',
    category: 'credential-upload',
    provider: 'github',
    verification: { type: 'credential-upload', secretKey: 'github_token' },
    helpUrl: 'https://github.com/settings/tokens',
    dependencies: [],
    produces: [
      { key: 'github_token', label: 'GitHub Token', description: 'PAT for GitHub API access' },
    ],
  },
  {
    type: 'user-action',
    key: 'user:provide-expo-token',
    label: 'Expo Robot Token',
    description: 'Generate an Expo robot token for EAS Build and Submit automation.',
    category: 'credential-upload',
    provider: 'eas',
    verification: { type: 'credential-upload', secretKey: 'expo_token' },
    helpUrl: 'https://expo.dev/accounts/[account]/settings/access-tokens',
    dependencies: [],
    produces: [
      { key: 'expo_token', label: 'Expo Token', description: 'Robot token for EAS API' },
    ],
  },
  {
    type: 'user-action',
    key: 'user:install-expo-github-app',
    label: 'Install Expo GitHub App',
    description:
      'In Expo account settings, install/activate the Expo GitHub App for your GitHub user/org and grant it access to this repository.',
    category: 'external-configuration',
    provider: 'eas',
    verification: {
      type: 'api-check',
      description:
        'Expo GraphQL: this Expo project must show the same GitHub repo linked as in Studio (owner + repo from your created repository)',
    },
    helpUrl: 'https://docs.expo.dev/eas-update/github-integration/',
    dependencies: [
      { nodeKey: 'eas:create-project', required: true },
      { nodeKey: 'github:create-repository', required: true },
    ],
    produces: [],
  },
  {
    type: 'user-action',
    key: 'user:upload-initial-aab',
    label: 'Upload Initial App Bundle',
    description:
      'Google Play requires an initial AAB upload before API access works. Build and upload manually or via EAS.',
    category: 'external-configuration',
    provider: 'google-play',
    verification: {
      type: 'api-check',
      description: 'Check Play Console for existing release via API',
    },
    platforms: ['android'],
    dependencies: [{ nodeKey: 'google-play:create-app-listing', required: true }],
    produces: [],
  },
  {
    type: 'user-action',
    key: 'user:verify-auth-integration-kit',
    label: 'Verify App Integration Kit Applied',
    description:
      'Confirm the generated auth integration kit was applied in your app repository and auth session behavior is verified end-to-end.',
    category: 'approval',
    provider: 'oauth',
    verification: { type: 'manual-confirm' },
    dependencies: [{ nodeKey: 'oauth:prepare-app-integration-kit', required: true }],
    produces: [
      {
        key: 'auth_integration_verified',
        label: 'Auth Integration Verified',
        description: 'User confirmed app-level auth integration was applied and validated.',
      },
    ],
  },
  // -------------------------------------------------------------------------
  // LLM credential gates — one per kind. Each writes to a kind-specific
  // secret slot under provider 'llm' so multiple kinds can coexist on the
  // same project without overwriting each other's API keys.
  // -------------------------------------------------------------------------
  {
    type: 'user-action',
    key: 'user:provide-openai-api-key',
    label: 'OpenAI API Key',
    description:
      'Generate an OpenAI API key with model.read permission and paste it here. The key is encrypted at rest and used to verify model access for this project.',
    category: 'credential-upload',
    provider: 'llm',
    verification: { type: 'credential-upload', secretKey: 'openai_api_key' },
    helpUrl: 'https://platform.openai.com/api-keys',
    dependencies: [],
    produces: [
      {
        key: 'llm_openai_api_key',
        label: 'OpenAI API Key',
        description: 'Encrypted OpenAI API key scoped to this project.',
      },
      {
        key: 'llm_openai_models_available',
        label: 'OpenAI Models Available',
        description: 'Comma-separated list of model ids returned during credential validation.',
      },
      {
        key: 'llm_openai_default_model_found',
        label: 'OpenAI Default Model Present',
        description: '"true" / "false" / "unchecked" — whether the manifest default appears in the listing.',
      },
      {
        key: 'llm_openai_default_model',
        label: 'OpenAI Default Model',
        description:
          'Model id pinned at credential validation when the gate completes (manifest default or first available).',
      },
    ],
  },
  {
    type: 'user-action',
    key: 'user:provide-anthropic-api-key',
    label: 'Anthropic API Key',
    description:
      'Create an Anthropic API key from the Anthropic Console and paste it here. The key is encrypted at rest and used to verify Claude model access.',
    category: 'credential-upload',
    provider: 'llm',
    verification: { type: 'credential-upload', secretKey: 'anthropic_api_key' },
    helpUrl: 'https://console.anthropic.com/settings/keys',
    dependencies: [],
    produces: [
      {
        key: 'llm_anthropic_api_key',
        label: 'Anthropic API Key',
        description: 'Encrypted Anthropic API key scoped to this project.',
      },
      {
        key: 'llm_anthropic_models_available',
        label: 'Anthropic Models Available',
        description: 'Comma-separated list of model ids returned during credential validation.',
      },
      {
        key: 'llm_anthropic_default_model_found',
        label: 'Anthropic Default Model Present',
        description: '"true" / "false" / "unchecked" — whether the manifest default appears in the listing.',
      },
      {
        key: 'llm_anthropic_default_model',
        label: 'Anthropic Default Model',
        description:
          'Model id pinned at credential validation when the gate completes (manifest default or first available).',
      },
    ],
  },
  {
    type: 'user-action',
    key: 'user:provide-gemini-api-key',
    label: 'Google Gemini API Key',
    description:
      'Generate a Gemini API key from Google AI Studio and paste it here. The key is encrypted at rest and used to verify access to the Gemini API.',
    category: 'credential-upload',
    provider: 'llm',
    verification: { type: 'credential-upload', secretKey: 'gemini_api_key' },
    helpUrl: 'https://aistudio.google.com/app/apikey',
    dependencies: [],
    produces: [
      {
        key: 'llm_gemini_api_key',
        label: 'Gemini API Key',
        description: 'Encrypted Google Gemini API key scoped to this project.',
      },
      {
        key: 'llm_gemini_models_available',
        label: 'Gemini Models Available',
        description: 'Comma-separated list of model ids returned during credential validation.',
      },
      {
        key: 'llm_gemini_default_model_found',
        label: 'Gemini Default Model Present',
        description: '"true" / "false" / "unchecked" — whether the manifest default appears in the listing.',
      },
      {
        key: 'llm_gemini_default_model',
        label: 'Gemini Default Model',
        description:
          'Model id pinned at credential validation when the gate completes (manifest default or first available).',
      },
    ],
  },
  {
    type: 'user-action',
    key: 'user:provide-custom-llm-credentials',
    label: 'Custom LLM Endpoint Credentials',
    description:
      'Provide the API key and HTTPS base URL for an OpenAI-compatible inference endpoint (Azure OpenAI, vLLM, Ollama with TLS, LM Studio, etc.).',
    category: 'credential-upload',
    provider: 'llm',
    verification: { type: 'credential-upload', secretKey: 'custom_api_key' },
    dependencies: [],
    produces: [
      {
        key: 'llm_custom_api_key',
        label: 'Custom LLM API Key',
        description: 'Encrypted API key for the custom OpenAI-compatible endpoint.',
      },
      {
        key: 'llm_custom_base_url',
        label: 'Custom LLM Base URL',
        description: 'HTTPS base URL of the custom inference endpoint (no trailing /chat/completions).',
      },
      {
        key: 'llm_custom_models_available',
        label: 'Custom Models Available',
        description: 'Comma-separated list of model ids returned during credential validation.',
      },
      {
        key: 'llm_custom_default_model_found',
        label: 'Custom Default Model Present',
        description: '"true" / "false" / "unchecked" — whether the manifest default appears in the listing.',
      },
      {
        key: 'llm_custom_default_model',
        label: 'Custom Default Model',
        description:
          'Model id pinned at credential validation when the gate completes (manifest default or first available).',
      },
    ],
  },
  {
    type: 'user-action',
    key: 'user:share-openai-integration-prompt',
    label: 'Share OpenAI Integration Prompt with Project LLM',
    description:
      'Generate and copy a project-aware OpenAI integration prompt, then apply it in your app repository with your coding LLM.',
    category: 'approval',
    provider: 'llm',
    verification: { type: 'manual-confirm' },
    dependencies: [
      { nodeKey: 'user:provide-openai-api-key', required: true },
      {
        nodeKey: 'eas:sync-llm-secrets',
        required: false,
        description:
          'If EAS module is enabled, include the synced Expo environment variable names in the handoff prompt.',
      },
    ],
    produces: [
      {
        key: 'llm_openai_integration_prompt_shared',
        label: 'OpenAI Integration Prompt Shared',
        description: 'User confirmed the OpenAI integration prompt was shared with their project coding LLM.',
      },
    ],
  },
  {
    type: 'user-action',
    key: 'user:share-anthropic-integration-prompt',
    label: 'Share Anthropic Integration Prompt with Project LLM',
    description:
      'Generate and copy a project-aware Anthropic integration prompt, then apply it in your app repository with your coding LLM.',
    category: 'approval',
    provider: 'llm',
    verification: { type: 'manual-confirm' },
    dependencies: [
      { nodeKey: 'user:provide-anthropic-api-key', required: true },
      {
        nodeKey: 'eas:sync-llm-secrets',
        required: false,
        description:
          'If EAS module is enabled, include the synced Expo environment variable names in the handoff prompt.',
      },
    ],
    produces: [
      {
        key: 'llm_anthropic_integration_prompt_shared',
        label: 'Anthropic Integration Prompt Shared',
        description: 'User confirmed the Anthropic integration prompt was shared with their project coding LLM.',
      },
    ],
  },
  {
    type: 'user-action',
    key: 'user:share-gemini-integration-prompt',
    label: 'Share Gemini Integration Prompt with Project LLM',
    description:
      'Generate and copy a project-aware Gemini integration prompt, then apply it in your app repository with your coding LLM.',
    category: 'approval',
    provider: 'llm',
    verification: { type: 'manual-confirm' },
    dependencies: [
      { nodeKey: 'user:provide-gemini-api-key', required: true },
      {
        nodeKey: 'eas:sync-llm-secrets',
        required: false,
        description:
          'If EAS module is enabled, include the synced Expo environment variable names in the handoff prompt.',
      },
    ],
    produces: [
      {
        key: 'llm_gemini_integration_prompt_shared',
        label: 'Gemini Integration Prompt Shared',
        description: 'User confirmed the Gemini integration prompt was shared with their project coding LLM.',
      },
    ],
  },
  {
    type: 'user-action',
    key: 'user:share-custom-llm-integration-prompt',
    label: 'Share Custom LLM Integration Prompt with Project LLM',
    description:
      'Generate and copy a project-aware custom-endpoint integration prompt, then apply it in your app repository with your coding LLM.',
    category: 'approval',
    provider: 'llm',
    verification: { type: 'manual-confirm' },
    dependencies: [
      { nodeKey: 'user:provide-custom-llm-credentials', required: true },
      {
        nodeKey: 'eas:sync-llm-secrets',
        required: false,
        description:
          'If EAS module is enabled, include the synced Expo environment variable names in the handoff prompt.',
      },
    ],
    produces: [
      {
        key: 'llm_custom_integration_prompt_shared',
        label: 'Custom LLM Integration Prompt Shared',
        description: 'User confirmed the custom LLM integration prompt was shared with their project coding LLM.',
      },
    ],
  },
];
