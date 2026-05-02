import type { ProvisioningStepNode } from '../graph.types.js';

/**
 * The LLM module ships as 4 sibling plugins — one per kind (openai,
 * anthropic, gemini, custom). There are no separate automation steps: the
 * default model id is pinned when the credential upload gate submits (same
 * list-models verification that encrypts and stores the key).
 */

type LlmKindMeta = {
  kind: 'openai' | 'anthropic' | 'gemini' | 'custom';
  label: string;
  userActionKey: string;
};

const LLM_KIND_META: LlmKindMeta[] = [
  {
    kind: 'openai',
    label: 'OpenAI',
    userActionKey: 'user:provide-openai-api-key',
  },
  {
    kind: 'anthropic',
    label: 'Anthropic Claude',
    userActionKey: 'user:provide-anthropic-api-key',
  },
  {
    kind: 'gemini',
    label: 'Google Gemini',
    userActionKey: 'user:provide-gemini-api-key',
  },
  {
    kind: 'custom',
    label: 'Custom OpenAI-Compatible',
    userActionKey: 'user:provide-custom-llm-credentials',
  },
];

function makeLlmTeardownStepsForKind(meta: LlmKindMeta): ProvisioningStepNode[] {
  return [
    {
      type: 'step',
      key: `llm:revoke-${meta.kind}-credentials`,
      label: `Revoke ${meta.label} Credentials`,
      description: `Manually revoke the API key in the ${meta.label} console and remove the encrypted credential from the project vault. Studio cannot revoke remote keys on your behalf.`,
      provider: 'llm',
      environmentScope: 'global',
      automationLevel: 'manual',
      direction: 'teardown',
      teardownOf: meta.userActionKey,
      dependencies: [],
      produces: [],
    },
  ];
}

/** Each LLM kind plugin exposes only user-action + teardown flows (no provisioning steps). */
export const LLM_OPENAI_STEPS: ProvisioningStepNode[] = [];
export const LLM_ANTHROPIC_STEPS: ProvisioningStepNode[] = [];
export const LLM_GEMINI_STEPS: ProvisioningStepNode[] = [];
export const LLM_CUSTOM_STEPS: ProvisioningStepNode[] = [];

/** All LLM steps from every kind — empty; used for static catalog assembly. */
export const LLM_STEPS: ProvisioningStepNode[] = [
  ...LLM_OPENAI_STEPS,
  ...LLM_ANTHROPIC_STEPS,
  ...LLM_GEMINI_STEPS,
  ...LLM_CUSTOM_STEPS,
];

export const LLM_OPENAI_TEARDOWN_STEPS = makeLlmTeardownStepsForKind(LLM_KIND_META[0]);
export const LLM_ANTHROPIC_TEARDOWN_STEPS = makeLlmTeardownStepsForKind(LLM_KIND_META[1]);
export const LLM_GEMINI_TEARDOWN_STEPS = makeLlmTeardownStepsForKind(LLM_KIND_META[2]);
export const LLM_CUSTOM_TEARDOWN_STEPS = makeLlmTeardownStepsForKind(LLM_KIND_META[3]);

export const LLM_TEARDOWN_STEPS: ProvisioningStepNode[] = [
  ...LLM_OPENAI_TEARDOWN_STEPS,
  ...LLM_ANTHROPIC_TEARDOWN_STEPS,
  ...LLM_GEMINI_TEARDOWN_STEPS,
  ...LLM_CUSTOM_TEARDOWN_STEPS,
];
