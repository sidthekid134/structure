import type { ProvisioningStepNode } from '../graph.types.js';
import {
  PROJECT_RUNTIME_ENV_SECRET_TYPES,
  PROJECT_RUNTIME_ENV_KEYS,
  PROJECT_LLM_RUNTIME_ENV_KEYS,
} from '../runtime-env.js';

export const EAS_STEPS: ProvisioningStepNode[] = [
  {
    type: 'step',
    key: 'eas:create-project',
    label: 'Create EAS Project',
    description: 'Create or link the Expo Application Services project.',
    provider: 'eas',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'user:provide-expo-token', required: true }],
    produces: [
      {
        key: 'eas_project_id',
        label: 'EAS Project ID',
        description: 'Expo project identifier',
      },
      {
        key: 'expo_account',
        label: 'Expo Account Slug',
        description: 'Expo organization / account slug owning the EAS project (when set).',
      },
      {
        key: 'eas_project_slug',
        label: 'EAS Project Slug',
        description: 'Project slug used in expo.dev URLs (matches manifest project_name).',
      },
    ],
    estimatedDurationMs: 5000,
  },
  {
    type: 'step',
    key: 'eas:configure-build-profiles',
    label: 'Configure Build Profiles',
    description:
      'Registers each Studio environment on the Expo app as an EAS env-var slot (marker variable). You must still edit eas.json in your repository for real build profile names, settings, and credentials.',
    provider: 'eas',
    environmentScope: 'per-environment',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'eas:create-project', required: true }],
    produces: [],
    estimatedDurationMs: 3000,
  },
  {
    type: 'step',
    key: 'eas:sync-runtime-env',
    label: 'Sync Firebase/Auth Runtime Env to EAS',
    description:
      'Writes Firebase/Auth runtime environment variables (for example FIREBASE_API_KEY, project/app IDs, and OAuth client IDs when present) to the Expo app for this Studio environment.',
    provider: 'eas',
    environmentScope: 'per-environment',
    automationLevel: 'full',
    dependencies: [
      { nodeKey: 'eas:create-project', required: true },
      { nodeKey: 'firebase:enable-firebase', required: true },
      { nodeKey: 'firebase:register-ios-app', required: false },
      { nodeKey: 'firebase:register-android-app', required: false },
      { nodeKey: 'oauth:enable-google-sign-in', required: false },
      { nodeKey: 'oauth:register-oauth-client-web', required: false },
      { nodeKey: 'oauth:register-oauth-client-ios', required: false },
      { nodeKey: 'oauth:register-oauth-client-android', required: false },
      { nodeKey: 'oauth:configure-apple-sign-in', required: false },
      { nodeKey: 'oauth:link-deep-link-domain', required: false },
    ],
    produces: [
      {
        key: 'firebase_api_key',
        label: 'FIREBASE_API_KEY',
        description: 'Firebase Web API key resolved from Firebase app config.',
        presentation: {
          sensitive: true,
          destinationType: 'Expo EAS environment variable',
          secretType: PROJECT_RUNTIME_ENV_SECRET_TYPES['FIREBASE_API_KEY'],
          writeBehavior: 'Upsert (overwrite existing value)',
        },
      },
      {
        key: 'eas_env_firebase_project_id',
        label: 'FIREBASE_PROJECT_ID',
        description: 'Firebase project identifier.',
        presentation: {
          destinationType: 'Expo EAS environment variable',
          secretType: PROJECT_RUNTIME_ENV_SECRET_TYPES['FIREBASE_PROJECT_ID'],
          writeBehavior: 'Upsert (overwrite existing value)',
        },
      },
      {
        key: 'eas_env_firebase_ios_app_id',
        label: 'FIREBASE_IOS_APP_ID',
        description: 'Firebase iOS app identifier (when iOS app registration exists).',
        presentation: {
          destinationType: 'Expo EAS environment variable',
          secretType: PROJECT_RUNTIME_ENV_SECRET_TYPES['FIREBASE_IOS_APP_ID'],
          writeBehavior: 'Upsert (overwrite existing value)',
        },
      },
      {
        key: 'eas_env_firebase_android_app_id',
        label: 'FIREBASE_ANDROID_APP_ID',
        description: 'Firebase Android app identifier (when Android app registration exists).',
        presentation: {
          destinationType: 'Expo EAS environment variable',
          secretType: PROJECT_RUNTIME_ENV_SECRET_TYPES['FIREBASE_ANDROID_APP_ID'],
          writeBehavior: 'Upsert (overwrite existing value)',
        },
      },
      {
        key: 'eas_env_google_web_client_id',
        label: 'GOOGLE_WEB_CLIENT_ID',
        description: 'Google OAuth web client ID (when Google OAuth is configured).',
        presentation: {
          destinationType: 'Expo EAS environment variable',
          secretType: PROJECT_RUNTIME_ENV_SECRET_TYPES['GOOGLE_WEB_CLIENT_ID'],
          writeBehavior: 'Upsert (overwrite existing value)',
        },
      },
      {
        key: 'eas_env_google_ios_client_id',
        label: 'GOOGLE_IOS_CLIENT_ID',
        description: 'Google OAuth iOS client ID (when iOS OAuth client exists).',
        presentation: {
          destinationType: 'Expo EAS environment variable',
          secretType: PROJECT_RUNTIME_ENV_SECRET_TYPES['GOOGLE_IOS_CLIENT_ID'],
          writeBehavior: 'Upsert (overwrite existing value)',
        },
      },
      {
        key: 'eas_env_google_android_client_id',
        label: 'GOOGLE_ANDROID_CLIENT_ID',
        description: 'Google OAuth Android client ID (when Android OAuth client exists).',
        presentation: {
          destinationType: 'Expo EAS environment variable',
          secretType: PROJECT_RUNTIME_ENV_SECRET_TYPES['GOOGLE_ANDROID_CLIENT_ID'],
          writeBehavior: 'Upsert (overwrite existing value)',
        },
      },
      {
        key: 'eas_env_apple_service_id',
        label: 'APPLE_SERVICE_ID',
        description: 'Apple Sign-In service ID (when configured).',
        presentation: {
          destinationType: 'Expo EAS environment variable',
          secretType: PROJECT_RUNTIME_ENV_SECRET_TYPES['APPLE_SERVICE_ID'],
          writeBehavior: 'Upsert (overwrite existing value)',
        },
      },
      {
        key: 'eas_env_auth_deep_link_base_url',
        label: 'AUTH_DEEP_LINK_BASE_URL',
        description: 'Deep-link base URL (when configured).',
        presentation: {
          destinationType: 'Expo EAS environment variable',
          secretType: PROJECT_RUNTIME_ENV_SECRET_TYPES['AUTH_DEEP_LINK_BASE_URL'],
          writeBehavior: 'Upsert (overwrite existing value)',
        },
      },
      {
        key: 'eas_env_auth_landing_url',
        label: 'AUTH_LANDING_URL',
        description: 'Auth landing URL (when configured).',
        presentation: {
          destinationType: 'Expo EAS environment variable',
          secretType: PROJECT_RUNTIME_ENV_SECRET_TYPES['AUTH_LANDING_URL'],
          writeBehavior: 'Upsert (overwrite existing value)',
        },
      },
    ],
    managedEnvKeys: [...PROJECT_RUNTIME_ENV_KEYS],
    estimatedDurationMs: 6000,
  },
  {
    type: 'step',
    key: 'eas:sync-llm-secrets',
    label: 'Sync LLM Secrets to EAS',
    description:
      'Mirrors LLM_* environment variables to the linked Expo app (per EAS env slot for this Studio environment). Only modules you added under Modules (e.g. llm-openai, llm-gemini) are written; other providers’ LLM_* names are cleared so Expo does not keep stale keys. API keys, optional org/base URL, and default models come from the vault and credential gate.',
    provider: 'eas',
    environmentScope: 'per-environment',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'eas:create-project', required: true }],
    refreshTriggers: [
      // Re-sync Expo env vars whenever any LLM credential gate is re-submitted.
      'user:provide-openai-api-key',
      'user:provide-anthropic-api-key',
      'user:provide-gemini-api-key',
      'user:provide-custom-llm-credentials',
    ],
    produces: [
      {
        key: 'eas_llm_env_sync_snapshot',
        label: 'LLM variables on Expo (selected modules)',
        description:
          'Upserts or clears each listed Expo environment variable by name for whichever llm-* modules are in your project plan.',
        presentation: {
          destinationType: 'Expo EAS environment variables',
          writeBehavior: 'Upsert or clear per key (clear when module not selected)',
        },
      },
    ],
    managedEnvKeys: [...PROJECT_LLM_RUNTIME_ENV_KEYS],
    estimatedDurationMs: 6000,
  },
  {
    type: 'step',
    key: 'eas:store-token-in-github',
    label: 'Store Expo Token in GitHub',
    description:
      'Creates or updates the EXPO_TOKEN repository-level secret on the linked GitHub repo. Repository scope (not environment) so every workflow job — including jobs that don\'t declare `environment:` — can read it via ${{ secrets.EXPO_TOKEN }}. Same value applies to every env, so a single repo-level secret avoids per-env drift after token rotation.',
    provider: 'eas',
    environmentScope: 'global',
    automationLevel: 'full',
    bridgeTarget: 'github',
    dependencies: [
      { nodeKey: 'eas:create-project', required: true },
      { nodeKey: 'github:create-repository', required: true },
    ],
    produces: [],
    estimatedDurationMs: 3000,
  },
  {
    type: 'step',
    key: 'eas:write-eas-json',
    label: 'Commit eas.json to Repo',
    description:
      'Commits a production-shaped `eas.json` (production profile holds the real iOS/Android settings; development/preview extend it) and wires `submit.production.ios` with the App Store Connect app id and Apple team id when those upstream resources exist. If `app.json` is present and there is no `app.config.ts/js` overriding it, also patches `expo.extra.eas.projectId`. Existing `eas.json` is left untouched so manual edits are preserved.',
    provider: 'eas',
    environmentScope: 'global',
    automationLevel: 'full',
    bridgeTarget: 'github',
    dependencies: [
      { nodeKey: 'eas:create-project', required: true },
      { nodeKey: 'github:create-repository', required: true },
    ],
    produces: [
      {
        key: 'eas_json_path',
        label: 'eas.json path',
        description: 'Repo-relative path of the committed eas.json (always `eas.json`).',
      },
    ],
    estimatedDurationMs: 5000,
  },
  {
    type: 'step',
    key: 'eas:configure-submit-apple',
    label: 'Configure EAS Submit (Apple)',
    description:
      'Uploads the App Store Connect API key to Expo and attaches it to this app for EAS Submit. Requires Issuer ID, Key ID, and .p8 in the vault; you still need eas.json submit config and valid iOS app identifiers in Expo.',
    provider: 'eas',
    environmentScope: 'global',
    automationLevel: 'full',
    bridgeTarget: 'apple',
    platforms: ['ios'],
    dependencies: [
      { nodeKey: 'eas:create-project', required: true },
      {
        nodeKey: 'apple:create-app-store-listing',
        required: true,
        description: 'ASC listing must exist before EAS Submit can target it; ASC API credentials come from the org-level Apple integration.',
      },
    ],
    produces: [],
    estimatedDurationMs: 3000,
  },
  {
    type: 'step',
    key: 'eas:configure-submit-android',
    label: 'Configure EAS Submit (Android)',
    description:
      'Uploads the Play Console service account JSON to Expo and wires it for EAS Submit. Store the JSON in the project vault; confirm eas.json submit and Play API access separately.',
    provider: 'eas',
    environmentScope: 'global',
    automationLevel: 'full',
    bridgeTarget: 'google-play',
    platforms: ['android'],
    dependencies: [
      { nodeKey: 'eas:create-project', required: true },
      { nodeKey: 'google-play:create-service-account', required: true },
    ],
    produces: [],
    estimatedDurationMs: 3000,
  },
];

export const EAS_TEARDOWN_STEPS: ProvisioningStepNode[] = [
  {
    type: 'step',
    key: 'eas:remove-submit-targets',
    label: 'Remove EAS Submit Targets',
    description: 'Remove configured store submission targets from EAS.',
    provider: 'eas',
    environmentScope: 'global',
    automationLevel: 'full',
    direction: 'teardown',
    teardownOf: 'eas:configure-submit-android',
    dependencies: [],
    produces: [],
  },
  {
    type: 'step',
    key: 'eas:delete-project',
    label: 'Delete EAS Project',
    description: 'Delete the EAS project and build profile configuration.',
    provider: 'eas',
    environmentScope: 'global',
    automationLevel: 'assisted',
    direction: 'teardown',
    teardownOf: 'eas:create-project',
    dependencies: [{ nodeKey: 'eas:remove-submit-targets', required: true }],
    produces: [],
  },
];
