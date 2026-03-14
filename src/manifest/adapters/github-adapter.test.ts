import * as https from 'https';
import { GitHubAdapter } from './github-adapter';

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

const USER_RESPONSE = JSON.stringify({ login: 'testuser', id: 1 });
const REPOS_RESPONSE = JSON.stringify([
  { id: 1, name: 'my-repo', full_name: 'testuser/my-repo', private: false, default_branch: 'main' },
]);
const REPO_RESPONSE = JSON.stringify({
  id: 1, name: 'my-repo', full_name: 'testuser/my-repo', private: false, default_branch: 'main',
});
const PROTECTION_RESPONSE = JSON.stringify({
  required_status_checks: { strict: true, contexts: ['ci'] },
  enforce_admins: { enabled: true },
  required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: false },
});
const ENVS_RESPONSE = JSON.stringify({
  environments: [
    { id: 1, name: 'production', protection_rules: [{ type: 'required_reviewers' }] },
  ],
});

describe('GitHubAdapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('authenticate', () => {
    it('throws if token is missing', async () => {
      const adapter = new GitHubAdapter();
      await expect(adapter.authenticate({})).rejects.toThrow('GitHub credentials must include token');
    });

    it('throws if token is invalid (non-200 response)', async () => {
      mockHttpsRequest.mockImplementationOnce(mockResponse(401, 'Unauthorized'));
      const adapter = new GitHubAdapter();
      await expect(adapter.authenticate({ token: 'bad-token' })).rejects.toThrow(
        'GitHub authentication failed: HTTP 401',
      );
    });

    it('authenticates with valid token', async () => {
      mockHttpsRequest.mockImplementationOnce(mockResponse(200, USER_RESPONSE));
      const adapter = new GitHubAdapter();
      await expect(adapter.authenticate({ token: 'ghp_validtoken123' })).resolves.not.toThrow();
    });
  });

  describe('listResources', () => {
    it('throws without authentication', async () => {
      const adapter = new GitHubAdapter();
      await expect(adapter.listResources()).rejects.toThrow('must be authenticated');
    });

    it('returns repositories with config', async () => {
      mockHttpsRequest
        .mockImplementationOnce(mockResponse(200, USER_RESPONSE)) // authenticate
        .mockImplementationOnce(mockResponse(200, REPOS_RESPONSE)) // list repos page 1
        .mockImplementationOnce(mockResponse(200, REPO_RESPONSE))  // get repo
        .mockImplementationOnce(mockResponse(200, PROTECTION_RESPONSE)) // branch protection
        .mockImplementationOnce(mockResponse(200, ENVS_RESPONSE)); // environments

      const adapter = new GitHubAdapter();
      await adapter.authenticate({ token: 'ghp_test' });
      const resources = await adapter.listResources();

      expect(resources).toHaveLength(1);
      expect(resources[0].provider).toBe('github');
      expect(resources[0].resourceType).toBe('repository');
      expect(resources[0].resourceId).toBe('testuser/my-repo');
      expect(resources[0].configuration['fullName']).toBe('testuser/my-repo');
      expect(resources[0].configuration['defaultBranch']).toBe('main');
    });

    it('handles missing branch protection gracefully', async () => {
      mockHttpsRequest
        .mockImplementationOnce(mockResponse(200, USER_RESPONSE))
        .mockImplementationOnce(mockResponse(200, REPOS_RESPONSE))
        .mockImplementationOnce(mockResponse(200, REPO_RESPONSE))
        .mockImplementationOnce(mockResponse(404, 'Not Found')) // no protection
        .mockImplementationOnce(mockResponse(200, ENVS_RESPONSE));

      const adapter = new GitHubAdapter();
      await adapter.authenticate({ token: 'ghp_test' });
      const resources = await adapter.listResources();

      expect(resources).toHaveLength(1);
      const config = resources[0].configuration['branchProtection'] as Record<string, unknown>;
      expect(config['enforceAdmins']).toBe(false);
    });
  });

  describe('getResourceConfig', () => {
    it('returns stable config hash', async () => {
      mockHttpsRequest
        .mockImplementationOnce(mockResponse(200, USER_RESPONSE))
        .mockImplementationOnce(mockResponse(200, REPO_RESPONSE))
        .mockImplementationOnce(mockResponse(200, PROTECTION_RESPONSE))
        .mockImplementationOnce(mockResponse(200, ENVS_RESPONSE));

      const adapter = new GitHubAdapter();
      await adapter.authenticate({ token: 'ghp_test' });
      const config1 = await adapter.getResourceConfig('testuser/my-repo');

      mockHttpsRequest
        .mockImplementationOnce(mockResponse(200, REPO_RESPONSE))
        .mockImplementationOnce(mockResponse(200, PROTECTION_RESPONSE))
        .mockImplementationOnce(mockResponse(200, ENVS_RESPONSE));

      const config2 = await adapter.getResourceConfig('testuser/my-repo');

      const { computeHash } = require('../hash-calculator');
      expect(computeHash(config1)).toBe(computeHash(config2));
    });
  });
});
