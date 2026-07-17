import type { PluginDefinition } from '../plugin-types.js';
import {
  LLM_OPENROUTER_STEPS,
  LLM_OPENROUTER_TEARDOWN_STEPS,
  USER_ACTIONS,
} from '../../provisioning/step-registry.js';

/**
 * OpenRouter LLM module. Sibling of `llm-openai`, `llm-anthropic`,
 * `llm-gemini`, `llm-custom`. Shares the `'llm'` provider type and the
 * `LlmAdapter` registered by `llm-openai`. Contributes only the OpenRouter
 * API key credential gate. OpenRouter exposes an OpenAI-compatible endpoint
 * at https://openrouter.ai/api/v1 with Bearer auth — no base_url needed.
 */
export const llmOpenRouterPlugin: PluginDefinition = {
  id: 'llm-openrouter',
  version: '1.0.0',
  label: 'OpenRouter',
  description:
    'Connect an OpenRouter API key. Stores it encrypted in the project vault and verifies model access by listing available models via the OpenRouter API.',
  integrationId: 'llm',
  provider: 'llm',
  requiredModules: [],
  optionalModules: [],
  includedInTemplates: [],
  steps: LLM_OPENROUTER_STEPS,
  teardownSteps: LLM_OPENROUTER_TEARDOWN_STEPS,
  userActions: USER_ACTIONS.filter(
    (a) =>
      a.key === 'user:provide-openrouter-api-key' ||
      a.key === 'user:share-openrouter-integration-prompt',
  ),
  displayMeta: {
    icon: 'Route',
    colors: {
      primary: 'violet-500',
      text: 'text-violet-700 dark:text-violet-300',
      bg: 'bg-violet-500/10',
      border: 'border-violet-500/25',
    },
  },
  defaultJourneyPhase: 'credentials',
  resourceDisplay: {
    llm_openrouter_api_key: { sensitive: true },
    llm_openrouter_models_available: {
      previewText:
        'Populated when the OpenRouter API key is validated during the credential upload gate.',
    },
  },
  completionPortalLinks: {
    'user:provide-openrouter-api-key': [
      { label: 'OpenRouter API keys', href: 'https://openrouter.ai/keys' },
      { label: 'OpenRouter model list', href: 'https://openrouter.ai/models' },
    ],
  },
  functionGroup: {
    id: 'ai',
    label: 'AI & LLMs',
    description: 'Model providers and inference endpoints',
    order: 6,
  },
};
