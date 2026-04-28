/**
 * LLM provider adapter — credentials + verification for OpenAI, Anthropic
 * Claude, Google Gemini, and operator-hosted OpenAI-compatible endpoints.
 *
 * V1 scope (intentionally narrow):
 *   - Verify the API key by listing models (single round trip).
 *   - Resolve the configured default model exists (or surface what's available).
 *   - Persist the credential metadata into ProviderState so downstream apps
 *     can pull the per-kind api_key (and optional base_url / organization_id)
 *     via the standard credential-retrieval service.
 *
 * Out of scope for V1:
 *   - Inference (chat/completion). Apps consume the stored API key directly.
 *   - Token / cost accounting. There is no shared inference funnel yet.
 *
 * Multiple LLM kinds per project:
 *   The plugin layer ships four sibling plugins (`llm-openai`, `llm-anthropic`,
 *   `llm-gemini`, `llm-custom`) that all map to the single `'llm'` provider
 *   type and share this adapter. Each plugin contributes its own per-kind
 *   step keys (`llm:verify-openai`, …) and
 *   user action that writes to a kind-specific secret slot
 *   (`openai_api_key`, `anthropic_api_key`, …). The adapter dispatches on the
 *   step key to pick the kind, so the manifest only needs to be a stub.
 */

import * as crypto from 'crypto';
import {
  ProviderAdapter,
  LlmManifestConfig,
  LlmKind,
  ProviderState,
  DriftReport,
  DriftDifference,
  ReconcileDirection,
  AdapterError,
  StepContext,
  StepResult,
} from './types.js';
import { createOperationLogger } from '../logger.js';
import type { LoggingCallback } from '../types.js';

// ---------------------------------------------------------------------------
// Public API surface — what callers can rely on across kinds
// ---------------------------------------------------------------------------

export interface LlmCredentialVerification {
  /** Reachability + authorisation succeeded. */
  ok: true;
  /** Model ids returned by the backend (deduped, lower-cased where relevant). */
  modelsAvailable: string[];
  /**
   * Whether `default_model` (when supplied) was present in `modelsAvailable`.
   * `null` when `default_model` was empty.
   */
  defaultModelFound: boolean | null;
}

export interface LlmClient {
  /** Calls a cheap "list models" endpoint to confirm the API key works. */
  verifyCredentials(opts?: { defaultModel?: string }): Promise<LlmCredentialVerification>;
  /** Returns the raw model id list from the backend. */
  listModels(): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Per-kind secret + step naming
// ---------------------------------------------------------------------------

/** Per-kind canonical secret slot for the API key. */
export function apiKeySecretFor(kind: LlmKind): string {
  return `${kind}_api_key`;
}

/** Per-kind canonical secret slot for an OpenAI org id (only used when kind === 'openai'). */
export const OPENAI_ORG_SECRET_KEY = 'openai_organization_id';

/** Per-kind canonical secret slot for the custom endpoint base URL (only used when kind === 'custom'). */
export const CUSTOM_BASE_URL_SECRET_KEY = 'custom_base_url';

/** Returns the kind a step key targets, or null when the key is not a per-kind LLM verify step. */
export function llmKindFromStepKey(stepKey: string): LlmKind | null {
  const match = stepKey.match(/^llm:verify-(openai|anthropic|gemini|custom)$/);
  return match ? (match[1] as LlmKind) : null;
}

// ---------------------------------------------------------------------------
// Shared HTTP plumbing
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 15_000;

const PUBLIC_LLM_HOSTS = new Set<string>([
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
]);

/**
 * Lightweight wrapper around `fetch()` that:
 *   - Enforces a per-request timeout via AbortController
 *   - Reads the body as text so we can include a snippet in error messages
 *     without buffering large payloads in callers
 *   - Surfaces non-2xx responses as thrown `Error`s with the status + snippet
 *
 * No retry / backoff. Verification calls are user-initiated and one-shot;
 * inference is not in V1.
 */
async function httpJson<T>(
  url: string,
  init: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: unknown; timeoutMs?: number; expectJson?: boolean },
): Promise<T> {
  const controller = new AbortController();
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method ?? 'GET',
      headers: { Accept: 'application/json', ...(init.headers ?? {}) },
      ...(init.body !== undefined
        ? { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) }
        : {}),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if ((err as Error).name === 'AbortError') {
      throw new Error(`LLM request to ${redactUrl(url)} timed out after ${timeoutMs}ms`);
    }
    throw new Error(`LLM request to ${redactUrl(url)} failed: ${(err as Error).message}`);
  }
  clearTimeout(timeout);

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(
      `LLM request to ${redactUrl(url)} failed (${response.status}): ${raw.slice(0, 500)}`,
    );
  }
  if (init.expectJson === false) {
    return raw as unknown as T;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `LLM response from ${redactUrl(url)} was not valid JSON. Body snippet: ${raw.slice(0, 200)}`,
    );
  }
}

/** Strips query-string secrets (like Gemini's `?key=`) from URLs we surface in errors. */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has('key')) {
      parsed.searchParams.set('key', '[REDACTED]');
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function dedupeModels(ids: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!id) continue;
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// OpenAI client
// ---------------------------------------------------------------------------

export class OpenAIClient implements LlmClient {
  constructor(
    private readonly apiKey: string,
    private readonly options: { organizationId?: string; baseUrl?: string; timeoutMs?: number } = {},
  ) {
    if (!apiKey.trim()) {
      throw new Error('OpenAI API key is required.');
    }
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { Authorization: `Bearer ${this.apiKey}` };
    if (this.options.organizationId?.trim()) {
      h['OpenAI-Organization'] = this.options.organizationId.trim();
    }
    return h;
  }

  async listModels(): Promise<string[]> {
    const base = this.options.baseUrl ?? 'https://api.openai.com/v1';
    const data = await httpJson<{ data: Array<{ id: string }> }>(`${base}/models`, {
      headers: this.headers(),
      timeoutMs: this.options.timeoutMs,
    });
    return dedupeModels((data.data ?? []).map((m) => m.id));
  }

  async verifyCredentials(opts: { defaultModel?: string } = {}): Promise<LlmCredentialVerification> {
    const models = await this.listModels();
    return {
      ok: true,
      modelsAvailable: models,
      defaultModelFound: opts.defaultModel ? models.includes(opts.defaultModel) : null,
    };
  }
}

// ---------------------------------------------------------------------------
// Anthropic client
// ---------------------------------------------------------------------------

export class AnthropicClient implements LlmClient {
  /**
   * Pinned to a stable Messages API version. Bump deliberately when the
   * Anthropic team publishes a new GA version (their REST contract is
   * versioned via this header rather than the URL path).
   */
  static readonly API_VERSION = '2023-06-01';

  constructor(
    private readonly apiKey: string,
    private readonly options: { baseUrl?: string; timeoutMs?: number } = {},
  ) {
    if (!apiKey.trim()) {
      throw new Error('Anthropic API key is required.');
    }
  }

  private headers(): Record<string, string> {
    return {
      'x-api-key': this.apiKey,
      'anthropic-version': AnthropicClient.API_VERSION,
    };
  }

  async listModels(): Promise<string[]> {
    const base = this.options.baseUrl ?? 'https://api.anthropic.com/v1';
    const data = await httpJson<{ data: Array<{ id: string }> }>(`${base}/models`, {
      headers: this.headers(),
      timeoutMs: this.options.timeoutMs,
    });
    return dedupeModels((data.data ?? []).map((m) => m.id));
  }

  async verifyCredentials(opts: { defaultModel?: string } = {}): Promise<LlmCredentialVerification> {
    const models = await this.listModels();
    return {
      ok: true,
      modelsAvailable: models,
      defaultModelFound: opts.defaultModel ? models.includes(opts.defaultModel) : null,
    };
  }
}

// ---------------------------------------------------------------------------
// Google Gemini client
// ---------------------------------------------------------------------------

export class GeminiClient implements LlmClient {
  constructor(
    private readonly apiKey: string,
    private readonly options: { baseUrl?: string; timeoutMs?: number } = {},
  ) {
    if (!apiKey.trim()) {
      throw new Error('Gemini API key is required.');
    }
  }

  async listModels(): Promise<string[]> {
    const base = this.options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
    const data = await httpJson<{ models: Array<{ name: string }> }>(
      `${base}/models?key=${encodeURIComponent(this.apiKey)}`,
      { timeoutMs: this.options.timeoutMs },
    );
    // Gemini returns "models/<id>" — strip the prefix so callers get the
    // raw model id they would pass back into generateContent.
    return dedupeModels(
      (data.models ?? []).map((m) => (m.name ?? '').replace(/^models\//, '')),
    );
  }

  async verifyCredentials(opts: { defaultModel?: string } = {}): Promise<LlmCredentialVerification> {
    const models = await this.listModels();
    return {
      ok: true,
      modelsAvailable: models,
      defaultModelFound: opts.defaultModel ? models.includes(opts.defaultModel) : null,
    };
  }
}

// ---------------------------------------------------------------------------
// Custom OpenAI-compatible client (Azure OpenAI, vLLM, Ollama, LM Studio, ...)
// ---------------------------------------------------------------------------

export class CustomOpenAICompatClient implements LlmClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly options: { timeoutMs?: number } = {},
  ) {
    if (!apiKey.trim()) {
      throw new Error('Custom LLM API key is required.');
    }
    if (!baseUrl.trim()) {
      throw new Error('Custom LLM base_url is required.');
    }
    assertCustomBaseUrl(baseUrl);
  }

  async listModels(): Promise<string[]> {
    const data = await httpJson<{ data?: Array<{ id: string }> }>(
      `${trimTrailingSlash(this.baseUrl)}/models`,
      {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        timeoutMs: this.options.timeoutMs,
      },
    );
    return dedupeModels((data.data ?? []).map((m) => m.id));
  }

  async verifyCredentials(opts: { defaultModel?: string } = {}): Promise<LlmCredentialVerification> {
    const models = await this.listModels();
    return {
      ok: true,
      modelsAvailable: models,
      defaultModelFound: opts.defaultModel ? models.includes(opts.defaultModel) : null,
    };
  }
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Custom endpoints must be HTTPS and explicitly NOT one of the public
 * provider hosts — those have first-class clients with proper auth headers
 * (e.g. Anthropic's `x-api-key` / `anthropic-version`) that the OpenAI-style
 * `Authorization: Bearer` shape would silently mis-call.
 */
export function assertCustomBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`Custom LLM base_url is not a valid URL: ${baseUrl}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Custom LLM base_url must use https:// (got ${parsed.protocol}).`);
  }
  const host = parsed.hostname.toLowerCase();
  if (PUBLIC_LLM_HOSTS.has(host)) {
    throw new Error(
      `Custom LLM base_url "${baseUrl}" points at a public provider host (${host}). ` +
        `Use kind="${publicHostToKind(host)}" instead so the correct auth headers are sent.`,
    );
  }
}

function publicHostToKind(host: string): LlmKind {
  if (host === 'api.openai.com') return 'openai';
  if (host === 'api.anthropic.com') return 'anthropic';
  if (host === 'generativelanguage.googleapis.com') return 'gemini';
  return 'custom';
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

/**
 * Builds the right `LlmClient` for a given kind + secrets bundle. The kind
 * comes from the step key being executed (one of the 4 sibling plugins);
 * the secrets are read out of the project vault under canonical, kind-specific
 * slot names by `defaultLlmClientFactory`.
 */
export function createLlmClient(
  kind: LlmKind,
  apiKey: string,
  opts: { baseUrl?: string; organizationId?: string; timeoutMs?: number } = {},
): LlmClient {
  const timeoutMs = opts.timeoutMs;
  switch (kind) {
    case 'openai':
      return new OpenAIClient(apiKey, {
        organizationId: opts.organizationId,
        timeoutMs,
      });
    case 'anthropic':
      return new AnthropicClient(apiKey, { timeoutMs });
    case 'gemini':
      return new GeminiClient(apiKey, { timeoutMs });
    case 'custom': {
      if (!opts.baseUrl) {
        throw new Error(
          `LLM kind="custom" requires base_url to be set in the project vault under "${CUSTOM_BASE_URL_SECRET_KEY}".`,
        );
      }
      return new CustomOpenAICompatClient(apiKey, opts.baseUrl, { timeoutMs });
    }
  }
}

// ---------------------------------------------------------------------------
// LlmAdapter
// ---------------------------------------------------------------------------

/**
 * Resolves an LlmClient at execute-time from the project vault. The adapter
 * doesn't bind to a single client at construction time so a single
 * registered adapter can serve every per-kind LLM step.
 */
export type LlmClientFactory = (
  kind: LlmKind,
  context: StepContext,
) => Promise<LlmClient>;

/**
 * Default factory: pulls the api key (and optional base_url / org id) from
 * the StepContext vault under canonical kind-specific slot names. The vault
 * is project-scoped, so each kind maps to a single slot per project:
 *   - openai    → llm/openai_api_key,    llm/openai_organization_id
 *   - anthropic → llm/anthropic_api_key
 *   - gemini    → llm/gemini_api_key
 *   - custom    → llm/custom_api_key,    llm/custom_base_url
 */
export const defaultLlmClientFactory: LlmClientFactory = async (kind, context) => {
  const apiKey = await context.vaultRead(apiKeySecretFor(kind));
  if (!apiKey) {
    throw new AdapterError(
      `LLM api_key for kind="${kind}" is not present in the project vault. ` +
        `Provide it via the "${kindLabel(kind)}" credential gate.`,
      'llm',
      'defaultLlmClientFactory',
    );
  }
  const opts: { baseUrl?: string; organizationId?: string } = {};
  if (kind === 'openai') {
    const org = await context.vaultRead(OPENAI_ORG_SECRET_KEY);
    if (org) opts.organizationId = org;
  }
  if (kind === 'custom') {
    const baseUrl = await context.vaultRead(CUSTOM_BASE_URL_SECRET_KEY);
    if (!baseUrl) {
      throw new AdapterError(
        `LLM kind="custom" requires base_url in the project vault under "${CUSTOM_BASE_URL_SECRET_KEY}".`,
        'llm',
        'defaultLlmClientFactory',
      );
    }
    opts.baseUrl = baseUrl;
  }
  return createLlmClient(kind, apiKey, opts);
};

export function kindLabel(kind: LlmKind): string {
  switch (kind) {
    case 'openai': return 'OpenAI';
    case 'anthropic': return 'Anthropic Claude';
    case 'gemini': return 'Google Gemini';
    case 'custom': return 'Custom LLM';
  }
}

/**
 * `LlmManifestConfig` is mostly informational once we split into per-kind
 * plugins. The adapter ignores `manifest.kind` for step execution — the
 * step key carries the authoritative kind — but `manifest.default_model`
 * is still consulted as a fallback when an operator hasn't picked a default.
 */
export class LlmAdapter implements ProviderAdapter<LlmManifestConfig> {
  private readonly log: ReturnType<typeof createOperationLogger>;

  constructor(
    private readonly clientFactory: LlmClientFactory = defaultLlmClientFactory,
    loggingCallback?: LoggingCallback,
  ) {
    this.log = createOperationLogger('LlmAdapter', loggingCallback);
  }

  /**
   * "Provisioning" an LLM provider just means recording the manifest
   * metadata. There are no remote resources to create, and the verify
   * step (run separately) is what actually validates the credentials.
   */
  async provision(config: LlmManifestConfig): Promise<ProviderState> {
    this.assertManifestValid(config);
    const now = Date.now();
    return {
      provider_id: 'llm',
      provider_type: 'llm',
      resource_ids: {
        kind: config.kind,
        display_name: config.display_name,
        default_model: config.default_model,
        ...(config.base_url ? { base_url: config.base_url } : {}),
        ...(config.organization_id ? { organization_id: config.organization_id } : {}),
      },
      config_hashes: { config: this.hashConfig(config) },
      credential_metadata: {},
      partially_complete: true,
      failed_steps: [],
      completed_steps: [],
      created_at: now,
      updated_at: now,
    };
  }

  async executeStep(
    stepKey: string,
    config: LlmManifestConfig,
    context: StepContext,
  ): Promise<StepResult> {
    const kind = llmKindFromStepKey(stepKey);
    if (!kind) {
      throw new AdapterError(`Unknown LLM step: ${stepKey}`, 'llm', 'executeStep');
    }
    this.log.info('LlmAdapter.executeStep()', { stepKey, kind });

    if (stepKey.startsWith('llm:verify-')) {
      const client = await this.clientFactory(kind, context);
      const defaultModel = stripped(config.default_model);
      const result = await client.verifyCredentials({ defaultModel });
      return {
        status: 'completed',
        resourcesProduced: {
          [`llm_${kind}_models_available`]: result.modelsAvailable.slice(0, 50).join(','),
          [`llm_${kind}_default_model_found`]:
            result.defaultModelFound === null ? 'unchecked' : String(result.defaultModelFound),
        },
        userPrompt:
          result.defaultModelFound === false
            ? `Credentials are valid but default_model "${defaultModel}" was not in the listed models for ${kindLabel(kind)}. Update the manifest default model to one of the listed ids.`
            : undefined,
      };
    }

    throw new AdapterError(`Unknown LLM step: ${stepKey}`, 'llm', 'executeStep');
  }

  async checkStep(
    stepKey: string,
    config: LlmManifestConfig,
    context: StepContext,
  ): Promise<StepResult> {
    const kind = llmKindFromStepKey(stepKey);
    if (!kind) {
      return { status: 'completed', resourcesProduced: {} };
    }
    if (stepKey.startsWith('llm:verify-')) {
      try {
        const client = await this.clientFactory(kind, context);
        const result = await client.verifyCredentials({ defaultModel: stripped(config.default_model) });
        return {
          status: 'completed',
          resourcesProduced: {
            [`llm_${kind}_models_available`]: result.modelsAvailable.slice(0, 50).join(','),
            [`llm_${kind}_default_model_found`]:
              result.defaultModelFound === null ? 'unchecked' : String(result.defaultModelFound),
          },
        };
      } catch (err) {
        return {
          status: 'failed',
          resourcesProduced: {},
          error: (err as Error).message,
        };
      }
    }
    return { status: 'completed', resourcesProduced: {} };
  }

  async validate(
    manifest: LlmManifestConfig,
    liveState: ProviderState | null,
  ): Promise<DriftReport> {
    this.assertManifestValid(manifest);
    const differences: DriftDifference[] = [];

    if (!liveState) {
      return {
        provider_id: 'llm',
        provider_type: 'llm',
        manifest_state: manifest,
        live_state: null,
        differences: [
          {
            field: 'kind',
            manifest_value: manifest.kind,
            live_value: null,
            conflict_type: 'missing_in_live',
          },
        ],
        orphaned_resources: [],
        requires_user_decision: false,
      };
    }

    if (liveState.resource_ids['kind'] !== manifest.kind) {
      differences.push({
        field: 'kind',
        manifest_value: manifest.kind,
        live_value: liveState.resource_ids['kind'] ?? null,
        conflict_type: 'value_mismatch',
      });
    }
    if (liveState.resource_ids['default_model'] !== manifest.default_model) {
      differences.push({
        field: 'default_model',
        manifest_value: manifest.default_model,
        live_value: liveState.resource_ids['default_model'] ?? null,
        conflict_type: liveState.resource_ids['default_model']
          ? 'value_mismatch'
          : 'missing_in_live',
      });
    }
    if (manifest.kind === 'custom' && liveState.resource_ids['base_url'] !== manifest.base_url) {
      differences.push({
        field: 'base_url',
        manifest_value: manifest.base_url ?? null,
        live_value: liveState.resource_ids['base_url'] ?? null,
        conflict_type: liveState.resource_ids['base_url']
          ? 'value_mismatch'
          : 'missing_in_live',
      });
    }

    return {
      provider_id: liveState.provider_id,
      provider_type: 'llm',
      manifest_state: manifest,
      live_state: liveState,
      differences,
      orphaned_resources: [],
      requires_user_decision: false,
    };
  }

  async reconcile(
    report: DriftReport,
    direction: ReconcileDirection,
  ): Promise<ProviderState> {
    const manifest = report.manifest_state as LlmManifestConfig;
    if (!report.live_state) {
      return this.provision(manifest);
    }
    if (direction === 'manifest→live') {
      report.live_state.resource_ids['kind'] = manifest.kind;
      report.live_state.resource_ids['display_name'] = manifest.display_name;
      report.live_state.resource_ids['default_model'] = manifest.default_model;
      if (manifest.base_url) {
        report.live_state.resource_ids['base_url'] = manifest.base_url;
      } else {
        delete report.live_state.resource_ids['base_url'];
      }
      if (manifest.organization_id) {
        report.live_state.resource_ids['organization_id'] = manifest.organization_id;
      } else {
        delete report.live_state.resource_ids['organization_id'];
      }
    }
    report.live_state.updated_at = Date.now();
    return report.live_state;
  }

  async extractCredentials(state: ProviderState): Promise<Record<string, string>> {
    const out: Record<string, string> = {
      kind: state.resource_ids['kind'] ?? '',
      display_name: state.resource_ids['display_name'] ?? '',
      default_model: state.resource_ids['default_model'] ?? '',
    };
    if (state.resource_ids['base_url']) out['base_url'] = state.resource_ids['base_url'];
    if (state.resource_ids['organization_id']) {
      out['organization_id'] = state.resource_ids['organization_id'];
    }
    return out;
  }

  /**
   * Throws if the manifest is structurally invalid. Kept on the adapter (not
   * the schema layer) because the cross-field rule (`kind === 'custom'`
   * implies `base_url`) is semantic, not structural.
   */
  private assertManifestValid(config: LlmManifestConfig): void {
    if (!config.kind) {
      throw new AdapterError('LLM manifest is missing required field "kind".', 'llm', 'validate');
    }
    if (!config.display_name?.trim()) {
      throw new AdapterError('LLM manifest is missing required field "display_name".', 'llm', 'validate');
    }
    if (!config.default_model?.trim()) {
      throw new AdapterError('LLM manifest is missing required field "default_model".', 'llm', 'validate');
    }
    if (config.kind === 'custom') {
      if (!config.base_url?.trim()) {
        throw new AdapterError(
          'LLM manifest with kind="custom" must set base_url.',
          'llm',
          'validate',
        );
      }
      assertCustomBaseUrl(config.base_url);
    } else if (config.base_url) {
      throw new AdapterError(
        `LLM manifest with kind="${config.kind}" must not set base_url; that field is reserved for kind="custom".`,
        'llm',
        'validate',
      );
    }
  }

  private hashConfig(config: LlmManifestConfig): string {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify({
        kind: config.kind,
        display_name: config.display_name,
        default_model: config.default_model,
        base_url: config.base_url ?? null,
        organization_id: config.organization_id ?? null,
      }))
      .digest('hex')
      .slice(0, 16);
  }
}

function stripped(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}
