/**
 * When automated revert (e.g. Expo API delete) cannot run, the API attaches
 * structured hints so the UI can show links and instructions.
 */

import type { ProjectManager } from './project-manager.js';
import { projectResourceSlug } from './project-identity.js';

export interface RevertManualAction {
  stepKey: string;
  title: string;
  body: string;
  primaryUrl: string;
  primaryLabel: string;
}

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
