/**
 * StepHandler for EAS graph nodes — mirrors EasAdapter.executeStep for create and
 * adds Expo-side deletion on plan revert (orchestrator-only runs still use EasAdapter).
 */

import type { StepHandler, StepHandlerContext, StepHandlerResult } from './step-handler-registry.js';
import type { CredentialType } from '../services/credential-service.js';
import { ExpoGraphqlEasApiClient } from '../providers/expo-graphql-eas-client.js';
import { projectResourceSlug } from '../studio/project-identity.js';
import {
  downloadFirebaseAndroidAppConfig,
  downloadFirebaseIosAppConfig,
} from '../core/gcp/gcp-api-client.js';
import {
  extractFirebaseApiKeyFromAndroidConfig,
  extractFirebaseApiKeyFromIosConfig,
  LLM_KIND_MODULE_IDS,
  PROJECT_LLM_RUNTIME_ENV_KEYS,
  PROJECT_LLM_RUNTIME_ENV_SECRET_TYPES,
  PROJECT_RUNTIME_ENV_KEYS,
  PROJECT_RUNTIME_ENV_SECRET_TYPES,
  resolveProjectLlmRuntimeEnvValues,
  resolveProjectRuntimeEnvValues,
  type ProjectLlmRuntimeEnvResolveInput,
} from './runtime-env.js';

function selectedLlmModuleIdsFromPlan(context: StepHandlerContext): string[] | undefined {
  const raw = context.projectManager.loadPlan(context.projectId)?.selectedModules;
  if (raw === undefined) return undefined;
  const llm = raw.filter((id) => (LLM_KIND_MODULE_IDS as readonly string[]).includes(id));
  return llm;
}

function llmResolveCredentialOpts(
  context: StepHandlerContext,
): Pick<ProjectLlmRuntimeEnvResolveInput, 'readVault' | 'retrieveProjectCredential'> {
  const cs = context.credentialService;
  return {
    readVault: (providerId, key) => context.vaultManager.getCredential(context.passphrase, providerId, key),
    retrieveProjectCredential: cs
      ? (type: CredentialType) => cs.retrieveCredential(context.projectId, type)
      : undefined,
  };
}

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

function studioEnvToExpoSlot(env: string): string {
  const normalized = env.trim().toLowerCase();
  if (normalized === 'development') return 'DEVELOPMENT';
  if (normalized === 'preview') return 'PREVIEW';
  if (normalized === 'production') return 'PRODUCTION';
  throw new Error(`Unsupported Studio environment "${env}".`);
}

function envSlotPresent(
  environments: string[] | null | undefined,
  slot: string,
): boolean {
  const wanted = slot.trim().toUpperCase();
  return (environments ?? []).some((env) => env.trim().toUpperCase() === wanted);
}

async function deriveFirebaseApiKey(context: StepHandlerContext): Promise<string> {
  const gcpProjectId =
    context.upstreamArtifacts['firebase_project_id']?.trim() ||
    context.upstreamArtifacts['gcp_project_id']?.trim() ||
    '';
  const androidAppId = context.upstreamArtifacts['firebase_android_app_id']?.trim() || '';
  const iosAppId = context.upstreamArtifacts['firebase_ios_app_id']?.trim() || '';
  if (!gcpProjectId) {
    throw new Error('Missing firebase_project_id/gcp_project_id in upstream artifacts.');
  }
  if (!androidAppId && !iosAppId) {
    throw new Error('Cannot derive Firebase API key: no firebase_android_app_id or firebase_ios_app_id found.');
  }
  const accessToken = await context.getToken('gcp');
  if (androidAppId) {
    const androidConfig = await downloadFirebaseAndroidAppConfig(accessToken, gcpProjectId, androidAppId);
    const androidKey = extractFirebaseApiKeyFromAndroidConfig(androidConfig)?.trim() ?? '';
    if (androidKey) return androidKey;
  }
  if (iosAppId) {
    const iosConfig = await downloadFirebaseIosAppConfig(accessToken, gcpProjectId, iosAppId);
    const iosKey = extractFirebaseApiKeyFromIosConfig(iosConfig)?.trim() ?? '';
    if (iosKey) return iosKey;
  }
  throw new Error(`Unable to extract Firebase API key from Firebase app configs on project "${gcpProjectId}".`);
}

function runtimeEnvMap(
  context: StepHandlerContext,
  firebaseApiKey: string,
): { values: Record<string, string>; missingRequiredKeys: string[] } {
  const mod = context.projectManager.getProject(context.projectId);
  const platforms = mod.project.platforms ?? [];
  return resolveProjectRuntimeEnvValues({
    projectId: context.projectId,
    upstream: context.upstreamArtifacts,
    readVault: (providerId, key) => context.vaultManager.getCredential(context.passphrase, providerId, key),
    firebaseApiKeyOverride: firebaseApiKey,
    includesIos: platforms.includes('ios'),
    includesAndroid: platforms.includes('android'),
  });
}

function buildRuntimeEnvResourcesProduced(
  runtimeValues: Record<string, string>,
  firebaseApiKey: string,
): Record<string, string> {
  const out: Record<string, string> = { firebase_api_key: firebaseApiKey };
  const mapping: Array<[sourceKey: string, producedKey: string]> = [
    ['FIREBASE_PROJECT_ID', 'eas_env_firebase_project_id'],
    ['FIREBASE_IOS_APP_ID', 'eas_env_firebase_ios_app_id'],
    ['FIREBASE_ANDROID_APP_ID', 'eas_env_firebase_android_app_id'],
    ['GOOGLE_WEB_CLIENT_ID', 'eas_env_google_web_client_id'],
    ['GOOGLE_IOS_CLIENT_ID', 'eas_env_google_ios_client_id'],
    ['GOOGLE_ANDROID_CLIENT_ID', 'eas_env_google_android_client_id'],
    ['APPLE_SERVICE_ID', 'eas_env_apple_service_id'],
    ['AUTH_DEEP_LINK_BASE_URL', 'eas_env_auth_deep_link_base_url'],
    ['AUTH_LANDING_URL', 'eas_env_auth_landing_url'],
  ];
  for (const [sourceKey, producedKey] of mapping) {
    const value = runtimeValues[sourceKey]?.trim() ?? '';
    if (value) out[producedKey] = value;
  }
  return out;
}

function buildLlmRuntimeEnvResourcesProduced(llmValues: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const mapping: Array<[sourceKey: string, producedKey: string]> = [
    ['LLM_OPENAI_API_KEY', 'eas_env_llm_openai_api_key'],
    ['LLM_OPENAI_ORGANIZATION_ID', 'eas_env_llm_openai_organization_id'],
    ['LLM_OPENAI_DEFAULT_MODEL', 'eas_env_llm_openai_default_model'],
    ['LLM_ANTHROPIC_API_KEY', 'eas_env_llm_anthropic_api_key'],
    ['LLM_ANTHROPIC_DEFAULT_MODEL', 'eas_env_llm_anthropic_default_model'],
    ['LLM_GEMINI_API_KEY', 'eas_env_llm_gemini_api_key'],
    ['LLM_GEMINI_DEFAULT_MODEL', 'eas_env_llm_gemini_default_model'],
    ['LLM_CUSTOM_API_KEY', 'eas_env_llm_custom_api_key'],
    ['LLM_CUSTOM_BASE_URL', 'eas_env_llm_custom_base_url'],
    ['LLM_CUSTOM_DEFAULT_MODEL', 'eas_env_llm_custom_default_model'],
  ];
  for (const [sourceKey, producedKey] of mapping) {
    const value = llmValues[sourceKey]?.trim() ?? '';
    if (value) out[producedKey] = value;
  }
  return out;
}

function isNonPublicRuntimeEnvKey(name: string): boolean {
  if (!PROJECT_RUNTIME_ENV_KEYS.includes(name as (typeof PROJECT_RUNTIME_ENV_KEYS)[number])) {
    return false;
  }
  const visibility = PROJECT_RUNTIME_ENV_SECRET_TYPES[name as keyof typeof PROJECT_RUNTIME_ENV_SECRET_TYPES];
  return visibility === 'SENSITIVE' || visibility === 'SECRET';
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

const syncRuntimeEnvHandler: StepHandler = {
  stepKey: 'eas:sync-runtime-env',
  requiredAuth: 'gcp',

  async create(context: StepHandlerContext): Promise<StepHandlerResult> {
    const token = readExpoToken(context);
    if (!token) {
      return {
        reconciled: false,
        message: 'No Expo token in the organization vault. Connect EAS under organization settings first.',
      };
    }
    const env = context.environment?.trim();
    if (!env) {
      return {
        reconciled: false,
        message: 'sync-runtime-env is per-environment but no environment was supplied in the step context.',
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
    const firebaseApiKey = context.upstreamArtifacts['firebase_api_key']?.trim() || await deriveFirebaseApiKey(context);
    const runtime = runtimeEnvMap(context, firebaseApiKey);
    if (runtime.missingRequiredKeys.length > 0) {
      return {
        reconciled: false,
        message: `Missing required runtime env keys: ${runtime.missingRequiredKeys.join(', ')}.`,
      };
    }
    const targetEnvironments = projectEnvironments(context);
    const envTargets = targetEnvironments.length > 0 ? targetEnvironments : [env];
    let upserted = 0;
    let removed = 0;
    for (const [name, value] of Object.entries(runtime.values)) {
      const trimmed = value.trim();
      const visibility =
        PROJECT_RUNTIME_ENV_SECRET_TYPES[name as keyof typeof PROJECT_RUNTIME_ENV_SECRET_TYPES] ??
        'PUBLIC';
      await client.reconcileAppEnvironmentVariableAcrossStudioEnvironments(
        expoAppId,
        name,
        value,
        visibility,
        envTargets,
      );
      if (trimmed) upserted += 1;
      else removed += 1;
    }
    return {
      reconciled: true,
      resourcesProduced: buildRuntimeEnvResourcesProduced(runtime.values, firebaseApiKey),
      message: `Synced runtime env for "${env}": ${upserted} upserted, ${removed} removed.`,
    };
  },

  async delete(context: StepHandlerContext): Promise<StepHandlerResult> {
    const token = readExpoToken(context);
    if (!token) {
      return {
        reconciled: false,
        message: 'No Expo token in vault — cannot remove runtime env vars from the Expo app.',
      };
    }
    const env = context.environment?.trim();
    if (!env) {
      return {
        reconciled: false,
        message: 'Runtime env cleanup needs an environment scope.',
      };
    }
    const client = new ExpoGraphqlEasApiClient(token);
    const expoAppId = await resolveExpoAppId(context, client);
    if (!expoAppId) {
      return { reconciled: true, message: 'No Expo app found — nothing to delete.' };
    }
    const firebaseApiKey = context.upstreamArtifacts['firebase_api_key']?.trim() || '';
    const runtime = runtimeEnvMap(context, firebaseApiKey);
    let removed = 0;
    for (const name of Object.keys(runtime.values)) {
      removed += await client.removeAppEnvironmentVariableFromStudioEnvironment(expoAppId, env, name);
    }
    return {
      reconciled: true,
      message: removed === 0
        ? `No runtime env vars were present on EAS "${env}".`
        : `Removed ${removed} runtime env var(s) from EAS "${env}".`,
    };
  },

  async validate(context: StepHandlerContext): Promise<StepHandlerResult> {
    const token = readExpoToken(context);
    if (!token) {
      return { reconciled: false, message: 'No Expo token in vault.' };
    }
    const env = context.environment?.trim();
    if (!env) {
      return { reconciled: false, message: 'Runtime env validation needs an environment scope.' };
    }
    const client = new ExpoGraphqlEasApiClient(token);
    const expoAppId = await resolveExpoAppId(context, client);
    if (!expoAppId) {
      return { reconciled: false, message: 'No Expo app found for this project.' };
    }
    const firebaseApiKey = context.upstreamArtifacts['firebase_api_key']?.trim() || await deriveFirebaseApiKey(context);
    const runtime = runtimeEnvMap(context, firebaseApiKey);
    if (runtime.missingRequiredKeys.length > 0) {
      return {
        reconciled: false,
        message: `Runtime env prerequisites missing: ${runtime.missingRequiredKeys.join(', ')}.`,
      };
    }
    const expected = Object.entries(runtime.values);
    const vars = await client.listAppEnvironmentVariablesByNames(
      expoAppId,
      expected.map(([name]) => name),
    );
    const expoSlot = studioEnvToExpoSlot(env);
    const mismatched = expected.filter(([name, value]) => {
      const normalized = value.trim();
      const slotVars = vars.filter(
        (v) =>
          v.name === name &&
          envSlotPresent(v.environments, expoSlot),
      );
      if (!normalized) {
        return slotVars.length > 0;
      }
      if (isNonPublicRuntimeEnvKey(name)) {
        // Non-public values can be masked on readback; validate by existence.
        return slotVars.length === 0;
      }
      const exact = slotVars.find((v) => (v.value?.trim() ?? '') === normalized);
      return !exact;
    });
    if (mismatched.length > 0) {
      return {
        reconciled: false,
        message:
          `EAS runtime env is not reconciled on "${env}": ` +
          `${mismatched.map(([key]) => key).join(', ')}.`,
      };
    }
    return {
      reconciled: true,
      resourcesProduced: buildRuntimeEnvResourcesProduced(runtime.values, firebaseApiKey),
    };
  },

  async sync(context: StepHandlerContext): Promise<StepHandlerResult | null> {
    return syncRuntimeEnvHandler.validate(context);
  },
};

const syncLlmSecretsHandler: StepHandler = {
  stepKey: 'eas:sync-llm-secrets',

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
    const llm = resolveProjectLlmRuntimeEnvValues({
      ...llmResolveCredentialOpts(context),
      upstream: context.upstreamArtifacts,
      selectedLlmModuleIds: selectedLlmModuleIdsFromPlan(context),
    });
    const targetEnvironments = projectEnvironments(context);
    const envTargets = targetEnvironments.length > 0 ? targetEnvironments : ['development'];
    let upserted = 0;
    let removed = 0;
    for (const [name, value] of Object.entries(llm.values)) {
      const visibility =
        PROJECT_LLM_RUNTIME_ENV_SECRET_TYPES[
          name as keyof typeof PROJECT_LLM_RUNTIME_ENV_SECRET_TYPES
        ] ?? 'PUBLIC';
      await client.reconcileAppEnvironmentVariableAcrossStudioEnvironments(
        expoAppId,
        name,
        value,
        visibility,
        envTargets,
      );
      if (value.trim()) upserted += 1;
      else removed += 1;
    }
    return {
      reconciled: true,
      resourcesProduced: buildLlmRuntimeEnvResourcesProduced(llm.values),
      message: `Synced LLM env vars to EAS: ${upserted} upserted, ${removed} removed.`,
    };
  },

  async delete(context: StepHandlerContext): Promise<StepHandlerResult> {
    const token = readExpoToken(context);
    if (!token) {
      return {
        reconciled: false,
        message: 'No Expo token in vault — cannot remove LLM env vars from the Expo app.',
      };
    }
    const client = new ExpoGraphqlEasApiClient(token);
    const expoAppId = await resolveExpoAppId(context, client);
    if (!expoAppId) {
      return { reconciled: true, message: 'No Expo app found — nothing to delete.' };
    }
    const envTargets = projectEnvironments(context);
    const targets = envTargets.length > 0 ? envTargets : ['development'];
    let removed = 0;
    for (const env of targets) {
      for (const key of PROJECT_LLM_RUNTIME_ENV_KEYS) {
        removed += await client.removeAppEnvironmentVariableFromStudioEnvironment(expoAppId, env, key);
      }
    }
    return {
      reconciled: true,
      message:
        removed === 0
          ? 'No LLM env vars were present on EAS.'
          : `Removed ${removed} LLM env var(s) from EAS.`,
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
    const llm = resolveProjectLlmRuntimeEnvValues({
      ...llmResolveCredentialOpts(context),
      upstream: context.upstreamArtifacts,
      selectedLlmModuleIds: selectedLlmModuleIdsFromPlan(context),
    });
    const expected = Object.entries(llm.values).filter(([, value]) => value.trim().length > 0);
    if (expected.length === 0) {
      return { reconciled: true, resourcesProduced: {} };
    }
    const vars = await client.listAppEnvironmentVariablesByNames(
      expoAppId,
      expected.map(([name]) => name),
    );
    const projectSlots = projectEnvironments(context).map((e) => studioEnvToExpoSlot(e));
    const mismatched = expected.filter(([name]) => {
      const matching = vars.filter((v) => v.name === name);
      // Secret values can be masked in readback, so existence in each target slot is enough.
      return projectSlots.some((slot) => !matching.some((v) => envSlotPresent(v.environments, slot)));
    });
    if (mismatched.length > 0) {
      return {
        reconciled: false,
        message: `EAS LLM env is not reconciled: ${mismatched.map(([k]) => k).join(', ')}.`,
      };
    }
    return {
      reconciled: true,
      resourcesProduced: buildLlmRuntimeEnvResourcesProduced(llm.values),
    };
  },

  async sync(context: StepHandlerContext): Promise<StepHandlerResult | null> {
    return syncLlmSecretsHandler.validate(context);
  },
};

export const EAS_STEP_HANDLERS: StepHandler[] = [
  createEasProjectHandler,
  configureBuildProfilesHandler,
  syncRuntimeEnvHandler,
  syncLlmSecretsHandler,
];
