import type { PluginDefinition } from '../plugin-types.js';
import {
  LLM_ANTHROPIC_STEPS,
  LLM_ANTHROPIC_TEARDOWN_STEPS,
  USER_ACTIONS,
} from '../../provisioning/step-registry.js';

/**
 * Anthropic Claude LLM module. Sibling of `llm-openai`, `llm-gemini`,
 * `llm-custom`. Shares the `'llm'` provider type and the `LlmAdapter`
 * registered by `llm-openai`. Contributes only the Anthropic API key credential gate.
 */
export const llmAnthropicPlugin: PluginDefinition = {
  id: 'llm-anthropic',
  version: '1.0.0',
  label: 'Anthropic Claude',
  description:
    'Connect an Anthropic API key. Stores it encrypted in the project vault and verifies Claude model access by listing available models.',
  provider: 'llm',
  requiredModules: [],
  optionalModules: [],
  includedInTemplates: [],
  steps: LLM_ANTHROPIC_STEPS,
  teardownSteps: LLM_ANTHROPIC_TEARDOWN_STEPS,
  userActions: [USER_ACTIONS.find((a) => a.key === 'user:provide-anthropic-api-key')!],
  displayMeta: {
    icon: 'BrainCircuit',
    colors: {
      primary: 'orange-500',
      text: 'text-orange-700 dark:text-orange-300',
      bg: 'bg-orange-500/10',
      border: 'border-orange-500/25',
    },
  },
  defaultJourneyPhase: 'credentials',
  resourceDisplay: {
    llm_anthropic_api_key: { sensitive: true },
    llm_anthropic_models_available: {
      previewText:
        'Populated when the Anthropic API key is validated during the credential upload gate.',
    },
    llm_anthropic_default_model: {
      previewTemplate:
        'Default Anthropic model id used when callers do not specify one (e.g. claude-3-5-sonnet-20241022).',
    },
  },
  completionPortalLinks: {
    'user:provide-anthropic-api-key': [
      { label: 'Anthropic Console — keys', href: 'https://console.anthropic.com/settings/keys' },
      { label: 'Anthropic usage', href: 'https://console.anthropic.com/settings/usage' },
    ],
  },
  functionGroup: {
    id: 'ai',
    label: 'AI & LLMs',
    description: 'Model providers and inference endpoints',
    order: 6,
  },
};
