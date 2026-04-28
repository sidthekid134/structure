/**
 * CredentialCollectionOrchestrator
 *
 * Identifies which credentials are missing for a given provisioning step type,
 * determines which steps are blocked as a result, and provides the data
 * structure needed to drive the credential collection UI.
 *
 * This orchestrator sits between the provisioning engine and the credential
 * store. It is called by provisioning steps before execution to gate on
 * missing credentials.
 */

import { OrchestrationError } from '../orchestration/error-handler.js';
import type { CredentialService, CredentialType } from './credential-service.js';
import type { ProjectManager } from '../studio/project-manager.js';
import { projectPrimaryDomain } from '../studio/project-identity.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Maps step types to the credential types they require. */
const STEP_CREDENTIAL_REQUIREMENTS: Record<string, CredentialType[]> = {
  'github:create-repo': ['github_pat'],
  'github:configure-branch-protection': ['github_pat'],
  'github:setup-secrets': ['github_pat'],
  'eas:init-project': ['expo_token'],
  'eas:configure-build-profile': ['expo_token'],
  'apple:generate-apns-key': ['apple_team_id'],
  'apple:upload-apns-to-firebase': ['apple_p8', 'apple_team_id'],
  'apple:configure-signing': ['apple_p8', 'apple_team_id'],
  'google-play:configure-app': ['google_play_key'],
  'cloudflare:add-domain-zone': ['cloudflare_token', 'domain_name'],
  'cloudflare:configure-dns': ['cloudflare_token', 'domain_name'],
  'cloudflare:configure-ssl': ['cloudflare_token', 'domain_name'],
};

export interface MissingCredentialInfo {
  type: CredentialType;
  label: string;
  description: string;
  input_type: 'text' | 'file' | 'password';
  file_types?: string[];
  help_url?: string;
}

export interface CollectionResult {
  missing_types: CredentialType[];
  optional_types: CredentialType[];
  blocked_steps: string[];
  missing_info: MissingCredentialInfo[];
}

// ---------------------------------------------------------------------------
// Labels and descriptions for credential types
// ---------------------------------------------------------------------------

const CREDENTIAL_INFO: Record<CredentialType, Omit<MissingCredentialInfo, 'type'>> = {
  github_pat: {
    label: 'GitHub Personal Access Token',
    description: 'Required for creating repos, configuring branch protection, and managing GitHub Actions secrets.',
    input_type: 'password',
    help_url: 'https://github.com/settings/tokens',
  },
  cloudflare_token: {
    label: 'Cloudflare API Token',
    description: 'Required for managing DNS records and SSL/TLS configuration for your domain.',
    input_type: 'password',
    help_url: 'https://dash.cloudflare.com/profile/api-tokens',
  },
  apple_p8: {
    label: 'Apple .p8 Key File',
    description: 'The private key file (.p8) downloaded from Apple Developer Portal. Used for APNs push notifications.',
    input_type: 'file',
    file_types: ['.p8', '.pem'],
    help_url: 'https://developer.apple.com/account/resources/authkeys/list',
  },
  apple_team_id: {
    label: 'Apple Team ID',
    description: 'Your 10-character Apple Developer Team ID (found in Membership settings).',
    input_type: 'text',
    help_url: 'https://developer.apple.com/account#MembershipDetailsCard',
  },
  google_play_key: {
    label: 'Google Play Service Account JSON',
    description: 'JSON key file for a Google Play service account with permissions to manage apps.',
    input_type: 'file',
    file_types: ['.json'],
    help_url: 'https://play.google.com/console/developers/users-and-permissions',
  },
  expo_token: {
    label: 'Expo Access Token',
    description: 'Required for EAS Build and Submit operations.',
    input_type: 'password',
    help_url: 'https://expo.dev/settings/access-tokens',
  },
  domain_name: {
    label: 'Domain Name',
    description:
      'Your app hostname from project settings (or enter app.example.com) for deep links and universal links.',
    input_type: 'text',
  },
  llm_openai_api_key: {
    label: 'OpenAI API Key',
    description:
      'Required to call OpenAI models (GPT-4o, GPT-4o-mini, embeddings, etc.) from this project.',
    input_type: 'password',
    help_url: 'https://platform.openai.com/api-keys',
  },
  llm_anthropic_api_key: {
    label: 'Anthropic API Key',
    description: 'Required to call Anthropic Claude models from this project.',
    input_type: 'password',
    help_url: 'https://console.anthropic.com/settings/keys',
  },
  llm_gemini_api_key: {
    label: 'Google Gemini API Key',
    description: 'Required to call Gemini models via Google AI Studio from this project.',
    input_type: 'password',
    help_url: 'https://aistudio.google.com/app/apikey',
  },
  llm_custom_api_key: {
    label: 'Custom LLM API Key',
    description:
      'Bearer token for an OpenAI-compatible inference endpoint hosted by you (vLLM, TGI, etc.).',
    input_type: 'password',
  },
};

// ---------------------------------------------------------------------------
// CredentialCollectionOrchestrator
// ---------------------------------------------------------------------------

export class CredentialCollectionOrchestrator {
  constructor(
    private readonly credentialService: CredentialService,
    private readonly projectManager: ProjectManager,
  ) {}

  private domainSatisfiedByProject(projectId: string): boolean {
    try {
      return projectPrimaryDomain(this.projectManager.getProject(projectId).project).length > 0;
    } catch {
      return false;
    }
  }

  private cloudflareTokenSatisfiedByOrganization(): boolean {
    try {
      return this.projectManager.getOrganization().integrations.cloudflare?.status === 'configured';
    } catch {
      return false;
    }
  }

  private filterMissingCredentials(projectId: string, missing: CredentialType[]): CredentialType[] {
    let filtered = missing;
    if (this.domainSatisfiedByProject(projectId)) {
      filtered = filtered.filter((t) => t !== 'domain_name');
    }
    if (this.cloudflareTokenSatisfiedByOrganization()) {
      filtered = filtered.filter((t) => t !== 'cloudflare_token');
    }
    return filtered;
  }

  /**
   * Returns which credentials are missing for a given step type,
   * and which steps would be blocked by their absence.
   */
  collectMissingCredentials(projectId: string, stepType: string): CollectionResult {
    const required = STEP_CREDENTIAL_REQUIREMENTS[stepType] ?? [];
    const missing = this.filterMissingCredentials(
      projectId,
      this.credentialService.checkMissingCredentials(projectId, required),
    );

    const blockedSteps = this.getBlockedSteps(projectId, missing);

    const missingInfo: MissingCredentialInfo[] = missing.map((type) => ({
      type,
      ...CREDENTIAL_INFO[type],
    }));

    return {
      missing_types: missing,
      optional_types: [],
      blocked_steps: blockedSteps,
      missing_info: missingInfo,
    };
  }

  /**
   * Called before a provisioning step executes.
   * Throws OrchestrationError if required credentials are missing.
   */
  checkMissingCredentialsForStep(projectId: string, stepType: string): void {
    const required = STEP_CREDENTIAL_REQUIREMENTS[stepType] ?? [];
    if (required.length === 0) return;

    const missing = this.filterMissingCredentials(
      projectId,
      this.credentialService.checkMissingCredentials(projectId, required),
    );
    if (missing.length === 0) return;

    const missingInfo = missing.map((type) => ({
      type,
      label: CREDENTIAL_INFO[type].label,
    }));

    throw new OrchestrationError(
      `Cannot execute step "${stepType}": missing credentials — ${missing.map((t) => CREDENTIAL_INFO[t].label).join(', ')}.`,
      'MISSING_CREDENTIALS',
      {
        project_id: projectId,
        step_type: stepType,
        missing_credentials: missingInfo,
      },
      false,
    );
  }

  /**
   * Returns the list of credential types that have active values for a project.
   */
  getCollectedCredentials(projectId: string): CredentialType[] {
    return this.credentialService
      .listCredentials(projectId)
      .map((c) => c.credential_type);
  }

  /**
   * Returns which step types are blocked because of missing credential types.
   */
  private getBlockedSteps(projectId: string, missingTypes: CredentialType[]): string[] {
    if (missingTypes.length === 0) return [];
    const missingSet = new Set(missingTypes);
    const blocked: string[] = [];

    for (const [stepType, required] of Object.entries(STEP_CREDENTIAL_REQUIREMENTS)) {
      if (required.some((t) => missingSet.has(t))) {
        const stepMissing = this.filterMissingCredentials(
          projectId,
          this.credentialService.checkMissingCredentials(projectId, required),
        );
        if (stepMissing.length > 0) {
          blocked.push(stepType);
        }
      }
    }

    return [...new Set(blocked)];
  }
}
