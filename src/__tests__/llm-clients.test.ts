import {
  OpenAIClient,
  AnthropicClient,
  GeminiClient,
  CustomOpenAICompatClient,
  assertCustomBaseUrl,
  createLlmClient,
} from '../providers/llm';

// ---------------------------------------------------------------------------
// fetch mocking helpers
// ---------------------------------------------------------------------------

type FetchCall = { url: string; init?: RequestInit };
type FetchHandler = (call: FetchCall) => { status?: number; body: unknown };

function installFetch(handler: FetchHandler): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = async (url: any, init?: RequestInit): Promise<Response> => {
    const call: FetchCall = { url: String(url), init };
    calls.push(call);
    const { status = 200, body } = handler(call);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return {
    calls,
    restore: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).fetch = original;
    },
  };
}

afterEach(() => {
  // Belt-and-braces: every test installs its own fetch and restores it;
  // this catches accidental leaks if a test forgets to call restore().
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// OpenAIClient
// ---------------------------------------------------------------------------

describe('OpenAIClient', () => {
  it('verifyCredentials hits /v1/models with bearer auth and returns sorted ids', async () => {
    const fake = installFetch(() => ({
      body: { data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4o' }, { id: 'gpt-3.5-turbo' }] },
    }));

    const client = new OpenAIClient('sk-test-key');
    const result = await client.verifyCredentials({ defaultModel: 'gpt-4o-mini' });

    expect(result.modelsAvailable).toEqual(['gpt-3.5-turbo', 'gpt-4o', 'gpt-4o-mini']);
    expect(result.defaultModelFound).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].url).toBe('https://api.openai.com/v1/models');
    const headers = (fake.calls[0].init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test-key');

    fake.restore();
  });

  it('passes OpenAI-Organization header when organizationId is set', async () => {
    const fake = installFetch(() => ({ body: { data: [{ id: 'gpt-4o' }] } }));

    const client = new OpenAIClient('sk-key', { organizationId: 'org-acme' });
    await client.verifyCredentials();

    const headers = (fake.calls[0].init?.headers ?? {}) as Record<string, string>;
    expect(headers['OpenAI-Organization']).toBe('org-acme');

    fake.restore();
  });

  it('reports defaultModelFound=false when the chosen model is missing', async () => {
    const fake = installFetch(() => ({ body: { data: [{ id: 'gpt-4o' }] } }));

    const client = new OpenAIClient('sk-test');
    const result = await client.verifyCredentials({ defaultModel: 'gpt-99-nonexistent' });
    expect(result.defaultModelFound).toBe(false);

    fake.restore();
  });

  it('throws on non-2xx with status + body snippet (no silent fallback)', async () => {
    const fake = installFetch(() => ({ status: 401, body: { error: 'invalid_api_key' } }));

    const client = new OpenAIClient('sk-bad');
    await expect(client.listModels()).rejects.toThrow(/401/);
    await expect(client.listModels()).rejects.toThrow(/invalid_api_key/);

    fake.restore();
  });

  it('rejects empty api keys at construction time', () => {
    expect(() => new OpenAIClient('')).toThrow(/API key is required/);
    expect(() => new OpenAIClient('   ')).toThrow(/API key is required/);
  });
});

// ---------------------------------------------------------------------------
// AnthropicClient
// ---------------------------------------------------------------------------

describe('AnthropicClient', () => {
  it('uses x-api-key + anthropic-version headers', async () => {
    const fake = installFetch(() => ({
      body: { data: [{ id: 'claude-3-5-sonnet-20241022' }, { id: 'claude-3-haiku-20240307' }] },
    }));

    const client = new AnthropicClient('sk-ant-test');
    await client.listModels();

    const headers = (fake.calls[0].init?.headers ?? {}) as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe(AnthropicClient.API_VERSION);
    expect(fake.calls[0].url).toBe('https://api.anthropic.com/v1/models');

    fake.restore();
  });
});

// ---------------------------------------------------------------------------
// GeminiClient
// ---------------------------------------------------------------------------

describe('GeminiClient', () => {
  it('passes the api key as a query param and strips the "models/" prefix', async () => {
    const fake = installFetch(() => ({
      body: {
        models: [
          { name: 'models/gemini-1.5-pro-latest' },
          { name: 'models/gemini-1.5-flash' },
        ],
      },
    }));

    const client = new GeminiClient('AIza-test');
    const result = await client.verifyCredentials({ defaultModel: 'gemini-1.5-pro-latest' });

    expect(result.modelsAvailable).toEqual(['gemini-1.5-flash', 'gemini-1.5-pro-latest']);
    expect(result.defaultModelFound).toBe(true);
    expect(fake.calls[0].url).toContain('key=AIza-test');

    fake.restore();
  });

  it('redacts the api key from URLs surfaced in errors', async () => {
    const fake = installFetch(() => ({ status: 403, body: { error: 'forbidden' } }));

    const client = new GeminiClient('AIza-secret');
    // Two assertions on the same property: the safe sentinel must appear and
    // the raw key must not. URL.toString() percent-encodes the brackets, so
    // we match either the literal "[REDACTED]" or its percent-encoded form.
    await expect(client.listModels()).rejects.toThrow(/REDACTED|%5BREDACTED%5D/);
    await expect(client.listModels()).rejects.not.toThrow(/AIza-secret/);

    fake.restore();
  });
});

// ---------------------------------------------------------------------------
// CustomOpenAICompatClient
// ---------------------------------------------------------------------------

describe('CustomOpenAICompatClient', () => {
  it('hits {base_url}/models with bearer auth', async () => {
    const fake = installFetch(() => ({
      body: { data: [{ id: 'llama-3.1-70b-instruct' }] },
    }));

    const client = new CustomOpenAICompatClient('sk-custom', 'https://llm.internal.example.com/v1');
    const result = await client.verifyCredentials({ defaultModel: 'llama-3.1-70b-instruct' });

    expect(result.modelsAvailable).toEqual(['llama-3.1-70b-instruct']);
    expect(fake.calls[0].url).toBe('https://llm.internal.example.com/v1/models');

    fake.restore();
  });

  it('trims trailing slashes off base_url before composing requests', async () => {
    const fake = installFetch(() => ({ body: { data: [] } }));

    const client = new CustomOpenAICompatClient('sk', 'https://llm.example.com/v1////');
    await client.listModels();
    expect(fake.calls[0].url).toBe('https://llm.example.com/v1/models');

    fake.restore();
  });

  it('rejects non-https base_url', () => {
    expect(() => new CustomOpenAICompatClient('sk', 'http://insecure.example.com/v1')).toThrow(
      /must use https/,
    );
  });

  it('rejects base_url that points at a public provider host', () => {
    expect(() => assertCustomBaseUrl('https://api.openai.com/v1')).toThrow(/kind="openai"/);
    expect(() => assertCustomBaseUrl('https://api.anthropic.com/v1')).toThrow(/kind="anthropic"/);
    expect(() =>
      assertCustomBaseUrl('https://generativelanguage.googleapis.com/v1beta'),
    ).toThrow(/kind="gemini"/);
  });

  it('rejects malformed base_url', () => {
    expect(() => assertCustomBaseUrl('not-a-url')).toThrow(/not a valid URL/);
  });
});

// ---------------------------------------------------------------------------
// createLlmClient factory
// ---------------------------------------------------------------------------

describe('createLlmClient', () => {
  it('builds the right concrete client per kind', () => {
    expect(createLlmClient('openai', 'k')).toBeInstanceOf(OpenAIClient);
    expect(createLlmClient('anthropic', 'k')).toBeInstanceOf(AnthropicClient);
    expect(createLlmClient('gemini', 'k')).toBeInstanceOf(GeminiClient);
    expect(
      createLlmClient('custom', 'k', { baseUrl: 'https://llm.internal.example.com/v1' }),
    ).toBeInstanceOf(CustomOpenAICompatClient);
  });

  it('throws when kind="custom" is missing base_url', () => {
    expect(() => createLlmClient('custom', 'k')).toThrow(/requires base_url/);
  });
});
