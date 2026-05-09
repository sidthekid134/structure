import type { ProvisioningPlan } from '../provisioning/graph.types.js';
import type { ProjectModule } from './project-manager.js';
import { projectPrimaryDomain, projectResourceSlug } from './project-identity.js';

export interface AuthIntegrationKitFile {
  path: string;
  contents: string;
}

export interface AuthIntegrationKitBundle {
  zipFileName: string;
  promptFileName: string;
  promptText: string;
  files: AuthIntegrationKitFile[];
}

function mergeCompletedUpstream(plan: ProvisioningPlan): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, state] of plan.nodeStates) {
    if ((state.status === 'completed' || state.status === 'skipped') && state.resourcesProduced) {
      Object.assign(out, state.resourcesProduced);
    }
  }
  return out;
}

function hasNode(plan: ProvisioningPlan, nodeKey: string): boolean {
  return plan.nodes.some((node) => node.key === nodeKey);
}

function requireValue(
  value: string | undefined,
  resourceKey: string,
  missing: string[],
): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) {
    missing.push(resourceKey);
  }
  return trimmed;
}

function requireAtLeastOne(
  values: Array<{ key: string; value: string | undefined }>,
  missingLabel: string,
  missing: string[],
): string[] {
  const present = values
    .map((entry) => ({ key: entry.key, value: entry.value?.trim() ?? '' }))
    .filter((entry) => entry.value.length > 0);
  if (present.length === 0) {
    missing.push(missingLabel);
  }
  return present.map((entry) => entry.value);
}

/**
 * Which app surface(s) the integration kit targets. Drives prompt + README
 * variant selection. `'native'` matches the original Expo/React Native flow,
 * `'web'` produces a Firebase Web SDK-flavored handoff, and `'hybrid'` ships
 * the native flow plus a web supplement.
 */
export type AuthIntegrationKitVariant = 'native' | 'web' | 'hybrid';

function detectVariant(plan: ProvisioningPlan): AuthIntegrationKitVariant {
  const selected = new Set(plan.selectedModules ?? []);
  const isMobileTarget =
    (plan.platforms?.length ?? 0) > 0 ||
    selected.has('eas-builds') ||
    selected.has('eas-submit') ||
    selected.has('apple-signing') ||
    selected.has('google-play-publishing');
  const isWebTarget =
    selected.has('gcp-serverless-web') || selected.has('gcp-serverless-fullstack');

  if (isWebTarget && isMobileTarget) return 'hybrid';
  if (isWebTarget) return 'web';
  return 'native';
}

export function buildAuthIntegrationKitBundle(
  plan: ProvisioningPlan,
  projectModule: ProjectModule,
): AuthIntegrationKitBundle {
  const upstream = mergeCompletedUpstream(plan);
  const project = projectModule.project;
  const slug = projectResourceSlug(project) || plan.projectId;
  const appName = project.name?.trim() || slug;
  const primaryDomain = projectPrimaryDomain(project);
  const variant = detectVariant(plan);
  const missing: string[] = [];

  const firebaseProjectId = (
    upstream['firebase_project_id']?.trim() ||
    upstream['gcp_project_id']?.trim() ||
    ''
  );
  if (!firebaseProjectId) {
    missing.push('firebase_project_id|gcp_project_id');
  }

  const googleAuthInPlan =
    hasNode(plan, 'oauth:register-oauth-client-web') ||
    hasNode(plan, 'oauth:register-oauth-client-ios') ||
    hasNode(plan, 'oauth:register-oauth-client-android') ||
    hasNode(plan, 'oauth:enable-google-sign-in');
  const googleWebClientId = googleAuthInPlan
    ? requireValue(upstream['oauth_client_id_web'], 'oauth_client_id_web', missing)
    : '';
  const googleIosClientId = upstream['oauth_client_id_ios']?.trim() ?? '';
  const googleAndroidClientId = upstream['oauth_client_id_android']?.trim() ?? '';

  const appleServiceId = hasNode(plan, 'oauth:configure-apple-sign-in')
    ? requireValue(upstream['apple_sign_in_service_id'], 'apple_sign_in_service_id', missing)
    : '';

  const deepLinkBaseUrl = hasNode(plan, 'oauth:link-deep-link-domain')
    ? requireValue(upstream['deep_link_base_url'], 'deep_link_base_url', missing)
    : upstream['deep_link_base_url']?.trim() ?? '';
  const authLandingUrl = upstream['auth_landing_url']?.trim() ?? '';

  if (missing.length > 0) {
    throw new Error(
      `Cannot generate auth integration kit because required provisioning outputs are missing: ${missing.join(', ')}. ` +
        'Complete the corresponding auth steps, then retry this download.',
    );
  }

  const authConfig = {
    generated_at: new Date().toISOString(),
    project: {
      id: plan.projectId,
      name: appName,
      slug,
      bundle_id: project.bundleId?.trim() || '',
      domain: primaryDomain,
      platforms: project.platforms ?? [],
    },
    target: {
      variant,
    },
    firebase: {
      project_id: firebaseProjectId,
      ios_app_id: upstream['firebase_ios_app_id']?.trim() || null,
      android_app_id: upstream['firebase_android_app_id']?.trim() || null,
      firestore_database_id: upstream['firestore_database_id']?.trim() || null,
      firestore_location: upstream['firestore_location']?.trim() || null,
    },
    auth: {
      google: {
        enabled: googleAuthInPlan,
        web_client_id: googleWebClientId || null,
        ios_client_id: googleIosClientId || null,
        android_client_id: googleAndroidClientId || null,
      },
      apple: {
        enabled: !!appleServiceId,
        service_id: appleServiceId || null,
      },
      deep_link: {
        base_url: deepLinkBaseUrl || null,
        auth_landing_url: authLandingUrl || null,
      },
    },
  };

  const recommendedTargetsByVariant: Record<AuthIntegrationKitVariant, string[]> = {
    native: [
      'src/config/auth-config.json',
      'app/config/auth-config.json',
      'config/auth-config.json',
    ],
    web: [
      'src/config/auth-config.json',
      'src/lib/auth-config.json',
      'app/config/auth-config.json',
      'public/auth-config.json',
    ],
    hybrid: [
      'src/config/auth-config.json',
      'app/config/auth-config.json',
      'packages/shared/config/auth-config.json',
    ],
  };

  const installMap = {
    target: { variant },
    generated_files: {
      'auth-config.json': {
        recommended_targets: recommendedTargetsByVariant[variant],
        notes:
          'Pick exactly one location and keep it committed. Your app code should import this config as the single source of truth for auth identifiers.',
      },
      'llm-prompt.txt': {
        recommended_usage:
          'Paste this prompt into your coding LLM while your app repository is open. Ask it to execute the changes directly.',
      },
      'install-map.json': {
        recommended_usage:
          'Reference this file while reviewing the LLM output so config placement remains consistent.',
      },
    },
  };

  const googlePromptLines = googleAuthInPlan
    ? [
        '3) Wire Firebase auth initialization and Google sign-in IDs from auth-config.json (web + native where applicable).',
      ]
    : [
        '3) Google OAuth is not enabled in this plan; do not scaffold Google sign-in flows.',
      ];

  const promptText =
    variant === 'web'
      ? buildWebPromptText({ authConfig, googleAuthInPlan })
      : buildNativePromptText({ authConfig, googlePromptLines, variant });

  const folder = `${slug}-auth-integration-kit`;
  const zipFileName = `${folder}.zip`;
  const promptFileName = `${slug}-auth-llm-prompt.txt`;

  const readmeText =
    variant === 'web'
      ? buildWebReadmeText(appName)
      : buildNativeReadmeText(appName, variant);

  return {
    zipFileName,
    promptFileName,
    promptText,
    files: [
      {
        path: `${folder}/auth-config.json`,
        contents: `${JSON.stringify(authConfig, null, 2)}\n`,
      },
      {
        path: `${folder}/install-map.json`,
        contents: `${JSON.stringify(installMap, null, 2)}\n`,
      },
      {
        path: `${folder}/llm-prompt.txt`,
        contents: `${promptText}\n`,
      },
      {
        path: `${folder}/README.txt`,
        contents: readmeText,
      },
    ],
  };
}

interface NativePromptInputs {
  authConfig: unknown;
  googlePromptLines: string[];
  variant: AuthIntegrationKitVariant;
}

function buildNativePromptText({ authConfig, googlePromptLines, variant }: NativePromptInputs): string {
  const hybridSupplement =
    variant === 'hybrid'
      ? [
          '',
          'Hybrid (web + native) supplement:',
          '- This project also ships a web surface (Cloud Run frontend). After completing the native wiring above, also wire Firebase Web SDK auth in the web app using auth.google.web_client_id and auth.deep_link.base_url for redirect handling (signInWithRedirect / signInWithPopup).',
          '- Use a single shared auth-config.json across native + web to avoid drift; if the repos are separate, copy the same generated file into each.',
          '- Web callback path MUST resolve under auth.deep_link.base_url and may include `/__/auth/handler` when using Firebase hosted handler; otherwise wire your own redirect route.',
        ]
      : [];
  return [
    'You are implementing production-ready authentication wiring for this app using ONLY the attached generated configuration.',
    '',
    'Primary objective:',
    '- Integrate Firebase Auth provider configuration and callback/deep-link handling for mobile, and web when this repository includes web surfaces.',
    '',
    'Hard requirements (must follow exactly):',
    '1) Read auth-config.json first and treat it as the single source of truth for all auth identifiers and URLs.',
    '2) Use exact values from auth-config.json; do not invent, normalize, or rename IDs/domains.',
    '3) Place auth-config.json in the best matching app path for this repo (prefer an existing config directory).',
    '3a) For Expo/React Native repos, install or align native dependencies using `npx expo install` so versions match the project SDK. Do not use ad-hoc `npm install`/`yarn add` versions for Expo modules.',
    '3b) Do not upgrade/downgrade unrelated Expo packages. Keep dependency changes minimal and strictly tied to auth integration.',
    '3c) If this is an Expo React Native app and auth.google.enabled=true, you MUST configure the Expo plugin for Google iOS callback scheme in app config:',
    "    plugins: [['@react-native-google-signin/google-signin', { iosUrlScheme: 'com.googleusercontent.apps.<IOS_CLIENT_ID_WITHOUT_SUFFIX>' }]]",
    '3d) Derive `<IOS_CLIENT_ID_WITHOUT_SUFFIX>` from auth.google.ios_client_id by removing the exact suffix `.apps.googleusercontent.com`, then prefixing with `com.googleusercontent.apps.`.',
    '3e) If auth.google.enabled=true and auth.google.ios_client_id is missing/null/empty for iOS targets, STOP and report: `Missing required key auth.google.ios_client_id for iOS Google Sign-In`.',
    '3f) If auth.google.enabled=true and auth.google.web_client_id is missing/null/empty where web Firebase auth is wired, STOP and report: `Missing required key auth.google.web_client_id for web Firebase Auth`.',
    '3g) If auth.google.enabled=true and auth.google.android_client_id is missing/null/empty, DO NOT block integration by default. Continue Android wiring using available config (for example auth.google.web_client_id) unless this repository explicitly requires android_client_id for its existing Google sign-in path.',
    '3g.1) Only fail for missing auth.google.android_client_id when the existing Android implementation explicitly depends on it (for example current code/env contract reads that exact key). In that case, STOP and report: `Missing required key auth.google.android_client_id for Android Google Sign-In`.',
    '3h) Any native plugin/config change (including Google Sign-In plugin/iosUrlScheme changes) REQUIRES native regeneration/rebuild: run `npx expo prebuild` (or platform prebuild) and rebuild the app binaries before validation.',
    ...googlePromptLines,
    '4) If apple.enabled=true, wire Apple sign-in using apple.service_id as the provider client identifier (it is not a domain).',
    '5) Configure redirect/deep-link handling so callback domains and paths align with auth.deep_link.base_url and auth.deep_link.auth_landing_url.',
    '5a) Where Firebase redirect handler is applicable, callback flow MUST include `/__/auth/handler` under the configured deep-link domain.',
    '5b) If deep-link callback values are required for a targeted platform and either auth.deep_link.base_url or auth.deep_link.auth_landing_url is missing/null/empty, STOP and report the exact missing key.',
    '6) Respect existing architecture and conventions in this repo; do not introduce auth framework migrations.',
    '7) Update only files required for auth setup and correctness; avoid unrelated refactors.',
    '8) Do not introduce new required Firebase base-config keys (for example `extra.firebaseApiKey`) unless the repository already uses them and values are already available.',
    '8a) If the repo already sources auth runtime config from env/app config (for example Expo `Constants.expoConfig.extra`), wire required keys through existing env conventions and keep variable names stable.',
    '9) Sign-in/sign-up integration must be idempotent: detect existing auth wiring and update it in place without duplicating routes, providers, or persistence writes.',
    '10) If auth is not fully implemented but sign-in/sign-up flows already exist, wire Google/Apple auth into those existing flows end-to-end.',
    '11) If this is a new authenticated user, create a persistent app-level user profile record at the app-appropriate sign-up moment: after identity is verified and required profile fields are available, but before first post-auth navigation/side-effects that assume the user exists.',
    '11a) Firebase-first default: use Firestore users collection/document (or existing app user store abstraction if already present) and persist common app profile fields already used by the app.',
    '11a.1) If firebase.firestore_database_id is present, you MUST target that exact Firestore database ID for profile reads/writes; do not guess or switch to another database.',
    '11a.2) If firebase.firestore_database_id is missing but Firestore-based profile persistence is required by the existing app flow, STOP and report: `Missing required key firebase.firestore_database_id for Firestore user profile persistence`.',
    '11b) Do not invent a parallel user model when one already exists; reuse the existing user schema/storage contract and extend only required fields.',
    '11c) If first-login profile persistence fails, surface a hard failure with exact cause and recovery step; do not silently continue with partial auth state.',
    '11d) If the app has an explicit profile-completion step, create the user record exactly when that flow commits onboarding data (not earlier during provider callback and not later after the user enters the main app).',
    '12) If sign-up flow exists, validate required profile/completion fields after auth sign-in and gate user-record creation on that flow\'s completion contract.',
    '12a) If required user data is missing, route the user to exactly one completion step/screen in the flow to collect missing data, then continue to the normal post-auth destination.',
    '12b) This completion check must run on future sign-ins too (self-healing): when missing data is detected later, route back to the completion step until resolved.',
    '12c) Update the app\'s global auth state/store so successful sign-in persists across refreshes/restarts (for example via Firebase auth state hydration and the existing persistence layer already used by this repo).',
    '12d) On app startup, rehydrate the authenticated session from persisted auth state before protected-route gating so logged-in users stay logged in after refresh.',
    '12e) Ensure logout functionality exists end-to-end; if missing, add it using existing app patterns so sign-out clears persisted auth state/session data and returns to the signed-out flow.',
    '13) If sign-in/sign-up UI screens do not exist, do not invent a large UI refactor by default.',
    '13a) In that case, implement provider/auth-state wiring plus explicit integration hooks and report exactly what is missing (screens/routes/components).',
    '13b) Ask whether to scaffold minimal sign-in/sign-up UI now; if not approved, leave wiring ready so UI can be added later without reworking auth internals.',
    '',
    'Implementation checklist:',
    '- Mobile (required): configure native sign-in + callback handling for iOS and Android using configured client IDs.',
    '- Web (conditional): if web auth code or web entry points exist, wire equivalent provider config and callback handling.',
    '- Ensure redirect handler paths are consistent with Firebase/Auth provider expectations (for example /__/auth/handler where applicable).',
    '- Ensure deep-link routes return users back into the app flow after provider auth.',
    '- Preserve existing Firebase bootstrap/config loading (apiKey/appId/projectId/etc). Add only OAuth wiring on top unless this kit explicitly provides base Firebase values.',
    '- If the app currently expects Firebase keys via env/app config (for example Expo `extra.*`), keep that contract intact; do not rename keys or create stricter runtime requirements.',
    '- Update env templates/docs used by the repo (for example `.env.example`) for any newly required auth env keys, and do not leave required keys implicit.',
    '- Do NOT mutate package identifiers unless required for auth wiring. Preserve existing valid identifiers in app config.',
    '- Android package validation is mandatory only when setting/updating `android.package` from config values. If an existing valid `android.package` is already present in the app, keep it and continue.',
    '- If a config-provided Android package value is invalid (for example contains hyphens), do not apply it. Continue with the existing valid package if present; otherwise STOP with a clear error and required correction path.',
    '- Required correction path when no valid Android package is available: update the Android package identifier in source config to a valid Java package (reverse-DNS segments using letters/numbers/underscores only), then rerun integration. Do not silently continue with an invalid package.',
    '- Keep secrets out of source files; reference existing environment/secret patterns already used by the repo.',
    '- Ensure first-login creates a persistent user profile record in app storage (Firestore-first when Firebase is the auth backend), reusing existing user schema/contracts when present.',
    '- Ensure user creation timing matches the app\'s sign-up contract: after required onboarding data is collected and before first navigation/state writes that require an existing app user.',
    '- When Firestore is used for app user profiles, use firebase.firestore_database_id from auth-config.json as the exact target database.',
    '- Ensure post-auth routing is correct for both existing and new users: returning users proceed normally; users with missing required profile data are routed to one completion step then continue.',
    '- Ensure global auth state is persisted and rehydrated so login survives refresh/restart and protected routes reflect the real session state.',
    '- Ensure logout/sign-out path exists and clears persisted auth/session state using existing store/session abstractions.',
    '- If sign-up flow screens already exist, wire provider sign-in into them instead of creating parallel flows.',
    '- If sign-up/sign-in UI does not exist, add only minimal integration hooks and explicit TODO/decision points unless user explicitly requests full UI scaffolding.',
    '- Verify idempotency: rerunning integration should not duplicate providers, routes, listeners, or profile-write logic.',
    '- For Expo projects, install required peer dependencies reported by Expo Doctor (for example `expo-linking`, `react-native-worklets`) using `npx expo install`.',
    '- Expo local-module guardrail: if the repo has local Expo modules (for example `modules/*`), keep nested `modules/**/android` and `modules/**/ios` tracked. Do not use broad gitignore rules that unintentionally ignore them.',
    '- Expo native-module guardrail: if a compile error mentions missing Expo module symbols (for example `StaticAsyncFunction` / `StaticFunction`), treat it as a version skew issue and re-align Expo module versions with `npx expo install` before making code-level workarounds.',
    '',
    'Must-pass validation checklist:',
    '- Expo config resolves the expected Google Sign-In plugin values, including `iosUrlScheme` derived from auth.google.ios_client_id.',
    '- Generated native iOS config contains the expected URL scheme and does not trigger runtime "missing URL schemes" Google Sign-In errors.',
    '- Google sign-in works on iOS when auth.google.enabled=true (no "missing URL schemes" failure).',
    '- Redirect/deep-link callback path returns user to app flow in both cold-start and warm-start app states; include `/__/auth/handler` where Firebase redirect handler is applicable.',
    '- First authenticated login creates/updates app user profile record in persistent store.',
    '- Firestore profile persistence (when used) is executed against firebase.firestore_database_id from auth-config.json.',
    '- Returning login with missing required profile fields routes to the single completion step and then resumes normal app flow.',
    '- Refresh/restart keeps authenticated users signed in via rehydrated global auth state, without requiring a new login.',
    '- Logout/sign-out clears persisted auth/session state and transitions the app to the signed-out flow.',
    '- Re-running integration is idempotent (no duplicate auth routes/providers/profile documents from duplicated logic).',
    '- Typecheck/build passes for all touched targets.',
    '- Only required auth-integration files are changed; no unrelated refactors.',
    '- For Expo projects, run `npx expo-doctor` and ensure dependency/version checks are clean before finalizing.',
    '',
    'Output expectations:',
    '- Implement the changes directly in repository files.',
    '- Provide a short change summary and explicit verification steps run.',
    '- Provide an explicit "Required env vars" list for keys that must be set locally/CI (for example FIREBASE_API_KEY when used by existing app config).',
    '- If required runtime config is missing (from auth-config.json or existing env/app config), stop and report the exact missing key(s) instead of guessing.',
    ...hybridSupplement,
    '',
    'Configuration payload (copy exactly, no edits):',
    JSON.stringify(authConfig, null, 2),
  ].join('\n');
}

interface WebPromptInputs {
  authConfig: unknown;
  googleAuthInPlan: boolean;
}

function buildWebPromptText({ authConfig, googleAuthInPlan }: WebPromptInputs): string {
  const googleLines = googleAuthInPlan
    ? [
        '3) Initialize Firebase Web SDK using existing config sources in the repo, then wire Google Sign-In with `GoogleAuthProvider` using auth.google.web_client_id from auth-config.json.',
        '3a) Prefer `signInWithRedirect` for production deployments served from the configured custom domain; fall back to `signInWithPopup` only for local dev when the redirect host is unreachable.',
        '3b) If auth.google.enabled=true and auth.google.web_client_id is missing/null/empty, STOP and report: `Missing required key auth.google.web_client_id for web Firebase Auth`.',
      ]
    : [
        '3) Google OAuth is not enabled in this plan; do not scaffold Google sign-in flows.',
      ];
  return [
    'You are implementing production-ready web authentication wiring for this app using ONLY the attached generated configuration.',
    '',
    'Primary objective:',
    '- Integrate Firebase Auth in the web frontend (Firebase Web SDK / @firebase/auth), with redirect handling on the configured custom callback domain.',
    '',
    'Hard requirements (must follow exactly):',
    '1) Read auth-config.json first and treat it as the single source of truth for all auth identifiers and URLs.',
    '2) Use exact values from auth-config.json; do not invent, normalize, or rename IDs/domains.',
    ...googleLines,
    '4) If apple.enabled=true, wire Apple Sign-In on web using `OAuthProvider("apple.com")` with apple.service_id as the provider client identifier (not a domain). For mobile-only Apple SIWA setups this is typically not required on web.',
    '5) Configure the redirect callback to land on auth.deep_link.base_url. When using Firebase hosted handler, the callback path MUST resolve under `<deep_link.base_url>/__/auth/handler`.',
    '5a) When the web app owns the redirect route directly (no Firebase hosted handler), implement the route at the path implied by auth.deep_link.auth_landing_url and call `getRedirectResult(auth)` on mount before any protected-route gating.',
    '5b) If deep-link callback values are required and either auth.deep_link.base_url or auth.deep_link.auth_landing_url is missing/null/empty, STOP and report the exact missing key.',
    '6) Respect existing architecture and conventions in this repo (Next.js / Vite / Remix / etc.); do not introduce auth framework migrations or change routing strategy.',
    '7) Update only files required for auth setup and correctness; avoid unrelated refactors.',
    '8) Do not introduce new required Firebase base-config keys unless the repository already uses them and values are already available.',
    '8a) If the repo already sources Firebase web config from env (for example `NEXT_PUBLIC_FIREBASE_*` / `VITE_FIREBASE_*`), keep that contract intact and wire OAuth values through the same convention.',
    '9) Sign-in/sign-up integration must be idempotent: detect existing auth wiring and update it in place without duplicating providers, routes, or persistence writes.',
    '10) If sign-in/sign-up flows already exist, wire Google/Apple auth into those existing flows end-to-end.',
    '11) On first authenticated login, create a persistent app-level user profile record at the app-appropriate sign-up moment: after identity is verified and any required profile fields are collected, before first protected-route navigation that assumes the user exists.',
    '11a) Firebase-first default: use Firestore users collection/document (or existing app user store abstraction if already present).',
    '11a.1) If firebase.firestore_database_id is present, you MUST target that exact Firestore database ID for profile reads/writes; do not guess or switch to another database.',
    '11a.2) If firebase.firestore_database_id is missing but Firestore profile persistence is required by the existing app flow, STOP and report: `Missing required key firebase.firestore_database_id for Firestore user profile persistence`.',
    '12) Update the global auth state (existing store / context / hook) so successful sign-in survives refresh: rely on Firebase Auth persistence (default `browserLocalPersistence` for web) and rehydrate via `onAuthStateChanged` before protected-route gating.',
    '12a) On app boot, await an initial `onAuthStateChanged` resolution (or equivalent suspense-friendly pattern) so logged-in users are not flashed through the signed-out flow.',
    '12b) Ensure logout exists end-to-end: call `signOut(auth)` and clear app-side persisted user profile/session caches; route back to the signed-out flow.',
    '13) If sign-in/sign-up UI screens do not exist, do not invent a large UI refactor by default. Implement provider/auth-state wiring plus minimal integration hooks and report exactly what UI is missing.',
    '',
    'Implementation checklist:',
    '- Wire Firebase Auth initialization into the web entrypoint, reusing existing Firebase init if present.',
    '- Implement Google sign-in using `signInWithRedirect` against the custom callback domain; ensure `getRedirectResult` is consumed on the landing route.',
    '- Implement the redirect landing route under auth.deep_link.base_url and ensure it returns the user back into the in-app flow after success.',
    '- Add Firebase auth state hydration and a session-aware route guard.',
    '- Create the persistent user profile record (Firestore-first when firebase.firestore_database_id is present), reusing the existing user schema when one exists.',
    '- Add an explicit logout path that clears persisted state and returns to the signed-out flow.',
    '- Update env templates/docs (for example `.env.example`) for any newly required public auth env keys; do not leave required keys implicit.',
    '- Keep secrets out of source files; rely on existing env/secret patterns.',
    '',
    'Must-pass validation checklist:',
    '- `signInWithRedirect` initiates correctly and the redirect lands on the configured callback domain.',
    '- `getRedirectResult` resolves a signed-in user on the landing route without throwing.',
    '- Refresh/restart keeps users signed in via Firebase web persistence + `onAuthStateChanged` hydration; protected routes do not flash signed-out state.',
    '- First authenticated login creates/updates the app user profile record in persistent store (Firestore against firebase.firestore_database_id when provided).',
    '- Logout clears persisted auth/session state and transitions to the signed-out flow.',
    '- Re-running integration is idempotent (no duplicate providers/routes/profile writes).',
    '- Typecheck/build passes for all touched targets.',
    '- Only required auth-integration files are changed; no unrelated refactors.',
    '',
    'Output expectations:',
    '- Implement the changes directly in repository files.',
    '- Provide a short change summary and explicit verification steps run.',
    '- Provide an explicit "Required env vars" list for keys that must be set locally/CI.',
    '- If required runtime config is missing (from auth-config.json or existing env/app config), stop and report the exact missing key(s) instead of guessing.',
    '',
    'Configuration payload (copy exactly, no edits):',
    JSON.stringify(authConfig, null, 2),
  ].join('\n');
}

function buildNativeReadmeText(appName: string, variant: AuthIntegrationKitVariant): string {
  const hybridLine =
    variant === 'hybrid'
      ? 'Hybrid web + native: also wire Firebase Web SDK auth in the web app using auth.google.web_client_id and auth.deep_link.base_url; use the same auth-config.json across surfaces.\n\n'
      : '';
  return (
    `Auth integration kit for "${appName}".\n\n` +
    'Integration scope: Expo React Native apps using Firebase Auth + @react-native-google-signin/google-signin + Apple Sign-In.\n\n' +
    hybridLine +
    'Required usage rules:\n' +
    '- Treat auth-config.json as the single source of truth for all IDs/domains/URLs.\n' +
    '- Do not normalize, rename, or reinterpret IDs/domains from auth-config.json.\n' +
    '- Keep secrets out of source files; use existing env/secret patterns.\n' +
    '- Apply only auth wiring changes; no unrelated refactors.\n\n' +
    'Firebase data-store targeting:\n' +
    '- If firebase.firestore_database_id is present in auth-config.json, use that exact Firestore database for user profile persistence.\n' +
    '- Do not silently switch databases or default to another DB when firebase.firestore_database_id is provided.\n\n' +
    'Critical Expo Google iOS plugin requirement:\n' +
    "- In Expo app config, set plugins exactly as: [['@react-native-google-signin/google-signin', { iosUrlScheme: 'com.googleusercontent.apps.<IOS_CLIENT_ID_WITHOUT_SUFFIX>' }]].\n" +
    '- Derive <IOS_CLIENT_ID_WITHOUT_SUFFIX> from auth.google.ios_client_id by removing `.apps.googleusercontent.com`, then prefixing with `com.googleusercontent.apps.`.\n' +
    '- If native plugin config changes, you must run prebuild/rebuild before validating (for example `npx expo prebuild` then rebuild binaries).\n\n' +
    'Fail-fast requirements (do not continue on failure):\n' +
    '- If auth.google.enabled=true and iOS target is in scope but auth.google.ios_client_id is missing/null/empty: fail with exact key name.\n' +
    '- If auth.google.enabled=true and web auth path is in scope but auth.google.web_client_id is missing/null/empty: fail with exact key name.\n' +
    '- If auth.google.enabled=true and auth.google.android_client_id is missing/null/empty: continue by default (do not fail) unless existing repo code/env contract explicitly requires that exact key.\n' +
    '- If Android package value from config is invalid (Java package rules, no hyphens), do not apply it; continue with existing valid android.package when available, otherwise fail with required correction path.\n' +
    '- If deep-link callback alignment needs auth.deep_link.base_url or auth.deep_link.auth_landing_url and either key is missing/null/empty: fail with exact key name.\n\n' +
    'Deep-link and callback alignment:\n' +
    '- Align callback handling with auth.deep_link.base_url and auth.deep_link.auth_landing_url.\n' +
    '- Include Firebase handler path `/__/auth/handler` where applicable.\n\n' +
    'Must-pass validation checklist:\n' +
    '- Expo config resolves expected Google plugin values (including derived iosUrlScheme).\n' +
    '- iOS URL scheme exists in generated native config.\n' +
    '- Google sign-in works on iOS without "missing URL schemes" runtime error.\n' +
    '- Redirect/deep-link callback returns user to app flow (cold + warm start).\n' +
    '- Typecheck/build passes for touched targets.\n' +
    '- Only required files changed.\n\n' +
    'Execution order:\n' +
    '- Start with llm-prompt.txt in your app repository.\n' +
    '- Re-download this kit whenever provisioning values change.\n'
  );
}

function buildWebReadmeText(appName: string): string {
  return (
    `Auth integration kit for "${appName}" (web variant).\n\n` +
    'Integration scope: web frontends using the Firebase Web SDK (@firebase/auth) with redirect-based Google Sign-In on the configured custom callback domain. Apple Sign-In on web is wired only when apple.enabled=true.\n\n' +
    'Required usage rules:\n' +
    '- Treat auth-config.json as the single source of truth for all IDs/domains/URLs.\n' +
    '- Do not normalize, rename, or reinterpret IDs/domains from auth-config.json.\n' +
    '- Keep secrets out of source files; use existing env/secret patterns (for example NEXT_PUBLIC_* or VITE_*).\n' +
    '- Apply only auth wiring changes; no unrelated refactors.\n\n' +
    'Firebase data-store targeting:\n' +
    '- If firebase.firestore_database_id is present in auth-config.json, use that exact Firestore database for user profile persistence.\n' +
    '- Do not silently switch databases or default to another DB when firebase.firestore_database_id is provided.\n\n' +
    'Web redirect flow:\n' +
    '- Use `signInWithRedirect` against the configured custom callback domain in production.\n' +
    '- Implement the landing route under auth.deep_link.base_url (or `<base_url>/__/auth/handler` when using the Firebase hosted handler) and consume `getRedirectResult(auth)` on mount before any protected-route gating.\n' +
    '- Use `signInWithPopup` only as a local-dev fallback when the redirect host is unreachable.\n\n' +
    'Fail-fast requirements (do not continue on failure):\n' +
    '- If auth.google.enabled=true and auth.google.web_client_id is missing/null/empty: fail with exact key name.\n' +
    '- If deep-link callback alignment needs auth.deep_link.base_url or auth.deep_link.auth_landing_url and either is missing/null/empty: fail with exact key name.\n\n' +
    'Auth state & session:\n' +
    '- Rely on Firebase Auth web persistence (default `browserLocalPersistence`).\n' +
    '- Hydrate via `onAuthStateChanged` on app boot before protected-route gating so logged-in users do not flash through the signed-out flow.\n' +
    '- Logout: call `signOut(auth)` and clear any app-side cached user profile/session before returning to the signed-out flow.\n\n' +
    'Must-pass validation checklist:\n' +
    '- `signInWithRedirect` lands on the configured callback domain and `getRedirectResult` resolves a user on the landing route.\n' +
    '- Refresh/restart keeps users signed in via Firebase web persistence + `onAuthStateChanged` hydration.\n' +
    '- First authenticated login creates the app user profile record (Firestore-first when firebase.firestore_database_id is present).\n' +
    '- Logout clears persisted auth/session and routes to the signed-out flow.\n' +
    '- Typecheck/build passes for touched targets.\n' +
    '- Only required files changed.\n\n' +
    'Execution order:\n' +
    '- Start with llm-prompt.txt in your web repository.\n' +
    '- Re-download this kit whenever provisioning values change.\n'
  );
}
