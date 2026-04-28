import type { PluginDefinition } from '../plugin-types.js';
import {
  LLM_OPENAI_STEPS,
  LLM_OPENAI_TEARDOWN_STEPS,
  USER_ACTIONS,
} from '../../provisioning/step-registry.js';
import { LlmAdapter } from '../../providers/llm.js';
import type { ProviderAdapter, ProviderConfig } from '../../providers/types.js';

/**
 * OpenAI LLM module. One of four sibling LLM plugins (alongside
 * `llm-anthropic`, `llm-gemini`, `llm-custom`). All four share the single
 * `'llm'` provider type and `LlmAdapter`, which dispatches per-kind based
 * on the step key.
 *
 * This plugin owns the providerMeta + adapter for the `'llm'` provider —
 * the other three siblings only contribute their per-kind user actions.
 * lands first so the registry picks up its provider metadata.
 */
export const llmOpenAIPlugin: PluginDefinition = {
  id: 'llm-openai',
  version: '1.0.0',
  label: 'OpenAI',
  description:
    'Connect an OpenAI API key. Stores it encrypted in the project vault and verifies model access by listing available models.',
  provider: 'llm',
  providerMeta: {
    label: 'LLM',
    scope: 'project',
    secretKeys: [
      'openai_api_key',
      'openai_organization_id',
      'anthropic_api_key',
      'gemini_api_key',
      'custom_api_key',
      'custom_base_url',
    ],
    dependsOnProviders: [],
    displayMeta: {
      label: 'LLM',
      color: 'text-emerald-600',
      bg: 'bg-emerald-500/10',
      border: 'border-emerald-500/30',
    },
  },
  requiredModules: [],
  optionalModules: [],
  // Opt-in module — operators add it deliberately when they want this kind.
  includedInTemplates: [],
  steps: LLM_OPENAI_STEPS,
  teardownSteps: LLM_OPENAI_TEARDOWN_STEPS,
  userActions: [USER_ACTIONS.find((a) => a.key === 'user:provide-openai-api-key')!],
  adapter: new LlmAdapter() as ProviderAdapter<ProviderConfig>,
  displayMeta: {
    icon: 'Sparkles',
    colors: {
      primary: 'emerald-500',
      text: 'text-emerald-700 dark:text-emerald-300',
      bg: 'bg-emerald-500/10',
      border: 'border-emerald-500/25',
    },
  },
  defaultJourneyPhase: 'credentials',
  resourceDisplay: {
    llm_openai_api_key: { sensitive: true },
    llm_openai_models_available: {
      previewText:
        'Populated when the OpenAI API key is validated during the credential upload gate.',
    },
    llm_openai_default_model: {
      previewTemplate:
        'Default OpenAI model id used when callers do not specify one (e.g. gpt-4o-mini).',
    },
  },
  completionPortalLinks: {
    'user:provide-openai-api-key': [
      { label: 'OpenAI API keys', href: 'https://platform.openai.com/api-keys' },
      { label: 'OpenAI usage dashboard', href: 'https://platform.openai.com/usage' },
    ],
  },
  functionGroup: {
    id: 'ai',
    label: 'AI & LLMs',
    description: 'Model providers and inference endpoints',
    order: 6,
  },
};
