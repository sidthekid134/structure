/**
 * StepHandler for EAS graph nodes — mirrors EasAdapter.executeStep for create and
 * adds Expo-side deletion on plan revert (orchestrator-only runs still use EasAdapter).
 */

import type { StepHandler, StepHandlerContext, StepHandlerResult } from './step-handler-registry.js';
import { ExpoGraphqlEasApiClient } from '../providers/expo-graphql-eas-client.js';
import { projectResourceSlug } from '../studio/project-identity.js';

function readExpoToken(context: StepHandlerContext): string | undefined {
  return context.vaultManager.getCredential(context.passphrase, 'eas', 'expo_token');
}

function easProjectSlug(context: StepHandlerContext): string {
  const mod = context.projectManager.getProject(context.projectId);
  return projectResourceSlug(mod.project) || context.projectId;
}

function easOrganization(context: StepHandlerContext): string | undefined {
  const mod = context.projectManager.getProject(context.projectId);
  const slug = mod.project.easAccount?.trim();
  return slug || undefined;
}

/** Live check used by validate, plan/sync, and revalidate. */
async function checkEasProjectExists(context: StepHandlerContext): Promise<StepHandlerResult> {
  const token = readExpoToken(context);
  if (!token) {
    return { reconciled: false, message: 'No Expo token in vault.' };
  }
  const client = new ExpoGraphqlEasApiClient(token);
  const projectName = easProjectSlug(context);
  const organization = easOrganization(context);
  const id = await client.getProject(projectName, organization);
  if (!id) {
    return { reconciled: false, message: 'No Expo app found for this project slug on the connected account.' };
  }
  return { reconciled: true, resourcesProduced: { eas_project_id: id } };
}

const createEasProjectHandler: StepHandler = {
  stepKey: 'eas:create-project',

  async create(context: StepHandlerContext): Promise<StepHandlerResult> {
    const token = readExpoToken(context);
    if (!token) {
      return {
        reconciled: false,
        message: 'No Expo token in the organization vault. Connect EAS under organization settings first.',
      };
    }
    const client = new ExpoGraphqlEasApiClient(token);
    const projectName = easProjectSlug(context);
    const organization = easOrganization(context);
    const existing = await client.getProject(projectName, organization);
    const projectId = existing ?? (await client.createProject(projectName, organization));
    return { reconciled: true, resourcesProduced: { eas_project_id: projectId } };
  },

  async delete(context: StepHandlerContext): Promise<StepHandlerResult> {
    const token = readExpoToken(context);
    if (!token) {
      return {
        reconciled: false,
        message: 'No Expo token in vault — cannot delete the Expo project from Expo servers.',
      };
    }
    const expoAppId = context.upstreamArtifacts['eas_project_id']?.trim();
    if (!expoAppId) {
      return { reconciled: true, message: 'No EAS project id recorded — nothing to delete on Expo.' };
    }
    const client = new ExpoGraphqlEasApiClient(token);
    await client.deleteProject(expoAppId);
    return { reconciled: true, message: 'Scheduled deletion of the Expo app / EAS project on expo.dev.' };
  },

  async validate(context: StepHandlerContext): Promise<StepHandlerResult> {
    return checkEasProjectExists(context);
  },

  async sync(context: StepHandlerContext): Promise<StepHandlerResult | null> {
    return checkEasProjectExists(context);
  },
};

export const EAS_STEP_HANDLERS: StepHandler[] = [createEasProjectHandler];
