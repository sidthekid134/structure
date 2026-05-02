import type { ProvisioningStepNode } from '../graph.types.js';

export const FIREBASE_STEPS: ProvisioningStepNode[] = [
  {
    type: 'step',
    key: 'firebase:create-gcp-project',
    label: 'Create GCP Project',
    description:
      'Sign in with Google (or use a service account key already in the vault), then create or link the GCP project for this app.',
    provider: 'firebase',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [
      { nodeKey: 'user:setup-gcp-billing', required: true },
      { nodeKey: 'user:connect-gcp-integration', required: true },
    ],
    produces: [
      {
        key: 'gcp_project_id',
        label: 'GCP Project ID',
        description: 'st-<slug>-<hash6>',
      },
    ],
    estimatedDurationMs: 15000,
  },
  {
    type: 'step',
    key: 'firebase:enable-firebase',
    label: 'Enable Firebase',
    description: 'Activate Firebase services on the GCP project.',
    provider: 'firebase',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'firebase:create-gcp-project', required: true }],
    produces: [
      {
        key: 'firebase_project_id',
        label: 'Firebase Project ID',
        description: 'Firebase project identifier',
      },
    ],
    estimatedDurationMs: 10000,
  },
  {
    type: 'step',
    key: 'firebase:create-provisioner-sa',
    label: 'Create Provisioner Service Account',
    description: 'Service account used for project-scoped provisioning operations.',
    provider: 'firebase',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'firebase:enable-firebase', required: true }],
    produces: [
      {
        key: 'provisioner_sa_email',
        label: 'Provisioner SA',
        description: 'platform-provisioner@<project>.iam.gserviceaccount.com',
      },
    ],
    estimatedDurationMs: 5000,
  },
  {
    type: 'step',
    key: 'firebase:bind-provisioner-iam',
    label: 'Bind Provisioner IAM Roles',
    description: 'Grant project-level IAM roles to the provisioner service account.',
    provider: 'firebase',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'firebase:create-provisioner-sa', required: true }],
    produces: [],
    estimatedDurationMs: 8000,
  },
  {
    type: 'step',
    key: 'firebase:generate-sa-key',
    label: 'Generate Service Account Key',
    description: 'JSON key generated and stored in the encrypted local vault.',
    provider: 'firebase',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'firebase:bind-provisioner-iam', required: true }],
    produces: [
      {
        key: 'service_account_json',
        label: 'SA Key',
        description: 'Vaulted service account JSON',
      },
    ],
    estimatedDurationMs: 3000,
  },
  {
    type: 'step',
    key: 'firebase:register-ios-app',
    label: 'Register iOS App',
    description:
      'Register the iOS bundle ID with Firebase to generate GoogleService-Info.plist values.',
    provider: 'firebase',
    environmentScope: 'global',
    automationLevel: 'full',
    platforms: ['ios'],
    dependencies: [{ nodeKey: 'firebase:enable-firebase', required: true }],
    produces: [
      {
        key: 'firebase_ios_app_id',
        label: 'Firebase iOS App',
        description: 'Firebase app ID for iOS',
      },
    ],
    estimatedDurationMs: 5000,
  },
  {
    type: 'step',
    key: 'firebase:register-android-app',
    label: 'Register Android App',
    description:
      'Register the Android package name with Firebase to generate google-services.json values.',
    provider: 'firebase',
    environmentScope: 'global',
    automationLevel: 'full',
    platforms: ['android'],
    dependencies: [{ nodeKey: 'firebase:enable-firebase', required: true }],
    produces: [
      {
        key: 'firebase_android_app_id',
        label: 'Firebase Android App',
        description: 'Firebase app ID for Android',
      },
    ],
    estimatedDurationMs: 5000,
  },
  {
    type: 'step',
    key: 'firebase:register-android-sha1',
    label: 'Register Android Signing SHA-1 with Firebase',
    description:
      'Attach an Android signing certificate SHA-1 fingerprint to the Firebase Android app. ' +
      'Firebase only emits an Android OAuth client ID in google-services.json once a SHA-1 is registered, ' +
      'so this is required for native Google Sign-In on Android. ' +
      'Sources (in priority order): the SHA-1 produced upstream by `google-play:extract-fingerprints` (Play App Signing), ' +
      'the value pasted into the `signing_sha1` input field below (e.g. from `eas credentials` or your debug keystore), ' +
      'or, if neither is available, this step pauses and waits for the user to register one in the Firebase Console.',
    provider: 'firebase',
    environmentScope: 'global',
    automationLevel: 'full',
    platforms: ['android'],
    dependencies: [
      { nodeKey: 'firebase:register-android-app', required: true },
      // Optional: when google-play-publishing is selected, the upstream
      // `signing_sha1` resource flows through and we skip the input field.
      {
        nodeKey: 'google-play:extract-fingerprints',
        required: false,
        description:
          'When the Google Play module is enabled, the SHA-1 from Play App Signing is reused automatically.',
      },
    ],
    inputFields: [
      {
        key: 'signing_sha1',
        label: 'Android Signing SHA-1',
        description:
          'SHA-1 fingerprint (40 hex chars, with or without colon separators). Get it from `eas credentials → Android → Production → Keystore → SHA1 Fingerprint`, ' +
          'Google Play Console → App signing, or from your local debug keystore via `keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android`. ' +
          'Leave blank if it has already been registered upstream by `google-play:extract-fingerprints` or directly in the Firebase Console.',
        type: 'text',
        placeholder: 'AB:CD:EF:01:23:45:...',
        required: false,
      },
    ],
    produces: [
      {
        key: 'android_signing_sha1',
        label: 'Android SHA-1 (registered)',
        description:
          'Normalized SHA-1 fingerprint that has been attached to the Firebase Android app.',
      },
    ],
    estimatedDurationMs: 4000,
  },
  {
    type: 'step',
    key: 'firebase:create-firestore-db',
    label: 'Create Firestore Database',
    description: 'Enable Firestore APIs and create a Firestore database instance in native or datastore mode at the selected region.',
    provider: 'firebase',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'firebase:enable-firebase', required: true }],
    inputFields: [
      {
        key: 'database_id',
        label: 'Database ID',
        description: 'Firestore database ID. Defaults to your app name. Use "(default)" for the GCP default database.',
        type: 'text',
        placeholder: 'my-app',
        defaultValue: '{slug}',
        required: true,
      },
      {
        key: 'location_id',
        label: 'Location',
        description: 'GCP region for the Firestore database. Cannot be changed after creation.',
        type: 'select',
        defaultValue: 'us-central1',
        options: [
          'us-central1',
          'us-east1',
          'us-east4',
          'us-west1',
          'europe-west1',
          'europe-west2',
          'europe-west3',
          'asia-east1',
          'asia-northeast1',
          'asia-south1',
          'australia-southeast1',
          'southamerica-east1',
        ],
        required: true,
      },
      {
        key: 'database_type',
        label: 'Mode',
        description: 'Firestore mode. Native is the standard document database; Datastore mode is for Datastore-compatible workloads.',
        type: 'select',
        defaultValue: 'FIRESTORE_NATIVE',
        options: ['FIRESTORE_NATIVE', 'DATASTORE_MODE'],
        required: true,
      },
    ],
    produces: [
      {
        key: 'firestore_database_id',
        label: 'Firestore Database',
        description: 'Firestore database ID (e.g. "(default)")',
      },
      {
        key: 'firestore_location',
        label: 'Firestore Location',
        description: 'GCP region where the database is hosted',
      },
    ],
    estimatedDurationMs: 30000,
  },
  {
    type: 'step',
    key: 'firebase:configure-firestore-rules',
    label: 'Configure Firestore Rules',
    description:
      'Deploy Firestore security rules for the target database and verify users/{userId} auth-scoped access is present.',
    provider: 'firebase',
    environmentScope: 'per-environment',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'firebase:create-firestore-db', required: true }],
    produces: [
      {
        key: 'user_persistence_store',
        label: 'User Persistence Store',
        description: 'Backing store used for user records',
      },
      {
        key: 'users_collection_path',
        label: 'Users Collection Path',
        description: 'Canonical Firestore collection used for app user records',
      },
      {
        key: 'firestore_database_id',
        label: 'Firestore Database',
        description: 'Database ID where users collection rules are enforced',
      },
    ],
    estimatedDurationMs: 3000,
  },
  {
    type: 'step',
    key: 'firebase:enable-auth',
    label: 'Enable Firebase Auth',
    description: 'Enable the Firebase Authentication API on the GCP project.',
    provider: 'firebase',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'firebase:enable-firebase', required: true }],
    produces: [
      {
        key: 'enabled_auth_api',
        label: 'Auth API',
        description: 'identitytoolkit.googleapis.com enabled',
      },
    ],
    estimatedDurationMs: 10000,
  },
  {
    type: 'step',
    key: 'firebase:enable-storage',
    label: 'Enable Cloud Storage',
    description: 'Enable the Cloud Storage and Firebase Rules APIs on the GCP project.',
    provider: 'firebase',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'firebase:enable-firebase', required: true }],
    produces: [
      {
        key: 'enabled_storage_api',
        label: 'Storage API',
        description: 'storage.googleapis.com + firebaserules.googleapis.com enabled',
      },
    ],
    estimatedDurationMs: 10000,
  },
  {
    type: 'step',
    key: 'firebase:enable-fcm',
    label: 'Enable Firebase Messaging',
    description: 'Enable the Firebase Cloud Messaging API on the GCP project.',
    provider: 'firebase',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'firebase:enable-firebase', required: true }],
    produces: [
      {
        key: 'enabled_fcm_api',
        label: 'FCM API',
        description: 'fcmregistrations.googleapis.com enabled',
      },
    ],
    estimatedDurationMs: 10000,
  },
  {
    type: 'step',
    key: 'firebase:configure-storage-rules',
    label: 'Configure Storage Rules',
    description: 'Deploy Cloud Storage security rules for the target environment.',
    provider: 'firebase',
    environmentScope: 'per-environment',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'firebase:enable-storage', required: true }],
    produces: [],
    estimatedDurationMs: 3000,
  },
];

export const FIREBASE_TEARDOWN_STEPS: ProvisioningStepNode[] = [
  {
    type: 'step',
    key: 'firebase:disable-messaging',
    label: 'Disable Firebase Messaging',
    description: 'Disable FCM configuration and messaging integrations.',
    provider: 'firebase',
    environmentScope: 'global',
    automationLevel: 'assisted',
    direction: 'teardown',
    teardownOf: 'firebase:enable-fcm',
    dependencies: [],
    produces: [],
  },
  {
    type: 'step',
    key: 'firebase:delete-storage-buckets',
    label: 'Delete Firebase Storage',
    description: 'Remove storage buckets and associated rules for this project.',
    provider: 'firebase',
    environmentScope: 'global',
    automationLevel: 'assisted',
    direction: 'teardown',
    teardownOf: 'firebase:configure-storage-rules',
    dependencies: [],
    produces: [],
  },
  {
    type: 'step',
    key: 'firebase:delete-firestore-db',
    label: 'Delete Firestore Database',
    description: 'Delete the Firestore database instance and all its data.',
    provider: 'firebase',
    environmentScope: 'global',
    automationLevel: 'full',
    direction: 'teardown',
    teardownOf: 'firebase:create-firestore-db',
    dependencies: [],
    produces: [],
  },
  {
    type: 'step',
    key: 'firebase:delete-gcp-project',
    label: 'Delete GCP Project',
    description: 'Delete the backing GCP/Firebase project and all managed resources.',
    provider: 'firebase',
    environmentScope: 'global',
    automationLevel: 'assisted',
    direction: 'teardown',
    teardownOf: 'firebase:create-gcp-project',
    dependencies: [
      { nodeKey: 'firebase:delete-storage-buckets', required: true },
      { nodeKey: 'firebase:delete-firestore-db', required: true },
      { nodeKey: 'firebase:disable-messaging', required: true },
    ],
    produces: [],
  },
];
