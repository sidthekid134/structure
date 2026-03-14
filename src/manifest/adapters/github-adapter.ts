import * as https from 'https';
import { LiveResource } from '../../types/manifest';
import { RateLimitError } from '../retry-handler';
import { BaseAdapter, HttpResponse } from './base-adapter';

interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
}

interface BranchProtection {
  required_status_checks?: {
    strict: boolean;
    contexts: string[];
  };
  enforce_admins?: { enabled: boolean };
  required_pull_request_reviews?: {
    required_approving_review_count: number;
    dismiss_stale_reviews: boolean;
  };
  restrictions?: { users: string[]; teams: string[] } | null;
}

interface DeploymentEnvironment {
  id: number;
  name: string;
  protection_rules?: Array<{ type: string }>;
}

export class GitHubAdapter extends BaseAdapter {
  private token = '';

  async authenticate(credentials: Record<string, string>): Promise<void> {
    const token = credentials['token'];
    if (!token) {
      throw new Error('GitHub credentials must include token');
    }
    this.token = token;

    // Verify token by hitting the user endpoint
    const response = await this.httpGet('https://api.github.com/user', {
      Authorization: `Bearer ${this.token}`,
      'User-Agent': 'platform-manifest/1.0',
      Accept: 'application/vnd.github+json',
    });

    if (response.statusCode !== 200) {
      throw new Error(`GitHub authentication failed: HTTP ${response.statusCode}`);
    }

    this.authenticated = true;
  }

  async listResources(): Promise<LiveResource[]> {
    this.requireAuth();
    const resources: LiveResource[] = [];

    // List all repos for the authenticated user
    let page = 1;
    while (true) {
      const response = await this.fetchWithRetry(() =>
        this.httpGet(
          `https://api.github.com/user/repos?per_page=100&page=${page}&sort=full_name`,
          {
            Authorization: `Bearer ${this.token}`,
            'User-Agent': 'platform-manifest/1.0',
            Accept: 'application/vnd.github+json',
          },
        ),
      );

      if (response.statusCode !== 200) {
        throw new Error(`GitHub list repos failed: HTTP ${response.statusCode}`);
      }

      const repos = this.parseJson<GitHubRepo[]>(response.body);
      if (repos.length === 0) break;

      for (const repo of repos) {
        const config = await this.getResourceConfig(repo.full_name);
        resources.push({
          provider: 'github',
          resourceType: 'repository',
          resourceId: repo.full_name,
          configuration: config,
        });
      }

      if (repos.length < 100) break;
      page++;
    }

    return resources;
  }

  async getResourceConfig(resourceId: string): Promise<Record<string, unknown>> {
    this.requireAuth();

    // Get branch protection rules for the default branch
    const repoResponse = await this.fetchWithRetry(() =>
      this.httpGet(`https://api.github.com/repos/${resourceId}`, {
        Authorization: `Bearer ${this.token}`,
        'User-Agent': 'platform-manifest/1.0',
        Accept: 'application/vnd.github+json',
      }),
    );

    if (repoResponse.statusCode === 429 || repoResponse.statusCode === 503) {
      throw new RateLimitError(repoResponse.statusCode, `HTTP ${repoResponse.statusCode}`);
    }

    if (repoResponse.statusCode !== 200) {
      throw new Error(`GitHub get repo failed: HTTP ${repoResponse.statusCode}`);
    }

    const repo = this.parseJson<GitHubRepo>(repoResponse.body);

    // Get branch protection for default branch
    let branchProtection: BranchProtection = {};
    const protectionResponse = await this.fetchWithRetry(() =>
      this.httpGet(
        `https://api.github.com/repos/${resourceId}/branches/${repo.default_branch}/protection`,
        {
          Authorization: `Bearer ${this.token}`,
          'User-Agent': 'platform-manifest/1.0',
          Accept: 'application/vnd.github+json',
        },
      ),
    );

    if (protectionResponse.statusCode === 200) {
      branchProtection = this.parseJson<BranchProtection>(protectionResponse.body);
    }

    // Get deployment environments
    const envsResponse = await this.fetchWithRetry(() =>
      this.httpGet(`https://api.github.com/repos/${resourceId}/environments`, {
        Authorization: `Bearer ${this.token}`,
        'User-Agent': 'platform-manifest/1.0',
        Accept: 'application/vnd.github+json',
      }),
    );

    let environments: DeploymentEnvironment[] = [];
    if (envsResponse.statusCode === 200) {
      const envsData = this.parseJson<{ environments: DeploymentEnvironment[] }>(
        envsResponse.body,
      );
      environments = envsData.environments ?? [];
    }

    return {
      fullName: repo.full_name,
      private: repo.private,
      defaultBranch: repo.default_branch,
      branchProtection: {
        requiredStatusChecks: branchProtection.required_status_checks ?? null,
        enforceAdmins: branchProtection.enforce_admins?.enabled ?? false,
        requiredReviewCount:
          branchProtection.required_pull_request_reviews?.required_approving_review_count ?? 0,
        dismissStaleReviews:
          branchProtection.required_pull_request_reviews?.dismiss_stale_reviews ?? false,
      },
      environments: environments.map((env) => ({
        name: env.name,
        protectionRules: env.protection_rules?.map((r) => r.type) ?? [],
      })),
    };
  }

  private httpGet(url: string, headers: Record<string, string>): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const options = {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers,
      };
      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end();
    });
  }
}
