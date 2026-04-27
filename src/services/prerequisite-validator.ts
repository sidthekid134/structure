/**
 * Prerequisite Validator
 *
 * Validates that required modules or integrations are completed before
 * allowing dependent provisioning steps to proceed.
 *
 * Used at API endpoints to return 409 Conflict when prerequisites are missing,
 * giving users clear instructions on what to complete first.
 */

import { OrchestrationError } from '../orchestration/error-handler.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RequiredModule =
  | 'firebase-core'
  | 'firebase-auth'
  | 'apple-signing'
  | 'google-play-publishing'
  | 'cloudflare-domain'
  | 'github-repo'
  | 'eas-builds'
  | 'oauth-social';

export interface ModuleCompletionStatus {
  module: RequiredModule;
  completed: boolean;
  reason?: string;
}

export interface PrerequisiteValidationResult {
  valid: boolean;
  missing_modules: RequiredModule[];
  message: string;
  instructions: string[];
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

/**
 * Checks whether a set of required modules are completed for a project.
 *
 * `getModuleStatus` is injected so callers can provide project-specific
 * completion logic without coupling this service to a specific data store.
 *
 * Returns a validation result; throws OrchestrationError when any required
 * module is incomplete.
 */
export function validatePrerequisites(
  projectId: string,
  requiredModules: RequiredModule[],
  getModuleStatus: (projectId: string, module: RequiredModule) => boolean,
): PrerequisiteValidationResult {
  const missing: RequiredModule[] = [];

  for (const mod of requiredModules) {
    if (!getModuleStatus(projectId, mod)) {
      missing.push(mod);
    }
  }

  if (missing.length === 0) {
    return {
      valid: true,
      missing_modules: [],
      message: 'All prerequisites are satisfied.',
      instructions: [],
    };
  }

  const instructions = missing.map((mod) => getModuleInstruction(mod));

  const result: PrerequisiteValidationResult = {
    valid: false,
    missing_modules: missing,
    message: `The following required modules must be completed first: ${missing.join(', ')}.`,
    instructions,
  };

  return result;
}

/**
 * Same as validatePrerequisites, but throws an OrchestrationError when
 * prerequisites are not met (for use in provisioning orchestration).
 */
export function requirePrerequisites(
  projectId: string,
  requiredModules: RequiredModule[],
  getModuleStatus: (projectId: string, module: RequiredModule) => boolean,
): void {
  const result = validatePrerequisites(projectId, requiredModules, getModuleStatus);
  if (!result.valid) {
    throw new OrchestrationError(
      result.message,
      'PREREQUISITE_NOT_MET',
      {
        project_id: projectId,
        missing_modules: result.missing_modules,
        instructions: result.instructions,
      },
      false,
    );
  }
}

// ---------------------------------------------------------------------------
// Module instructions
// ---------------------------------------------------------------------------

function getModuleInstruction(module: RequiredModule): string {
  const instructions: Record<RequiredModule, string> = {
    'firebase-core':
      'Complete GCP Core setup: connect a GCP project via "Connect with Google" and run the provisioning steps.',
    'firebase-auth':
      'Enable Firebase Auth: go to the Firebase Auth tab and enable Identity Toolkit.',
    'apple-signing':
      'Complete Apple Signing setup: enroll in the Apple Developer Program and upload your .p8 key.',
    'google-play-publishing':
      'Complete Google Play setup: create a Google Play Developer account and upload a service account JSON key.',
    'cloudflare-domain':
      'Configure Cloudflare Domain: connect a Cloudflare account and set up DNS for your domain.',
    'github-repo':
      'Connect GitHub: add a GitHub PAT with repo and workflow scopes in the Integrations panel.',
    'eas-builds':
      'Configure EAS Builds: add your Expo token and ensure the EAS project is linked.',
    'oauth-social':
      'Configure OAuth Social providers: complete Firebase Auth setup and configure Google/Apple OAuth clients.',
  };
  return instructions[module] ?? `Complete the "${module}" module before proceeding.`;
}
