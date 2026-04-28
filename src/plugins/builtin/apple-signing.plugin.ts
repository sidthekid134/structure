import type { PluginDefinition } from '../plugin-types.js';
import { APPLE_STEPS, APPLE_TEARDOWN_STEPS, USER_ACTIONS } from '../../provisioning/step-registry.js';
import { APPLE_SIGNING_FLOW } from '../../flows/apple-signing.flow.js';

export const appleSigningPlugin: PluginDefinition = {
  id: 'apple-signing',
  version: '1.0.0',
  label: 'Apple Signing',
  description: 'Apple Developer, App ID, signing certificates, provisioning profiles, and ASC API key.',
  provider: 'apple',
  providerMeta: {
    label: 'Apple',
    scope: 'organization',
    secretKeys: [
      'asc_issuer_id',
      'asc_api_key_id',
      'asc_api_key_p8',
      'certificate_pem',
      'apns_key',
      'p12_password',
    ],
    dependsOnProviders: ['github'],
    displayMeta: {
      label: 'Apple',
      color: 'text-zinc-600 dark:text-zinc-300',
      bg: 'bg-zinc-500/10',
      border: 'border-zinc-500/30',
    },
  },
  requiredModules: [],
  optionalModules: ['eas-submit'],
  includedInTemplates: ['mobile-app'],
  platforms: ['ios'],
  steps: [
    APPLE_STEPS.find((s) => s.key === 'apple:register-app-id')!,
    // Provisioning profile creation (dev + distribution) is delegated to
    // EAS Build — see apple:store-signing-in-eas. EAS uses the org-level
    // App Store Connect Team Key to provision certs/profiles on demand.
    APPLE_STEPS.find((s) => s.key === 'apple:generate-apns-key')!,
    APPLE_STEPS.find((s) => s.key === 'apple:create-app-store-listing')!,
    APPLE_STEPS.find((s) => s.key === 'apple:configure-testflight-group')!,
    APPLE_STEPS.find((s) => s.key === 'apple:store-signing-in-eas')!,
  ],
  teardownSteps: [
    APPLE_TEARDOWN_STEPS.find((s) => s.key === 'apple:revoke-signing-assets')!,
    APPLE_TEARDOWN_STEPS.find((s) => s.key === 'apple:remove-app-store-listing')!,
  ],
  userActions: [
    USER_ACTIONS.find((a) => a.key === 'user:enroll-apple-developer')!,
  ],
  displayMeta: {
    icon: 'ShieldCheck',
    colors: {
      primary: 'zinc-500',
      text: 'text-zinc-700 dark:text-zinc-300',
      bg: 'bg-zinc-500/10',
      border: 'border-zinc-500/25',
    },
  },
  defaultJourneyPhase: 'signing_apple',
  guidedFlows: [
    {
      ...APPLE_SIGNING_FLOW,
      stepKeys: [
        'apple:generate-apns-key',
        'apple:store-signing-in-eas',
      ],
    },
  ],
  assistedStepConfigs: {
    'apple:generate-apns-key': {
      automatedPhaseDescription: 'Studio opens the Apple Developer Portal for you.',
      userPhaseDescription: 'Download the .p8 key file — it can only be downloaded once.',
      timeConstraint: {
        message: 'The .p8 key can only be downloaded once from Apple. Save it immediately.',
        urgencyLevel: 'critical',
      },
      fileUploadConfig: {
        acceptedTypes: ['.p8'],
        maxSizeKb: 10,
        validator: 'apns-key-validator',
      },
    },
  },
  resourceDisplay: {
    apple_app_id: {
      relatedLinks: [
        {
          label: 'Certificates, IDs & Profiles',
          href: 'https://developer.apple.com/account/resources/identifiers/list',
        },
      ],
    },
    apple_team_id: {
      relatedLinks: [
        { label: 'Apple Developer', href: 'https://developer.apple.com/account' },
        { label: 'Membership details', href: 'https://developer.apple.com/account#membership' },
      ],
    },
    asc_app_id: {
      primaryHrefTemplate: 'https://appstoreconnect.apple.com/apps/{value}/appstore',
      relatedLinks: [{ label: 'App Store Connect', href: 'https://appstoreconnect.apple.com/' }],
    },
    apple_auth_key_p8_apns: {
      sensitive: true,
    },
    apple_auth_key_p8_sign_in_with_apple: {
      sensitive: true,
    },
    asc_api_key_p8: {
      sensitive: true,
    },
    apple_distribution_cert_id: {
      relatedLinks: [
        {
          label: 'EAS iOS credentials',
          hrefTemplate:
            'https://expo.dev/accounts/{upstream.expo_account}/projects/{upstream.eas_project_slug}/credentials',
        },
        {
          label: 'Apple Developer certificates',
          href: 'https://developer.apple.com/account/resources/certificates/list',
        },
      ],
    },
    apple_distribution_cert_serial: {
      relatedLinks: [
        {
          label: 'Apple Developer certificates',
          href: 'https://developer.apple.com/account/resources/certificates/list',
        },
      ],
    },
    apple_app_store_profile_id: {
      relatedLinks: [
        {
          label: 'EAS iOS credentials',
          hrefTemplate:
            'https://expo.dev/accounts/{upstream.expo_account}/projects/{upstream.eas_project_slug}/credentials',
        },
        {
          label: 'Apple Developer profiles',
          href: 'https://developer.apple.com/account/resources/profiles/list',
        },
      ],
    },
    eas_ios_build_credentials_id: {
      relatedLinks: [
        {
          label: 'EAS iOS credentials',
          hrefTemplate:
            'https://expo.dev/accounts/{upstream.expo_account}/projects/{upstream.eas_project_slug}/credentials',
        },
      ],
    },
  },
  completionPortalLinks: {
    'user:enroll-apple-developer': [
      {
        label: 'Apple Developer Program',
        href: 'https://developer.apple.com/programs/enroll/',
      },
    ],
    'apple:create-app-store-listing': [
      {
        label: 'App Store Connect - Apps',
        href: 'https://appstoreconnect.apple.com/apps',
      },
      {
        label: 'Create TestFlight groups and testers',
        href: 'https://appstoreconnect.apple.com/access/testers',
      },
    ],
    'apple:configure-testflight-group': [
      {
        label: 'Open the created group',
        hrefTemplate:
          'https://appstoreconnect.apple.com/apps/{upstream.asc_app_id}/testflight/groups/{upstream.testflight_group_id}',
      },
      {
        label: 'TestFlight groups for this app',
        hrefTemplate:
          'https://appstoreconnect.apple.com/apps/{upstream.asc_app_id}/testflight/groups',
      },
      {
        label: 'TestFlight (this app)',
        hrefTemplate:
          'https://appstoreconnect.apple.com/apps/{upstream.asc_app_id}/testflight/ios',
      },
      {
        label: 'App Store Connect testers (account)',
        href: 'https://appstoreconnect.apple.com/access/testers',
      },
    ],
    'apple:register-app-id': [
      {
        label: 'Identifiers (App IDs)',
        href: 'https://developer.apple.com/account/resources/identifiers/list',
      },
      {
        label: 'Certificates',
        href: 'https://developer.apple.com/account/resources/certificates/list',
      },
    ],
    'apple:generate-apns-key': [
      {
        label: 'Apple Developer Keys',
        href: 'https://developer.apple.com/account/resources/authkeys/list',
      },
      {
        label: 'Firebase Cloud Messaging (Apple)',
        href: 'https://console.firebase.google.com/',
      },
    ],
    'apple:store-signing-in-eas': [
      {
        label: 'EAS project credentials (iOS)',
        hrefTemplate:
          'https://expo.dev/accounts/{upstream.expo_account}/projects/{upstream.eas_project_slug}/credentials',
      },
      {
        label: 'EAS project dashboard',
        hrefTemplate: 'https://expo.dev/projects/{upstream.eas_project_id}',
      },
      {
        label: 'EAS-managed iOS credentials docs',
        href: 'https://docs.expo.dev/app-signing/app-credentials/',
      },
      {
        label: 'Expo FYI: setup Xcode signing',
        href: 'https://github.com/expo/fyi/blob/main/setup-xcode-signing.md',
      },
      {
        label: 'Apple Developer certificates (where EAS\u2011managed certs appear)',
        href: 'https://developer.apple.com/account/resources/certificates/list',
      },
      {
        label: 'Apple Developer profiles (where EAS\u2011managed profiles appear)',
        href: 'https://developer.apple.com/account/resources/profiles/list',
      },
    ],
    'apple:revoke-signing-assets': [
      {
        label: 'Apple Developer certificates/profiles/keys',
        href: 'https://developer.apple.com/account/resources',
      },
      {
        label: 'App Store Connect API keys',
        href: 'https://appstoreconnect.apple.com/access/integrations/api',
      },
    ],
    'apple:remove-app-store-listing': [
      {
        label: 'App Store Connect apps',
        href: 'https://appstoreconnect.apple.com/apps',
      },
    ],
  },
  functionGroup: {
    id: 'mobile',
    label: 'Mobile & App Stores',
    description: 'Mobile build, signing, and store publishing',
    order: 3,
  },
};
