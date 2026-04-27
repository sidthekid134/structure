/**
 * StepHandler for EAS graph nodes — mirrors EasAdapter.executeStep for create and
 * adds Expo-side deletion on plan revert (orchestrator-only runs still use EasAdapter).
 */

import type { StepHandler, StepHandlerContext, StepHandlerResult } from './step-handler-registry.js';
import { ExpoGraphqlEasApiClient } from '../providers/expo-graphql-eas-client.js';
import { projectResourceSlug } from '../studio/project-identity.js';

const STUDIO_EAS_ENV_MARKER = 'STUDIO_EAS_ENV';

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

/**
 * Resolves the Expo app id for the project. Prefers the upstream artifact
 * produced by `eas:create-project`; falls back to a live lookup against Expo
 * (so revert / sync work even when the local plan state is stale).
 */
async function resolveExpoAppId(
  context: StepHandlerContext,
  client: ExpoGraphqlEasApiClient,
): Promise<string | null> {
  const fromUpstream = context.upstreamArtifacts['eas_project_id']?.trim();
  if (fromUpstream) return fromUpstream;
  const projectName = easProjectSlug(context);
  const organization = easOrganization(context);
  return client.getProject(projectName, organization);
}

function projectEnvironments(context: StepHandlerContext): string[] {
  const mod = context.projectManager.getProject(context.projectId);
  return (mod.project.environments ?? []).map((e) => e.trim()).filter((e) => e.length > 0);
}

const configureBuildProfilesHandler: StepHandler = {
  stepKey: 'eas:configure-build-profiles',

  async create(context: StepHandlerContext): Promise<StepHandlerResult> {
    const token = readExpoToken(context);
    if (!token) {
      return {
        reconciled: false,
        message: 'No Expo token in the organization vault. Connect EAS under organization settings first.',
      };
    }
    const client = new ExpoGraphqlEasApiClient(token);
    const expoAppId = await resolveExpoAppId(context, client);
    if (!expoAppId) {
      return {
        reconciled: false,
        message: 'No Expo app found — run "Create EAS Project" first so eas_project_id is recorded.',
      };
    }
    const env = context.environment?.trim();
    if (!env) {
      return {
        reconciled: false,
        message: 'configure-build-profiles is per-environment but no environment was supplied in the step context.',
      };
    }
    await client.ensureStudioEasEnvironmentMarkerOnApp(expoAppId, env);
    return { reconciled: true, resourcesProduced: {} };
  },

  async delete(context: StepHandlerContext): Promise<StepHandlerResult> {
    const token = readExpoToken(context);
    if (!token) {
      return {
        reconciled: false,
        message: 'No Expo token in vault — cannot remove STUDIO_EAS_ENV markers from the Expo app.',
      };
    }
    const client = new ExpoGraphqlEasApiClient(token);
    const expoAppId = await resolveExpoAppId(context, client);
    if (!expoAppId) {
      return {
        reconciled: true,
        message: 'No Expo app found — nothing to delete.',
      };
    }

    // Revert is invoked once per base step (no environment scope), so wipe every
    // STUDIO_EAS_ENV marker on the app regardless of which Expo env slot it is
    // attached to. This also catches stragglers from envs that were removed
    // from the project after provisioning.
    const allMarkers = await client.listAppEnvironmentVariablesByName(expoAppId, STUDIO_EAS_ENV_MARKER);
    for (const v of allMarkers) {
      await client.deleteEnvironmentVariable(v.id);
    }

    if (allMarkers.length === 0) {
      return { reconciled: true, message: 'No STUDIO_EAS_ENV markers were present on the Expo app (already absent).' };
    }
    return {
      reconciled: true,
      message: `Deleted ${allMarkers.length} STUDIO_EAS_ENV marker${allMarkers.length === 1 ? '' : 's'} from the Expo app.`,
    };
  },

  async validate(context: StepHandlerContext): Promise<StepHandlerResult> {
    const token = readExpoToken(context);
    if (!token) {
      return { reconciled: false, message: 'No Expo token in vault.' };
    }
    const client = new ExpoGraphqlEasApiClient(token);
    const expoAppId = await resolveExpoAppId(context, client);
    if (!expoAppId) {
      return { reconciled: false, message: 'No Expo app found for this project.' };
    }
    const env = context.environment?.trim();
    const markers = await client.listAppEnvironmentVariablesByName(expoAppId, STUDIO_EAS_ENV_MARKER);
    if (env) {
      const expoSlot = env.toUpperCase();
      const found = markers.some((m) => (m.environments ?? []).includes(expoSlot));
      if (found) return { reconciled: true, resourcesProduced: {} };
      return { reconciled: false, message: `No STUDIO_EAS_ENV marker found on the Expo ${expoSlot} slot.` };
    }
    // No env scope: at least one marker must exist for any env declared on the project.
    const projectEnvs = projectEnvironments(context).map((e) => e.toUpperCase());
    const found = markers.some((m) => (m.environments ?? []).some((slot) => projectEnvs.includes(slot)));
    if (found) return { reconciled: true, resourcesProduced: {} };
    return { reconciled: false, message: 'No STUDIO_EAS_ENV markers found on the Expo app for any project environment.' };
  },

  async sync(context: StepHandlerContext): Promise<StepHandlerResult | null> {
    return configureBuildProfilesHandler.validate(context);
  },
};

export const EAS_STEP_HANDLERS: StepHandler[] = [
  createEasProjectHandler,
  configureBuildProfilesHandler,
];
