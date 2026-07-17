import { HttpCloudflareApiClient } from '../providers/cloudflare';

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 400,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('HttpCloudflareApiClient', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('throws when constructed without an API token', () => {
    expect(() => new HttpCloudflareApiClient('', 'accountid')).toThrow(/API token is required/);
  });

  it('throws when constructed without an account ID', () => {
    expect(() => new HttpCloudflareApiClient('token', '')).toThrow(/account ID is required/);
  });

  it('verifies the token against the account-scoped endpoint', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ success: true, errors: [], result: { status: 'active' } }),
    );

    const client = new HttpCloudflareApiClient('test-token', 'account-123');
    const result = await client.verifyToken();

    expect(result.status).toBe('active');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/account-123/tokens/verify',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      }),
    );
  });

  it('includes the account ID when creating a zone', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ success: true, errors: [], result: { id: 'zone-1' } }),
    );

    const client = new HttpCloudflareApiClient('test-token', 'account-123');
    const zoneId = await client.createZone('example.com');

    expect(zoneId).toBe('zone-1');
    const [, init] = fetchSpy.mock.calls[0];
    const sentBody = JSON.parse((init as RequestInit).body as string);
    expect(sentBody).toMatchObject({ name: 'example.com', account: { id: 'account-123' } });
  });

  describe('upsertRedirectRule', () => {
    it('adds a new Single Redirect rule to the dynamic-redirect phase entrypoint', async () => {
      const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const method = (init as RequestInit).method;
        if (method === 'GET') {
          return jsonResponse({ success: true, errors: [], result: { rules: [] } });
        }
        // PUT — echo back the rules we were asked to save, with a generated id.
        const sentBody = JSON.parse((init as RequestInit).body as string) as { rules: Array<Record<string, unknown>> };
        const savedRules = sentBody.rules.map((rule, idx) => ({ ...rule, id: `rule-${idx}` }));
        return jsonResponse({ success: true, errors: [], result: { rules: savedRules } });
      });

      const client = new HttpCloudflareApiClient('test-token', 'account-123');
      const ruleId = await client.upsertRedirectRule('zone-1', 'app.example.com/callback', 'forward_url');

      expect(ruleId).toBe('rule-0');

      const putCall = fetchSpy.mock.calls.find(([, init]) => (init as RequestInit).method === 'PUT');
      expect(putCall).toBeDefined();
      const [putUrl, putInit] = putCall!;
      expect(putUrl).toBe(
        'https://api.cloudflare.com/client/v4/zones/zone-1/rulesets/phases/http_request_dynamic_redirect/entrypoint',
      );
      const sentBody = JSON.parse((putInit as RequestInit).body as string) as { rules: Array<Record<string, unknown>> };
      expect(sentBody.rules).toHaveLength(1);
      expect(sentBody.rules[0]).toMatchObject({
        expression: '(http.host eq "app.example.com" and http.request.uri.path eq "/callback")',
        action: 'redirect',
        action_parameters: {
          from_value: {
            target_url: { value: 'app.example.com/callback' },
            status_code: 302,
            preserve_query_string: true,
          },
        },
      });
    });

    it('replaces an existing rule for the same route instead of duplicating it', async () => {
      const existingRule = {
        id: 'rule-old',
        expression: '(http.host eq "app.example.com" and http.request.uri.path eq "/callback")',
        action: 'redirect',
        action_parameters: { from_value: { target_url: { value: 'stale-value' }, status_code: 302 } },
      };
      const unrelatedRule = {
        id: 'rule-keep',
        expression: '(http.host eq "app.example.com" and http.request.uri.path eq "/other")',
        action: 'redirect',
        action_parameters: { from_value: { target_url: { value: 'app.example.com/other' }, status_code: 302 } },
      };

      const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const method = (init as RequestInit).method;
        if (method === 'GET') {
          return jsonResponse({ success: true, errors: [], result: { rules: [existingRule, unrelatedRule] } });
        }
        const sentBody = JSON.parse((init as RequestInit).body as string) as { rules: Array<Record<string, unknown>> };
        return jsonResponse({ success: true, errors: [], result: { rules: sentBody.rules } });
      });

      const client = new HttpCloudflareApiClient('test-token', 'account-123');
      await client.upsertRedirectRule('zone-1', 'app.example.com/callback', 'forward_url');

      const putCall = fetchSpy.mock.calls.find(([, init]) => (init as RequestInit).method === 'PUT')!;
      const sentBody = JSON.parse((putCall[1] as RequestInit).body as string) as { rules: Array<Record<string, unknown>> };
      expect(sentBody.rules).toHaveLength(2);
      expect(sentBody.rules.some((r) => r.id === 'rule-keep')).toBe(true);
      expect(sentBody.rules.some((r) => r.id === 'rule-old')).toBe(false);
    });
  });

  describe('getRedirectRules', () => {
    it('maps redirect rules to url/action pairs and ignores other rule types', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        jsonResponse({
          success: true,
          errors: [],
          result: {
            rules: [
              {
                action: 'redirect',
                action_parameters: { from_value: { target_url: { value: 'app.example.com/callback' } } },
              },
              { action: 'skip', action_parameters: {} },
            ],
          },
        }),
      );

      const client = new HttpCloudflareApiClient('test-token', 'account-123');
      const rules = await client.getRedirectRules('zone-1');

      expect(rules).toEqual([{ url: 'app.example.com/callback', action: 'forward_url' }]);
    });

    it('returns an empty list when the zone has no entrypoint ruleset yet', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ success: false, errors: [{ code: 10000, message: 'not found' }] }, false));

      const client = new HttpCloudflareApiClient('test-token', 'account-123');
      const rules = await client.getRedirectRules('zone-1');

      expect(rules).toEqual([]);
    });
  });
});
