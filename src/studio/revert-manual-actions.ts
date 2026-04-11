/**
 * When automated revert (e.g. Expo API delete) cannot run, the API attaches
 * structured hints so the UI can show links and instructions.
 *
 * The preferred path is for StepHandlers to implement getManualRevertAction().
 * The built-in EAS handler fallback lives here for backward compat.
 */

import type { ProjectManager } from './project-manager.js';
import { projectResourceSlug } from './project-identity.js';
import { globalStepHandlerRegistry } from '../provisioning/step-handler-registry.js';
import type { StepHandlerContext, RevertManualAction } from '../provisioning/step-handler-registry.js';

export type { RevertManualAction };

/** Expo returns this when the token is a robot token that may not call scheduleAppDeletion. */
const EXPO_ROBOT_DELETE_BLOCKED = /robot access to this api is not supported/i;
const EXPO_ACCOUNT_SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/i;

function normalizeExpoAccountSlug(value: string | undefined): string {
  const v = value?.trim() ?? '';
  if (!v) return '';
  return EXPO_ACCOUNT_SLUG_RE.test(v) ? v : '';
}

function pickExpoAccountSlug(candidates: Array<string | undefined>): string {
  for (const candidate of candidates) {
    const normalized = normalizeExpoAccountSlug(candidate);
    if (normalized) return normalized;
  }
  return '';
}

export function expoProjectManualDeleteAction(
  projectManager: ProjectManager,
  studioProjectId: string,
  expoAccountCandidates: string[] = [],
): RevertManualAction {
  const mod = projectManager.getProject(studioProjectId);
  const projectSlug = projectResourceSlug(mod.project);
  const organization = projectManager.getOrganization();
  const account = pickExpoAccountSlug([
    mod.project.easAccount,
    organization.integrations.eas?.config?.['expoAccountSlug'],
    ...expoAccountCandidates,
  ]);
  const primaryUrl =
    account && projectSlug
      ? `https://expo.dev/accounts/${encodeURIComponent(account)}/projects/${encodeURIComponent(projectSlug)}/settings`
      : 'https://expo.dev/accounts';
  return {
    stepKey: 'eas:create-project',
    title: 'Delete the EAS project on expo.dev',
    body:
      'Studio uses an Expo robot token for automation. Expo does not allow robot tokens to delete apps through the API. Sign in to expo.dev with a user account that can manage this project, open the project, and remove it from Settings if you no longer need it.',
    primaryUrl,
    primaryLabel:
      account && projectSlug ? 'Open project settings on expo.dev' : 'Open Expo — pick your account and project',
  };
}

export function appendExpoManualDeleteIfRobotBlocked(
  actions: RevertManualAction[],
  stepKey: string,
  message: string,
  projectManager: ProjectManager,
  studioProjectId: string,
  expoAccountCandidates: string[] = [],
): void {
  if (stepKey !== 'eas:create-project' || !EXPO_ROBOT_DELETE_BLOCKED.test(message)) return;
  if (actions.some((a) => a.stepKey === 'eas:create-project')) return;
  actions.push(expoProjectManualDeleteAction(projectManager, studioProjectId, expoAccountCandidates));
}

/**
 * Generic manual revert action resolver.
 *
 * Calls `stepHandler.getManualRevertAction()` when the handler provides one.
 * Falls back to built-in step-specific logic for known steps.
 * Returns null when no manual action is available.
 */
export async function tryGetManualRevertAction(
  stepKey: string,
  context: StepHandlerContext,
  failureMessage: string,
  projectManager: ProjectManager,
): Promise<RevertManualAction | null> {
  const handler = globalStepHandlerRegistry.get(stepKey);
  if (handler?.getManualRevertAction) {
    const result = handler.getManualRevertAction(context);
    if (result) return result;
  }

  // Built-in fallback for EAS
  if (stepKey === 'eas:create-project' && EXPO_ROBOT_DELETE_BLOCKED.test(failureMessage)) {
    const candidates = [context.upstreamArtifacts['expo_account'] ?? ''];
    return expoProjectManualDeleteAction(projectManager, context.projectId, candidates);
  }

  return null;
}
