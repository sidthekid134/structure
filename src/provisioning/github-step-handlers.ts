import { Octokit } from '@octokit/rest';
import type { StepHandler, StepHandlerContext, StepHandlerResult } from './step-handler-registry.js';
import { projectResourceSlug } from '../studio/project-identity.js';
import { HttpGitHubApiClient } from '../providers/github.js';

function readGitHubToken(context: StepHandlerContext): string | undefined {
  return context.vaultManager.getCredential(context.passphrase, 'github', 'token')?.trim();
}

function readExpoToken(context: StepHandlerContext): string | undefined {
  return context.vaultManager.getCredential(context.passphrase, 'eas', 'expo_token')?.trim();
}

function parseGitHubRepoUrl(url: string): { owner: string; repo: string } | null {
  const cleaned = url.trim().replace(/\.git$/i, '');
  const match = cleaned.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\/|$)/i);
  if (!match) return null;
  return { owner: match[1]!, repo: match[2]! };
}

function resolveOwnerRepo(context: StepHandlerContext): { owner: string; repo: string } | null {
  const upstreamUrl = context.upstreamArtifacts['github_repo_url']?.trim();
  if (upstreamUrl) {
    return parseGitHubRepoUrl(upstreamUrl);
  }

  const projectRecord = context.projectManager.getProject(context.projectId);
  const organization = context.projectManager.getOrganization();
  const orgGithubConfig = organization.integrations.github?.config ?? {};
  const owner =
    projectRecord.project.githubOrg?.trim() ||
    orgGithubConfig['owner_default']?.trim() ||
    orgGithubConfig['username']?.trim() ||
    projectRecord.project.slug;
  const repo = projectResourceSlug(projectRecord.project);
  if (!owner || !repo) return null;
  return { owner, repo };
}

function isNotFoundError(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  return status === 404;
}

async function checkRepository(context: StepHandlerContext): Promise<StepHandlerResult> {
  const token = readGitHubToken(context);
  if (!token) {
    return { reconciled: false, message: 'No GitHub token in vault.' };
  }

  const target = resolveOwnerRepo(context);
  if (!target) {
    return {
      reconciled: false,
      message: 'Could not resolve GitHub owner/repo for this project.',
    };
  }

  const octokit = new Octokit({ auth: token });
  try {
    const { data } = await octokit.repos.get({ owner: target.owner, repo: target.repo });
    return {
      reconciled: true,
      resourcesProduced: {
        github_repo_url: (data.html_url ?? `https://github.com/${target.owner}/${target.repo}`).replace(/\/+$/g, ''),
        github_repo_id: String(data.id),
      },
    };
  } catch (err) {
    if (isNotFoundError(err)) {
      return {
        reconciled: false,
        message: `GitHub repository "${target.owner}/${target.repo}" was not found.`,
      };
    }
    throw err;
  }
}

const createRepositoryHandler: StepHandler = {
  stepKey: 'github:create-repository',

  async create(context: StepHandlerContext): Promise<StepHandlerResult> {
    const token = readGitHubToken(context);
    if (!token) {
      return {
        reconciled: false,
        message: 'No GitHub token in the organization vault. Connect GitHub under organization settings first.',
      };
    }

    const target = resolveOwnerRepo(context);
    if (!target) {
      return {
        reconciled: false,
        message: 'Could not resolve GitHub owner/repo for this project.',
      };
    }

    const octokit = new Octokit({ auth: token });
    try {
      const existing = await octokit.repos.get({ owner: target.owner, repo: target.repo });
      return {
        reconciled: true,
        resourcesProduced: {
          github_repo_url: (existing.data.html_url ?? `https://github.com/${target.owner}/${target.repo}`).replace(/\/+$/g, ''),
          github_repo_id: String(existing.data.id),
        },
      };
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }

    try {
      const created = await octokit.repos.createInOrg({
        org: target.owner,
        name: target.repo,
        auto_init: true,
        private: true,
      });
      return {
        reconciled: true,
        resourcesProduced: {
          github_repo_url: (created.data.html_url ?? `https://github.com/${target.owner}/${target.repo}`).replace(/\/+$/g, ''),
          github_repo_id: String(created.data.id),
        },
      };
    } catch {
      const created = await octokit.repos.createForAuthenticatedUser({
        name: target.repo,
        auto_init: true,
        private: true,
      });
      return {
        reconciled: true,
        resourcesProduced: {
          github_repo_url: (created.data.html_url ?? `https://github.com/${target.owner}/${target.repo}`).replace(/\/+$/g, ''),
          github_repo_id: String(created.data.id),
        },
      };
    }
  },

  async delete(context: StepHandlerContext): Promise<StepHandlerResult> {
    const token = readGitHubToken(context);
    if (!token) {
      return {
        reconciled: false,
        message: 'No GitHub token in vault — cannot delete the GitHub repository.',
      };
    }

    const target = resolveOwnerRepo(context);
    if (!target) {
      return {
        reconciled: false,
        message: 'Could not resolve GitHub owner/repo for this project.',
      };
    }

    const octokit = new Octokit({ auth: token });
    try {
      await octokit.repos.delete({ owner: target.owner, repo: target.repo });
      return {
        reconciled: true,
        message: `Deleted GitHub repository "${target.owner}/${target.repo}".`,
      };
    } catch (err) {
      if (isNotFoundError(err)) {
        return {
          reconciled: true,
          message: `GitHub repository "${target.owner}/${target.repo}" was already absent.`,
        };
      }
      throw err;
    }
  },

  async validate(context: StepHandlerContext): Promise<StepHandlerResult> {
    return checkRepository(context);
  },

  async sync(context: StepHandlerContext): Promise<StepHandlerResult | null> {
    return checkRepository(context);
  },
};

const EXPO_TOKEN_SECRET_NAME = 'EXPO_TOKEN';

async function checkExpoTokenSecretExists(context: StepHandlerContext): Promise<StepHandlerResult> {
  const token = readGitHubToken(context);
  if (!token) {
    return { reconciled: false, message: 'No GitHub token in vault.' };
  }

  const target = resolveOwnerRepo(context);
  if (!target) {
    return { reconciled: false, message: 'Could not resolve GitHub owner/repo for this project.' };
  }

  const client = new HttpGitHubApiClient(token);
  const exists = await client.hasRepositorySecret(target.owner, target.repo, EXPO_TOKEN_SECRET_NAME);
  if (exists) {
    return { reconciled: true };
  }
  return {
    reconciled: false,
    message: `GitHub secret "${EXPO_TOKEN_SECRET_NAME}" does not exist on "${target.owner}/${target.repo}".`,
  };
}

const storeEasTokenInGitHubHandler: StepHandler = {
  stepKey: 'eas:store-token-in-github',

  async create(context: StepHandlerContext): Promise<StepHandlerResult> {
    const githubToken = readGitHubToken(context);
    if (!githubToken) {
      return {
        reconciled: false,
        message: 'No GitHub token in the organization vault. Connect GitHub under organization settings first.',
      };
    }

    const target = resolveOwnerRepo(context);
    if (!target) {
      return { reconciled: false, message: 'Could not resolve GitHub owner/repo for this project.' };
    }

    const expoToken =
      context.upstreamArtifacts['expo_token']?.trim() || readExpoToken(context);
    if (!expoToken) {
      return {
        reconciled: false,
        message: 'No Expo robot token available. Connect EAS under organization settings so the token is stored in the vault.',
      };
    }

    const client = new HttpGitHubApiClient(githubToken);
    await client.setRepositorySecret(target.owner, target.repo, EXPO_TOKEN_SECRET_NAME, expoToken);
    return { reconciled: true, resourcesProduced: {} };
  },

  async delete(context: StepHandlerContext): Promise<StepHandlerResult> {
    const token = readGitHubToken(context);
    if (!token) {
      return { reconciled: false, message: 'No GitHub token in vault — cannot remove the GitHub secret.' };
    }

    const target = resolveOwnerRepo(context);
    if (!target) {
      return { reconciled: false, message: 'Could not resolve GitHub owner/repo for this project.' };
    }

    const client = new HttpGitHubApiClient(token);
    await client.deleteRepositorySecret(target.owner, target.repo, EXPO_TOKEN_SECRET_NAME);
    return {
      reconciled: true,
      message: `Removed GitHub secret "${EXPO_TOKEN_SECRET_NAME}" from "${target.owner}/${target.repo}".`,
    };
  },

  async validate(context: StepHandlerContext): Promise<StepHandlerResult> {
    return checkExpoTokenSecretExists(context);
  },

  async sync(context: StepHandlerContext): Promise<StepHandlerResult | null> {
    return checkExpoTokenSecretExists(context);
  },
};

export const GITHUB_STEP_HANDLERS: StepHandler[] = [createRepositoryHandler, storeEasTokenInGitHubHandler];
