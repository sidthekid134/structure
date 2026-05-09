import * as https from 'https';
import { IncomingHttpHeaders } from 'http';
import {
  CredentialService,
  ORG_SENTINEL,
} from '../services/credential-service.js';
import {
  ProjectManager,
  IntegrationConfigRecord,
} from '../studio/project-manager.js';

export interface GitHubConnectionDetails {
  userId: string;
  username: string;
  orgNames: string[];
  scopes: string[];
}

export interface GitHubConnectionStatus {
  available: boolean;
  connected: boolean;
  requires_token: boolean;
  details?: Omit<GitHubConnectionDetails, 'userId'>;
  integration?: IntegrationConfigRecord;
}

interface GitHubApiResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: string;
}

const REQUIRED_SCOPES = ['repo', 'workflow'];

export class GitHubConnectionService {
  constructor(
    private readonly credentialService: CredentialService,
    private readonly projectManager: ProjectManager,
  ) {}

  getStoredGitHubToken(): string | undefined {
    return this.credentialService.retrieveOrgCredential('github_pat') ?? undefined;
  }

  storeGitHubToken(token: string): void {
    if (typeof token !== 'string' || token.trim().length === 0) {
      throw new Error('GitHub token is required.');
    }
    this.credentialService.storeOrgCredential('github_pat', token.trim());
  }

  storeGitHubConnectionDetails(details: GitHubConnectionDetails): void {
    this.credentialService.storeOrgCredential('github_user_id', details.userId);
    this.credentialService.storeOrgCredential('github_username', details.username);
    this.credentialService.storeOrgCredential('github_orgs', JSON.stringify(details.orgNames));
    this.credentialService.storeOrgCredential('github_scopes', JSON.stringify(details.scopes));
    this.credentialService.storeOrgCredential('github_validated_at', new Date().toISOString());
  }

  deleteStoredGitHubConnectionDetails(): void {
    this.credentialService.deleteCredentialByType(ORG_SENTINEL, 'github_user_id');
    this.credentialService.deleteCredentialByType(ORG_SENTINEL, 'github_username');
    this.credentialService.deleteCredentialByType(ORG_SENTINEL, 'github_orgs');
    this.credentialService.deleteCredentialByType(ORG_SENTINEL, 'github_scopes');
    this.credentialService.deleteCredentialByType(ORG_SENTINEL, 'github_validated_at');
  }

  deleteStoredGitHubToken(): boolean {
    const summary = this.credentialService.getOrgCredentialSummary('github_pat');
    if (!summary) return false;
    this.credentialService.deleteCredential(summary.id);
    return true;
  }

  async fetchGitHubConnectionDetails(token: string): Promise<GitHubConnectionDetails> {
    const userResponse = await this.githubRequest('/user', token);
    const userPayload = this.parseJson<{ login?: string; id?: number | string; message?: string }>(
      userResponse.body,
      '/user',
    );
    const username = userPayload.login?.trim();
    if (!username) {
      throw new Error('GitHub /user response did not include a username.');
    }
    const userId =
      typeof userPayload.id === 'number' || typeof userPayload.id === 'string'
        ? String(userPayload.id)
        : username;

    const scopes = this.extractScopes(userResponse.headers);
    const missingScopes = REQUIRED_SCOPES.filter(scope => !scopes.includes(scope));
    if (missingScopes.length > 0) {
      throw new Error(
        `GitHub token missing required scopes: ${missingScopes.join(', ')}.`,
      );
    }

    const orgResponse = await this.githubRequest('/user/orgs', token);
    const orgPayload = this.parseJson<Array<{ login?: string }> | { message?: string }>(
      orgResponse.body,
      '/user/orgs',
    );
    const orgNames = Array.isArray(orgPayload)
      ? orgPayload
          .map(org => org.login?.trim())
          .filter((value): value is string => Boolean(value))
      : [];

    return {
      userId,
      username,
      orgNames,
      scopes,
    };
  }

  async syncGitHubIntegrationFromCredentialStore(
    tokenOverride?: string,
    detailsOverride?: GitHubConnectionDetails,
  ): Promise<GitHubConnectionStatus> {
    const token = tokenOverride ?? this.getStoredGitHubToken();
    if (!token) {
      return { available: false, connected: false, requires_token: true };
    }

    const details = detailsOverride ?? await this.fetchGitHubConnectionDetails(token);
    const organization = this.projectManager.getOrganization();
    if (!organization.integrations.github) {
      this.projectManager.addOrganizationIntegration('github');
    }

    const updatedOrganization = this.projectManager.updateOrganizationIntegration('github', {
      status: 'configured',
      notes: `Connected via stored GitHub PAT for ${details.username}. Token metadata is encrypted in credential vault.`,
      config: {
        token_source: 'credential_vault',
        username: details.username,
        owner_default: details.username,
        org_count: String(details.orgNames.length),
        scopes: details.scopes.join(','),
      },
    });

    return {
      available: true,
      connected: true,
      requires_token: false,
      details: {
        username: details.username,
        orgNames: details.orgNames,
        scopes: details.scopes,
      },
      integration: updatedOrganization.integrations.github,
    };
  }

  async connect(token: string): Promise<GitHubConnectionStatus> {
    if (!token || !token.trim()) {
      throw new Error('GitHub token is required.');
    }
    const normalizedToken = token.trim();
    const details = await this.fetchGitHubConnectionDetails(normalizedToken);
    this.storeGitHubToken(normalizedToken);
    this.storeGitHubConnectionDetails(details);
    return this.syncGitHubIntegrationFromCredentialStore(normalizedToken, details);
  }

  disconnect(): GitHubConnectionStatus & { removed: boolean } {
    const removed = this.deleteStoredGitHubToken();
    this.deleteStoredGitHubConnectionDetails();
    const organization = this.projectManager.getOrganization();
    let integration: IntegrationConfigRecord | undefined;

    if (organization.integrations.github) {
      const updated = this.projectManager.updateOrganizationIntegration('github', {
        status: 'pending',
        notes: 'GitHub connection disabled. Reconnect with a PAT to configure this module.',
        config: {},
        replaceConfig: true,
      });
      integration = updated.integrations.github;
    }

    return {
      removed,
      available: false,
      connected: false,
      requires_token: true,
      integration,
    };
  }

  private async githubRequest(pathname: string, token: string): Promise<GitHubApiResponse> {
    return new Promise((resolve, reject) => {
      const request = https.request(
        {
          method: 'GET',
          hostname: 'api.github.com',
          path: pathname,
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'platform-studio',
          },
        },
        (response) => {
          let body = '';
          response.on('data', (chunk: Buffer) => {
            body += chunk.toString();
          });
          response.on('end', () => {
            const statusCode = response.statusCode ?? 0;
            if (statusCode < 200 || statusCode >= 300) {
              const payload = this.parseJson<{ message?: string }>(body, pathname, true);
              const message = payload.message?.trim() || body.trim() || 'Unknown GitHub API error';
              reject(
                new Error(
                  `GitHub API ${pathname} failed (${statusCode}): ${message}`,
                ),
              );
              return;
            }
            resolve({
              statusCode,
              headers: response.headers,
              body,
            });
          });
        },
      );
      request.on('error', (error) => {
        reject(new Error(`GitHub API ${pathname} request failed: ${error.message}`));
      });
      request.end();
    });
  }

  private extractScopes(headers: IncomingHttpHeaders): string[] {
    const raw = headers['x-oauth-scopes'];
    const rawScopes = Array.isArray(raw) ? raw.join(',') : (raw ?? '');
    return rawScopes
      .split(',')
      .map(scope => scope.trim())
      .filter(Boolean);
  }

  private parseJson<T>(raw: string, endpoint: string, allowEmptyObject = false): T {
    const trimmed = raw.trim();
    if (!trimmed) {
      if (allowEmptyObject) {
        return {} as T;
      }
      throw new Error(`GitHub API ${endpoint} returned an empty response.`);
    }
    try {
      return JSON.parse(trimmed) as T;
    } catch (error) {
      throw new Error(
        `GitHub API ${endpoint} returned non-JSON content: ${(error as Error).message}`,
      );
    }
  }

}
