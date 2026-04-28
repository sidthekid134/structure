import type { PluginDefinition } from '../plugin-types.js';
import {
  LLM_CUSTOM_STEPS,
  LLM_CUSTOM_TEARDOWN_STEPS,
  USER_ACTIONS,
} from '../../provisioning/step-registry.js';

/**
 * Custom OpenAI-compatible LLM module. Sibling of `llm-openai`,
 * `llm-anthropic`, `llm-gemini`. Shares the `'llm'` provider type and the
 * `LlmAdapter` registered by `llm-openai`. Contributes only the custom
 * Contributes only the credential user action (`user:provide-custom-llm-credentials`).
 * action (which carries both the API key and the HTTPS base URL).
 */
export const llmCustomPlugin: PluginDefinition = {
  id: 'llm-custom',
  version: '1.0.0',
  label: 'Custom OpenAI-Compatible',
  description:
    'Connect a self-hosted OpenAI-compatible inference endpoint (Azure OpenAI, vLLM, Ollama with TLS, LM Studio, …). Stores the API key + HTTPS base URL encrypted in the project vault.',
  provider: 'llm',
  requiredModules: [],
  optionalModules: [],
  includedInTemplates: [],
  steps: LLM_CUSTOM_STEPS,
  teardownSteps: LLM_CUSTOM_TEARDOWN_STEPS,
  userActions: [USER_ACTIONS.find((a) => a.key === 'user:provide-custom-llm-credentials')!],
  displayMeta: {
    icon: 'Server',
    colors: {
      primary: 'slate-500',
      text: 'text-slate-700 dark:text-slate-300',
      bg: 'bg-slate-500/10',
      border: 'border-slate-500/25',
    },
  },
  defaultJourneyPhase: 'credentials',
  resourceDisplay: {
    llm_custom_api_key: { sensitive: true },
    llm_custom_base_url: { primaryLinkFromValue: true },
    llm_custom_models_available: {
      previewText:
        'Populated when custom endpoint credentials are validated during the credential upload gate.',
    },
    llm_custom_default_model: {
      previewTemplate:
        'Default model id served by the custom endpoint when callers do not specify one.',
    },
  },
  functionGroup: {
    id: 'ai',
    label: 'AI & LLMs',
    description: 'Model providers and inference endpoints',
    order: 6,
  },
};
