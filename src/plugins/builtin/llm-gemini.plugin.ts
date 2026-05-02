import type { PluginDefinition } from '../plugin-types.js';
import {
  LLM_GEMINI_STEPS,
  LLM_GEMINI_TEARDOWN_STEPS,
  USER_ACTIONS,
} from '../../provisioning/step-registry.js';

/**
 * Google Gemini LLM module. Sibling of `llm-openai`, `llm-anthropic`,
 * `llm-custom`. Shares the `'llm'` provider type and the `LlmAdapter`
 * registered by `llm-openai`. Contributes only the Gemini-specific
 * Contributes only the Gemini credential user action (`user:provide-gemini-api-key`).
 */
export const llmGeminiPlugin: PluginDefinition = {
  id: 'llm-gemini',
  version: '1.0.0',
  label: 'Google Gemini',
  description:
    'Connect a Google AI Studio API key. Stores it encrypted in the project vault and verifies Gemini model access by listing available models.',
  integrationId: 'llm',
  provider: 'llm',
  requiredModules: [],
  optionalModules: [],
  includedInTemplates: [],
  steps: LLM_GEMINI_STEPS,
  teardownSteps: LLM_GEMINI_TEARDOWN_STEPS,
  userActions: USER_ACTIONS.filter(
    (a) =>
      a.key === 'user:provide-gemini-api-key' ||
      a.key === 'user:share-gemini-integration-prompt',
  ),
  displayMeta: {
    icon: 'Stars',
    colors: {
      primary: 'sky-500',
      text: 'text-sky-700 dark:text-sky-300',
      bg: 'bg-sky-500/10',
      border: 'border-sky-500/25',
    },
  },
  defaultJourneyPhase: 'credentials',
  resourceDisplay: {
    llm_gemini_api_key: { sensitive: true },
    llm_gemini_models_available: {
      previewText:
        'Populated when the Gemini API key is validated during the credential upload gate.',
    },
    llm_gemini_default_model: {
      previewTemplate:
        'Default Gemini model id used when callers do not specify one (e.g. gemini-1.5-pro-latest).',
    },
  },
  completionPortalLinks: {
    'user:provide-gemini-api-key': [
      { label: 'Google AI Studio — API keys', href: 'https://aistudio.google.com/app/apikey' },
    ],
  },
  functionGroup: {
    id: 'ai',
    label: 'AI & LLMs',
    description: 'Model providers and inference endpoints',
    order: 6,
  },
};
