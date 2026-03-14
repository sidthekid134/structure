import * as https from 'https';
import { FirebaseAdapter } from './firebase-adapter';

jest.mock('https');

const mockHttpsRequest = https.request as jest.Mock;

function mockResponse(statusCode: number, body: string) {
  return (
    _options: unknown,
    callback: (res: { statusCode: number; on: jest.Mock }) => void,
  ) => {
    const dataListeners: Array<(chunk: string) => void> = [];
    const endListeners: Array<() => void> = [];

    const res = {
      statusCode,
      on: jest.fn((event: string, listener: (...args: unknown[]) => void) => {
        if (event === 'data') dataListeners.push(listener as (chunk: string) => void);
        if (event === 'end') endListeners.push(listener as () => void);
      }),
    };

    process.nextTick(() => {
      callback(res);
      dataListeners.forEach((l) => l(body));
      endListeners.forEach((l) => l());
    });

    return { on: jest.fn(), write: jest.fn(), end: jest.fn() };
  };
}

function makeAuthenticatedAdapter(): FirebaseAdapter {
  const adapter = new FirebaseAdapter();
  const a = adapter as unknown as Record<string, unknown>;
  a['authenticated'] = true;
  a['accessToken'] = 'fake-token';
  a['projectId'] = 'my-project';
  return adapter;
}

const FIREBASE_APPS_RESPONSE = JSON.stringify({
  apps: [
    {
      appId: 'projects/my-project/apps/app-001',
      displayName: 'My App',
      bundleId: 'com.example.app',
      platform: 'IOS',
      projectId: 'my-project',
    },
  ],
});

const FIREBASE_APP_CONFIG_RESPONSE = JSON.stringify({
  appId: 'projects/my-project/apps/app-001',
  displayName: 'My App',
  bundleId: 'com.example.app',
  platform: 'IOS',
  projectId: 'my-project',
});

describe('FirebaseAdapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('authenticate', () => {
    it('throws if credentials are missing', async () => {
      const adapter = new FirebaseAdapter();
      await expect(adapter.authenticate({})).rejects.toThrow('Firebase credentials must include');
    });

    it('throws if service_account_key is not valid base64 JSON', async () => {
      const adapter = new FirebaseAdapter();
      await expect(
        adapter.authenticate({ project_id: 'p', service_account_key: 'not-valid-json-base64' }),
      ).rejects.toThrow();
    });
  });

  describe('requireAuth guard', () => {
    it('throws when listing resources without authentication', async () => {
      const adapter = new FirebaseAdapter();
      await expect(adapter.listResources()).rejects.toThrow('must be authenticated');
    });

    it('throws when getting resource config without authentication', async () => {
      const adapter = new FirebaseAdapter();
      await expect(adapter.getResourceConfig('app-1')).rejects.toThrow('must be authenticated');
    });
  });

  describe('listResources (mocked HTTP)', () => {
    it('returns resources from Firebase API', async () => {
      mockHttpsRequest
        .mockImplementationOnce(mockResponse(200, FIREBASE_APPS_RESPONSE))
        .mockImplementationOnce(mockResponse(200, FIREBASE_APP_CONFIG_RESPONSE));

      const adapter = makeAuthenticatedAdapter();
      const resources = await adapter.listResources();
      expect(resources).toHaveLength(1);
      expect(resources[0].provider).toBe('firebase');
      expect(resources[0].resourceType).toBe('app');
      expect(resources[0].resourceId).toBe('projects/my-project/apps/app-001');
    });

    it('returns empty array when no apps', async () => {
      mockHttpsRequest.mockImplementationOnce(mockResponse(200, JSON.stringify({ apps: [] })));
      const adapter = makeAuthenticatedAdapter();
      const resources = await adapter.listResources();
      expect(resources).toHaveLength(0);
    });

    it('throws on non-200 response from list apps', async () => {
      mockHttpsRequest.mockImplementationOnce(mockResponse(403, 'Forbidden'));
      const adapter = makeAuthenticatedAdapter();
      await expect(adapter.listResources()).rejects.toThrow('Firebase list apps failed: HTTP 403');
    });

    it('includes configuration in resources', async () => {
      mockHttpsRequest
        .mockImplementationOnce(mockResponse(200, FIREBASE_APPS_RESPONSE))
        .mockImplementationOnce(mockResponse(200, FIREBASE_APP_CONFIG_RESPONSE));

      const adapter = makeAuthenticatedAdapter();
      const resources = await adapter.listResources();
      expect(resources[0].configuration['bundleId']).toBe('com.example.app');
      expect(resources[0].configuration['displayName']).toBe('My App');
    });
  });

  describe('getResourceConfig (mocked HTTP)', () => {
    it('returns stable config for same resource', async () => {
      mockHttpsRequest
        .mockImplementationOnce(mockResponse(200, FIREBASE_APP_CONFIG_RESPONSE))
        .mockImplementationOnce(mockResponse(200, FIREBASE_APP_CONFIG_RESPONSE));

      const adapter = makeAuthenticatedAdapter();
      const config1 = await adapter.getResourceConfig('projects/my-project/apps/app-001');
      const config2 = await adapter.getResourceConfig('projects/my-project/apps/app-001');

      const { computeHash } = require('../hash-calculator');
      expect(computeHash(config1)).toBe(computeHash(config2));
    });

    it('throws on non-200 response', async () => {
      mockHttpsRequest.mockImplementationOnce(mockResponse(404, 'Not Found'));
      const adapter = makeAuthenticatedAdapter();
      await expect(adapter.getResourceConfig('bad-id')).rejects.toThrow('HTTP 404');
    });
  });
});
