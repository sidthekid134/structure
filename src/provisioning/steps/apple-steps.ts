import type { ProvisioningStepNode } from '../graph.types.js';

export const APPLE_STEPS: ProvisioningStepNode[] = [
  {
    type: 'step',
    key: 'apple:register-app-id',
    label: 'Register App ID',
    description:
      'Register (or verify) the bundle ID as an App ID in Apple Developer / App Store Connect. Fully automated via the org-level Apple integration — no manual App ID input is required.',
    provider: 'apple',
    environmentScope: 'global',
    automationLevel: 'full',
    platforms: ['ios'],
    dependencies: [{ nodeKey: 'user:connect-apple-integration', required: true }],
    produces: [
      {
        key: 'apple_app_id',
        label: 'App ID',
        description: 'Apple Developer Portal App ID (Team Prefix + bundle identifier)',
      },
      {
        key: 'apple_bundle_id',
        label: 'Bundle ID',
        description: 'Registered bundle identifier (sourced from the project)',
      },
    ],
    estimatedDurationMs: 5000,
  },
  // NOTE: apple:create-dev-provisioning-profile and
  // apple:create-dist-provisioning-profile used to live here as manual
  // "open Apple Developer → Profiles, paste the UUID into the vault" steps.
  // They were removed once we standardized on EAS-managed iOS signing:
  //   - EAS Build manages certificates + provisioning profiles
  //     automatically using the same App Store Connect Team Key configured
  //     at the org level (see apple:store-signing-in-eas).
  //   - Dev profiles also require ≥1 registered device UDID, which Studio
  //     does not collect — making full automation impractical.
  // If you need to re-introduce Studio-owned profile creation, restore the
  // step definitions from git history and the executeStep handlers in
  // src/providers/apple.ts.
  // Both apple:generate-apns-key and apple:create-sign-in-key share a
  // unified input model around a single "Apple Auth Key" (.p8) per project.
  // Apple's keys are NOT capability-bound: one .p8 can carry APNs + Sign In
  // with Apple + DeviceCheck + MusicKit by toggling capability checkboxes in
  // Apple Developer Portal. So both steps ask for the same Key ID + .p8
  // shape; the wizard hides the .p8 upload when the typed Key ID matches a
  // key that's already in the project's Apple Auth Key registry (the user
  // just enabled an additional capability on an existing key, no re-upload
  // needed). The backend reads/writes a unified registry under
  // <projectId>/apple/auth-keys; legacy single-purpose vault entries are
  // migrated on first read.
  {
    type: 'step',
    key: 'apple:generate-apns-key',
    label: 'Register APNs Capability on Apple Auth Key',
    description:
      "Adds (or confirms) APNs on the project's Apple Auth Key. Apple does not expose key creation or capability toggles via any public API — the .p8 download is one-time-only and capability checkboxes are toggled in Apple Developer → Keys. If you've already vaulted an Apple Auth Key in this project (e.g. via Sign In with Apple), reuse it from the picker and only the capability annotation is recorded. Otherwise, create a fresh key, check the APNs capability, and drop the AuthKey_<KEYID>.p8 here — Studio extracts the Key ID from the filename automatically.",
    provider: 'apple',
    environmentScope: 'global',
    automationLevel: 'assisted',
    platforms: ['ios'],
    dependencies: [{ nodeKey: 'apple:register-app-id', required: true }],
    inputFields: [
      {
        key: 'apple_auth_key_p8',
        label: 'Apple Auth Key',
        description:
          'Drop the AuthKey_<KEYID>.p8 file Apple let you download once — Studio extracts the 10-character Key ID from the filename, validates the PEM in-browser, and stores it encrypted in the project vault. If the project already has a vaulted key, the picker above lets you add this capability without re-uploading.',
        type: 'p8',
        required: false,
      },
    ],
    produces: [
      {
        key: 'apple_auth_key_id_apns',
        label: 'Apple Auth Key (APNs capability)',
        description: 'Key ID of the Apple Auth Key bearing the APNs capability for this project.',
      },
      {
        key: 'apple_auth_key_p8_apns',
        label: 'APNs PEM',
        description:
          "Marker (vaulted) — the .p8 is stored in the project's unified Apple Auth Key registry, keyed by Key ID.",
      },
    ],
    estimatedDurationMs: 5000,
  },
  {
    type: 'step',
    key: 'apple:create-sign-in-key',
    label: 'Register Sign-In Capability on Apple Auth Key',
    description:
      "Configures Sign in with Apple in Apple Developer in this order: App ID Edit Configuration, Services ID, then Auth Key capability (or key reuse). Like the APNs step: if you already vaulted an Apple Auth Key in this project (e.g. for APNs), reuse it by typing the same Key ID and only the capability annotation is recorded — no second .p8 upload. Otherwise, create a fresh key with the Sign in with Apple capability and drop the .p8. Conditionally added when the project enables OAuth + Apple as a sign-in provider.",
    provider: 'apple',
    environmentScope: 'global',
    automationLevel: 'assisted',
    platforms: ['ios'],
    dependencies: [{ nodeKey: 'apple:register-app-id', required: true }],
    inputFields: [
      {
        key: 'apple_sign_in_service_id',
        label: 'Apple Services ID',
        description:
          'Reverse-DNS Services ID used as the OAuth client identifier (e.g. {bundleId}.signin). Created under Apple Developer → Identifiers → Services IDs with Sign In with Apple enabled. The Return URL must point at your Firebase auth handler (https://<gcp-project>.firebaseapp.com/__/auth/handler). This is a separate Apple resource and does not replace enabling Sign In with Apple on the App ID configuration page.',
        type: 'text',
        placeholder: '{bundleId}.signin',
        defaultValue: '{bundleId}.signin',
        required: true,
      },
      {
        key: 'apple_auth_key_p8',
        label: 'Apple Auth Key',
        description:
          'Drop the AuthKey_<KEYID>.p8 file Apple let you download once — Studio extracts the 10-character Key ID from the filename, validates the PEM in-browser, and stores it encrypted in the project vault. The .p8 must come from a key that has the Sign in with Apple capability checked AND is bound to your App ID. If the project already has a vaulted key, the picker above lets you add this capability without re-uploading.',
        type: 'p8',
        required: false,
      },
    ],
    produces: [
      {
        key: 'apple_auth_key_id_sign_in_with_apple',
        label: 'Apple Auth Key (Sign In capability)',
        description: 'Key ID of the Apple Auth Key bearing the Sign In with Apple capability for this project.',
      },
      {
        key: 'apple_auth_key_p8_sign_in_with_apple',
        label: 'Sign In PEM',
        description:
          "Marker (vaulted) — the .p8 is stored in the project's unified Apple Auth Key registry, keyed by Key ID.",
      },
      {
        key: 'apple_sign_in_service_id',
        label: 'Apple Services ID',
        description: 'Service ID used as the OAuth client id when wiring SIWA into Firebase Auth.',
      },
    ],
    estimatedDurationMs: 5000,
  },
  {
    type: 'step',
    key: 'apple:upload-apns-to-firebase',
    label: 'Upload APNs Key to Firebase',
    description:
      'Register the APNs key with Firebase Cloud Messaging for push notification delivery.',
    provider: 'apple',
    environmentScope: 'global',
    // Manual: Firebase Console does not expose an API for uploading APNs auth
    // keys, so the user has to drop the .p8 in via the Cloud Messaging tab
    // (the step renders a deep link + checklist via MANUAL_INSTRUCTION_REGISTRY).
    automationLevel: 'manual',
    bridgeTarget: 'firebase',
    platforms: ['ios'],
    dependencies: [
      { nodeKey: 'apple:generate-apns-key', required: true },
      { nodeKey: 'firebase:enable-fcm', required: true, description: 'FCM must be enabled' },
    ],
    produces: [],
    estimatedDurationMs: 3000,
  },
  {
    type: 'step',
    key: 'apple:create-app-store-listing',
    label: 'Create App Store Connect Listing',
    description:
      'Apple does not allow App Store Connect apps to be created via API — only GET / UPDATE. Create the listing once in App Store Connect (Apps → "+" → New App) using your registered bundle ID; Studio detects it via filter[bundleId] and stores asc_app_id. Optional project-vault override at <projectId>/asc_app_id is honored when set.',
    provider: 'apple',
    environmentScope: 'global',
    automationLevel: 'assisted',
    platforms: ['ios'],
    dependencies: [{ nodeKey: 'apple:register-app-id', required: true }],
    inputFields: [
      {
        key: 'asc_app_name',
        label: 'App Store Connect listing name',
        description:
          'The exact name you used (or will use) when creating the listing in App Store Connect. Defaults to your project name. Update this if you had to use a different name (App Store names must be globally unique, so you may need a suffix like "Flow Mobile" if "Flow" was taken).',
        type: 'text',
        placeholder: 'Flow',
        defaultValue: '{name}',
        required: true,
      },
    ],
    produces: [
      {
        key: 'asc_app_id',
        label: 'ASC App ID',
        description: 'App Store Connect app identifier',
      },
      {
        key: 'asc_app_name',
        label: 'ASC App Name',
        description: 'App Store Connect listing name as shown to users (sourced from Apple).',
      },
    ],
    estimatedDurationMs: 5000,
  },
  {
    type: 'step',
    key: 'apple:configure-testflight-group',
    label: 'Create TestFlight Beta Group',
    description:
      "Creates (or reuses) a TestFlight beta group on the App Store Connect listing and optionally seeds it with tester emails. Required so that EAS Submit / manual TestFlight builds have a default group to assign new builds to. Defaults to an INTERNAL group (skips Beta App Review, builds available immediately) — internal testers must be existing App Store Connect users; Studio verifies that and fails fast if any tester email isn't an ASC user. Switch to EXTERNAL if you want to invite arbitrary emails (Beta App Review required on first build of each version). Idempotent: re-running with the same group name reuses the existing group and only adds testers that aren't already members.",
    provider: 'apple',
    environmentScope: 'global',
    automationLevel: 'full',
    platforms: ['ios'],
    dependencies: [
      { nodeKey: 'apple:create-app-store-listing', required: true },
    ],
    inputFields: [
      {
        key: 'testflight_group_name',
        label: 'TestFlight group name',
        description:
          "Display name for the beta group in App Store Connect → TestFlight → Groups. Defaults to your app name suffixed with 'Testers'. Must be unique within the app.",
        type: 'text',
        placeholder: '{name} Testers',
        defaultValue: '{name} Testers',
        required: true,
      },
      {
        key: 'testflight_group_type',
        label: 'Group type',
        description:
          "Internal groups skip Beta App Review and get builds immediately, but every tester must already exist as an App Store Connect user with the Developer/App Manager/Marketing/Customer Support role and the 'Access to TestFlight' checkbox enabled. External groups accept any email but the first build of each version requires Beta App Review (24–48h). Default is internal — the typical 'add my own email' workflow.",
        type: 'select',
        options: ['internal', 'external'],
        defaultValue: 'internal',
        required: true,
      },
      {
        key: 'testflight_tester_emails',
        label: 'Tester emails (optional)',
        description:
          "Comma- or newline-separated email addresses to add as testers in this group. For INTERNAL groups, each email must already be an App Store Connect user (Users and Access in ASC) — Studio looks them up and fails loudly if any aren't. For EXTERNAL groups, any email is accepted and gets a TestFlight invite once a build is assigned. Leave blank to create an empty group.",
        type: 'text',
        placeholder: 'qa@example.com, founder@example.com',
        required: false,
      },
    ],
    produces: [
      {
        key: 'testflight_group_id',
        label: 'TestFlight Group ID',
        description: 'App Store Connect betaGroups resource id (used by EAS Submit and manual build assignment).',
      },
      {
        key: 'testflight_group_name',
        label: 'TestFlight Group Name',
        description: 'Display name of the beta group as stored in App Store Connect.',
      },
    ],
    estimatedDurationMs: 8_000,
  },
  {
    type: 'step',
    key: 'apple:store-signing-in-eas',
    label: 'Configure EAS-Managed iOS Signing',
    description:
      'Mints an iOS Distribution certificate + App Store provisioning profile against Apple App Store Connect (using the org-level Team Key) and uploads them to EAS as the app\'s APP_STORE iosAppBuildCredentials. Subsequent `eas build --platform ios` runs reuse these credentials without prompting. Idempotent: skips minting if EAS already has both attached. Apple Developer dev/ad-hoc profiles are out of scope (require device UDIDs Studio does not collect).',
    provider: 'apple',
    environmentScope: 'global',
    automationLevel: 'full',
    bridgeTarget: 'eas',
    platforms: ['ios'],
    dependencies: [
      { nodeKey: 'apple:register-app-id', required: true },
      { nodeKey: 'apple:create-app-store-listing', required: true },
      { nodeKey: 'eas:create-project', required: true },
    ],
    refreshTriggers: [
      // OAuth/SIWA changes can alter entitlements and signing needs; force
      // this step back to not-started so users can invoke a refresh rotation.
      'apple:create-sign-in-key',
      'oauth:configure-apple-sign-in',
    ],
    produces: [
      {
        key: 'apple_distribution_cert_id',
        label: 'Apple Distribution Certificate (EAS)',
        description: 'Expo GraphQL id of the iOS distribution certificate.',
      },
      {
        key: 'apple_distribution_cert_serial',
        label: 'Distribution Certificate Serial',
        description: 'Apple-assigned serial number of the issued distribution certificate.',
      },
      {
        key: 'apple_app_store_profile_id',
        label: 'App Store Provisioning Profile (EAS)',
        description: 'Expo GraphQL id of the App Store provisioning profile.',
      },
      {
        key: 'eas_ios_build_credentials_id',
        label: 'EAS iOS Build Credentials',
        description: 'Expo GraphQL id of the APP_STORE iosAppBuildCredentials record.',
      },
    ],
    estimatedDurationMs: 30_000,
  },
];

export const APPLE_TEARDOWN_STEPS: ProvisioningStepNode[] = [
  {
    type: 'step',
    key: 'apple:revoke-signing-assets',
    label: 'Revoke Apple Signing Assets',
    description:
      'Revoke EAS-managed certificates and provisioning profiles (via `eas credentials --platform ios`), plus any APNs/ASC keys. Complete in Apple Developer + App Store Connect for any assets EAS does not manage.',
    provider: 'apple',
    environmentScope: 'global',
    automationLevel: 'assisted',
    direction: 'teardown',
    teardownOf: 'apple:store-signing-in-eas',
    platforms: ['ios'],
    dependencies: [],
    produces: [],
  },
  {
    type: 'step',
    key: 'apple:remove-app-store-listing',
    label: 'Remove App Store Listing',
    description:
      'Archive/remove App Store Connect listing and Apple app registration where permitted. Some published records cannot be permanently deleted and require manual archival.',
    provider: 'apple',
    environmentScope: 'global',
    automationLevel: 'manual',
    direction: 'teardown',
    teardownOf: 'apple:create-app-store-listing',
    platforms: ['ios'],
    dependencies: [{ nodeKey: 'apple:revoke-signing-assets', required: true }],
    produces: [],
  },
];
