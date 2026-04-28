import {
  LlmAdapter,
  llmKindFromStepKey,
  apiKeySecretFor,
  CUSTOM_BASE_URL_SECRET_KEY,
  type LlmClient,
  type LlmCredentialVerification,
} from '../providers/llm';
import type { LlmManifestConfig, StepContext } from '../providers/types';
import { AdapterError } from '../providers/types';
import { resolveProjectLlmRuntimeEnvValues } from '../provisioning/runtime-env.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeContext(opts: { vault?: Record<string, string> } = {}): StepContext {
  const vault = { ...(opts.vault ?? {}) };
  return {
    projectId: 'p1',
    environment: 'development',
    upstreamResources: {},
    vaultRead: async (key: string) => (key in vault ? vault[key] : null),
    vaultWrite: async (key: string, value: string) => {
      vault[key] = value;
    },
  };
}

function fakeClient(verification: LlmCredentialVerification): LlmClient {
  return {
    verifyCredentials: async () => verification,
    listModels: async () => verification.modelsAvailable,
  };
}

// ---------------------------------------------------------------------------
// Step key parsing
// ---------------------------------------------------------------------------

describe('llmKindFromStepKey', () => {
  it('extracts the kind from verify step keys', () => {
    expect(llmKindFromStepKey('llm:verify-openai')).toBe('openai');
    expect(llmKindFromStepKey('llm:verify-anthropic')).toBe('anthropic');
    expect(llmKindFromStepKey('llm:verify-gemini')).toBe('gemini');
    expect(llmKindFromStepKey('llm:verify-custom')).toBe('custom');
  });

  it('returns null for legacy select-default-model keys', () => {
    expect(llmKindFromStepKey('llm:select-default-model-openai')).toBeNull();
    expect(llmKindFromStepKey('llm:select-default-model-custom')).toBeNull();
  });

  it('returns null for unrelated keys', () => {
    expect(llmKindFromStepKey('llm:verify-credentials')).toBeNull(); // legacy
    expect(llmKindFromStepKey('firebase:create-gcp-project')).toBeNull();
    expect(llmKindFromStepKey('llm:verify-unknown')).toBeNull();
  });
});

describe('apiKeySecretFor', () => {
  it('returns kind-namespaced secret slot names', () => {
    expect(apiKeySecretFor('openai')).toBe('openai_api_key');
    expect(apiKeySecretFor('anthropic')).toBe('anthropic_api_key');
    expect(apiKeySecretFor('gemini')).toBe('gemini_api_key');
    expect(apiKeySecretFor('custom')).toBe('custom_api_key');
  });
});

// ---------------------------------------------------------------------------
// validate (manifest-level checks)
// ---------------------------------------------------------------------------

describe('LlmAdapter.validate', () => {
  it('throws when kind="custom" without base_url', async () => {
    const adapter = new LlmAdapter();
    const config: LlmManifestConfig = {
      provider: 'llm',
      kind: 'custom',
      display_name: 'mine',
      default_model: 'm',
    };
    await expect(adapter.validate(config, null)).rejects.toThrow(AdapterError);
    await expect(adapter.validate(config, null)).rejects.toThrow(/must set base_url/);
  });

  it('throws when a non-custom kind sets base_url', async () => {
    const adapter = new LlmAdapter();
    const config: LlmManifestConfig = {
      provider: 'llm',
      kind: 'openai',
      display_name: 'x',
      default_model: 'gpt-4o-mini',
      base_url: 'https://api.openai.com/v1',
    };
    await expect(adapter.validate(config, null)).rejects.toThrow(/reserved for kind="custom"/);
  });

  it('returns missing_in_live drift when there is no liveState', async () => {
    const adapter = new LlmAdapter();
    const report = await adapter.validate(
      { provider: 'llm', kind: 'openai', display_name: 'x', default_model: 'gpt-4o' },
      null,
    );
    expect(report.differences).toEqual([
      { field: 'kind', manifest_value: 'openai', live_value: null, conflict_type: 'missing_in_live' },
    ]);
  });

  it('flags default_model drift', async () => {
    const adapter = new LlmAdapter();
    const liveState = {
      provider_id: 'llm',
      provider_type: 'llm',
      resource_ids: { kind: 'openai', display_name: 'x', default_model: 'gpt-3.5' },
      config_hashes: {},
      credential_metadata: {},
      partially_complete: false,
      failed_steps: [],
      completed_steps: [],
      created_at: 0,
      updated_at: 0,
    };
    const report = await adapter.validate(
      { provider: 'llm', kind: 'openai', display_name: 'x', default_model: 'gpt-4o' },
      liveState,
    );
    expect(report.differences).toEqual([
      {
        field: 'default_model',
        manifest_value: 'gpt-4o',
        live_value: 'gpt-3.5',
        conflict_type: 'value_mismatch',
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// executeStep — per-kind dispatch
// ---------------------------------------------------------------------------

describe('LlmAdapter.executeStep', () => {
  it('llm:verify-openai returns kind-scoped resources and flags default model presence', async () => {
    const adapter = new LlmAdapter(async (kind) => {
      expect(kind).toBe('openai');
      return fakeClient({
        ok: true,
        modelsAvailable: ['gpt-4o', 'gpt-4o-mini'],
        defaultModelFound: true,
      });
    });
    const config: LlmManifestConfig = {
      provider: 'llm',
      kind: 'openai',
      display_name: 'OpenAI prod',
      default_model: 'gpt-4o-mini',
    };
    const result = await adapter.executeStep('llm:verify-openai', config, makeContext());
    expect(result.status).toBe('completed');
    expect(result.resourcesProduced.llm_openai_models_available).toBe('gpt-4o,gpt-4o-mini');
    expect(result.resourcesProduced.llm_openai_default_model_found).toBe('true');
    expect(result.userPrompt).toBeUndefined();
  });

  it('llm:verify-anthropic surfaces a userPrompt when default_model is absent', async () => {
    const adapter = new LlmAdapter(async (kind) => {
      expect(kind).toBe('anthropic');
      return fakeClient({
        ok: true,
        modelsAvailable: ['claude-3-5-sonnet-20241022'],
        defaultModelFound: false,
      });
    });
    const config: LlmManifestConfig = {
      provider: 'llm',
      kind: 'anthropic',
      display_name: 'Anthropic eval',
      default_model: 'claude-bogus',
    };
    const result = await adapter.executeStep('llm:verify-anthropic', config, makeContext());
    expect(result.status).toBe('completed');
    expect(result.userPrompt).toMatch(/Update the manifest default model/);
  });

  it('throws AdapterError for obsolete select-default-model keys', async () => {
    const adapter = new LlmAdapter();
    const config: LlmManifestConfig = {
      provider: 'llm',
      kind: 'openai',
      display_name: 'x',
      default_model: 'gpt-4o',
    };
    await expect(
      adapter.executeStep('llm:select-default-model-openai', config, makeContext()),
    ).rejects.toThrow(AdapterError);
  });

  it('throws AdapterError for unknown step keys', async () => {
    const adapter = new LlmAdapter();
    const config: LlmManifestConfig = {
      provider: 'llm',
      kind: 'openai',
      display_name: 'x',
      default_model: 'm',
    };
    await expect(
      adapter.executeStep('llm:does-not-exist', config, makeContext()),
    ).rejects.toThrow(AdapterError);
  });
});

// ---------------------------------------------------------------------------
// defaultLlmClientFactory — vault key wiring per kind
// ---------------------------------------------------------------------------

describe('defaultLlmClientFactory vault wiring', () => {
  it('throws AdapterError when openai api key is missing', async () => {
    const adapter = new LlmAdapter();
    const config: LlmManifestConfig = {
      provider: 'llm',
      kind: 'openai',
      display_name: 'x',
      default_model: 'gpt-4o-mini',
    };
    await expect(
      adapter.executeStep('llm:verify-openai', config, makeContext()),
    ).rejects.toThrow(/api_key for kind="openai" is not present/);
  });

  it('throws AdapterError when custom kind has api_key but no base_url', async () => {
    const adapter = new LlmAdapter();
    const config: LlmManifestConfig = {
      provider: 'llm',
      kind: 'custom',
      display_name: 'self-hosted',
      default_model: 'qwen2.5-7b',
      base_url: 'https://llm.internal.example/v1',
    };
    const ctx = makeContext({ vault: { [apiKeySecretFor('custom')]: 'sk-xxx' } });
    await expect(
      adapter.executeStep('llm:verify-custom', config, ctx),
    ).rejects.toThrow(new RegExp(`requires base_url in the project vault under "${CUSTOM_BASE_URL_SECRET_KEY}"`));
  });
});

// ---------------------------------------------------------------------------
// checkStep — propagates client errors as failed (not thrown)
// ---------------------------------------------------------------------------

describe('LlmAdapter.checkStep', () => {
  it('returns status=failed with the underlying error message when verification throws', async () => {
    const adapter = new LlmAdapter(async () => ({
      verifyCredentials: async () => {
        throw new Error('401 Unauthorized: invalid key');
      },
      listModels: async () => [],
    }));
    const config: LlmManifestConfig = {
      provider: 'llm',
      kind: 'openai',
      display_name: 'x',
      default_model: 'gpt-4o-mini',
    };
    const result = await adapter.checkStep('llm:verify-openai', config, makeContext());
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/401 Unauthorized/);
  });
});

// ---------------------------------------------------------------------------
// Plugin / registry integration smoke test
// ---------------------------------------------------------------------------

describe('plugin registry integration', () => {
  it('exposes all four LLM kinds as separately selectable modules', async () => {
    const { registerBuiltinPlugins } = await import('../plugins/builtin/index.js');
    const { globalPluginRegistry } = await import('../plugins/plugin-registry.js');
    registerBuiltinPlugins();

    expect(globalPluginRegistry.getProviders()).toContain('llm');

    const llmPlugins = globalPluginRegistry.getPluginsForProvider('llm');
    const ids = llmPlugins.map((p) => p.id).sort();
    expect(ids).toEqual(['llm-anthropic', 'llm-custom', 'llm-gemini', 'llm-openai']);

    // Provider metadata is contributed by llm-openai (registered first).
    const meta = globalPluginRegistry.getProviderMetadata('llm');
    expect(meta?.secretKeys).toEqual([
      'openai_api_key',
      'openai_organization_id',
      'anthropic_api_key',
      'gemini_api_key',
      'custom_api_key',
      'custom_base_url',
    ]);

    // Each kind module contributes only credential user actions (no separate steps).
    expect(globalPluginRegistry.getStepsForProvider('llm').map((s) => s.key).sort()).toEqual([]);
  });
});

describe('module-scoped LLM planning', () => {
  it('includes only the selected llm-* module nodes', async () => {
    const { registerBuiltinPlugins } = await import('../plugins/builtin/index.js');
    const { buildProvisioningPlanForModules } = await import('../provisioning/step-registry.js');
    registerBuiltinPlugins();

    const plan = buildProvisioningPlanForModules(
      'p1',
      ['llm-anthropic'],
      ['development'],
      [],
    );
    const nodeKeys = plan.nodes.map((n) => n.key);

    expect(nodeKeys).toContain('user:provide-anthropic-api-key');
    expect(nodeKeys).not.toContain('llm:select-default-model-anthropic');

    expect(nodeKeys).not.toContain('user:provide-openai-api-key');
    expect(nodeKeys).not.toContain('user:provide-gemini-api-key');
    expect(nodeKeys).not.toContain('user:provide-custom-llm-credentials');
  });

  it('does not pull other LLM kinds in via optional eas:sync-llm-secrets edges', async () => {
    const { registerBuiltinPlugins } = await import('../plugins/builtin/index.js');
    const { buildProvisioningPlanForModules } = await import('../provisioning/step-registry.js');
    registerBuiltinPlugins();

    const plan = buildProvisioningPlanForModules(
      'p1',
      ['github-repo', 'eas-builds', 'llm-openai'],
      ['development'],
      [],
    );
    const nodeKeys = plan.nodes.map((n) => n.key);

    expect(nodeKeys).toContain('eas:sync-llm-secrets');
    expect(nodeKeys).toContain('user:provide-openai-api-key');

    expect(nodeKeys).not.toContain('user:provide-anthropic-api-key');
    expect(nodeKeys).not.toContain('llm:select-default-model-anthropic');
    expect(nodeKeys).not.toContain('user:provide-gemini-api-key');
    expect(nodeKeys).not.toContain('user:provide-custom-llm-credentials');
  });
});

describe('resolveProjectLlmRuntimeEnvValues (selected modules)', () => {
  it('only fills EAS slots for chosen llm-* modules and clears siblings', () => {
    const r = resolveProjectLlmRuntimeEnvValues({
      upstream: {
        llm_openai_default_model: 'gpt-4o-mini',
        llm_gemini_default_model: 'gemini-pro',
      },
      selectedLlmModuleIds: ['llm-openai'],
      readVault: (_p, key) => {
        if (key === 'openai_api_key') return 'sk-openai';
        if (key === 'gemini_api_key') return 'sk-gemini';
        return undefined;
      },
    });
    expect(r.values.LLM_OPENAI_API_KEY.trim().length > 0).toBe(true);
    expect(r.values.LLM_OPENAI_DEFAULT_MODEL).toBe('gpt-4o-mini');
    expect(r.values.LLM_GEMINI_API_KEY).toBe('');
    expect(r.values.LLM_GEMINI_DEFAULT_MODEL).toBe('');
  });

  it('uses SQLite credential when vault slot is empty', () => {
    const r = resolveProjectLlmRuntimeEnvValues({
      upstream: { llm_anthropic_default_model: 'claude-sonnet-4' },
      selectedLlmModuleIds: ['llm-anthropic'],
      readVault: () => undefined,
      retrieveProjectCredential: (type) => (type === 'llm_anthropic_api_key' ? 'sk-ant-from-sqlite' : null),
    });
    expect(r.values.LLM_ANTHROPIC_API_KEY).toBe('sk-ant-from-sqlite');
    expect(r.values.LLM_ANTHROPIC_DEFAULT_MODEL).toBe('claude-sonnet-4');
  });
});

// ---------------------------------------------------------------------------
// SecretValidator — per-kind secret slots under provider 'llm'
// ---------------------------------------------------------------------------

describe('SecretValidator for llm', () => {
  it('accepts every per-kind secret slot under provider "llm"', async () => {
    const { SecretValidator } = await import('../secrets/store.js');
    expect(() => SecretValidator.validate('llm', 'openai_api_key', 'sk-abcdef')).not.toThrow();
    expect(() => SecretValidator.validate('llm', 'anthropic_api_key', 'sk-ant-x')).not.toThrow();
    expect(() => SecretValidator.validate('llm', 'gemini_api_key', 'gemini-key')).not.toThrow();
    expect(() => SecretValidator.validate('llm', 'custom_api_key', 'sk-custom')).not.toThrow();
    expect(() => SecretValidator.validate('llm', 'custom_base_url', 'https://x.example/v1')).not.toThrow();
    expect(() =>
      SecretValidator.validate('llm', 'openai_organization_id', 'org-123'),
    ).not.toThrow();
  });

  it('rejects the legacy generic "api_key" slot now that secrets are per-kind', async () => {
    const { SecretValidator } = await import('../secrets/store.js');
    expect(() => SecretValidator.validate('llm', 'api_key', 'v')).toThrow(/Invalid secret name/);
  });

  it('rejects unknown secret names', async () => {
    const { SecretValidator } = await import('../secrets/store.js');
    expect(() => SecretValidator.validate('llm', 'not_a_real_key', 'v')).toThrow();
  });
});
