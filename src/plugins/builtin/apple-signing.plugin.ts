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
    secretKeys: ['certificate_pem', 'apns_key', 'p12_password'],
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
  steps: [
    APPLE_STEPS.find((s) => s.key === 'apple:register-app-id')!,
    APPLE_STEPS.find((s) => s.key === 'apple:create-dev-provisioning-profile')!,
    APPLE_STEPS.find((s) => s.key === 'apple:create-dist-provisioning-profile')!,
    APPLE_STEPS.find((s) => s.key === 'apple:generate-apns-key')!,
    APPLE_STEPS.find((s) => s.key === 'apple:create-app-store-listing')!,
    APPLE_STEPS.find((s) => s.key === 'apple:generate-asc-api-key')!,
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
        'apple:generate-asc-api-key',
        'apple:create-dev-provisioning-profile',
        'apple:create-dist-provisioning-profile',
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
    'apple:generate-asc-api-key': {
      automatedPhaseDescription: 'Studio creates the API key in App Store Connect.',
      userPhaseDescription: 'Download the .p8 key and upload it here.',
      timeConstraint: {
        message: 'The ASC API key can only be downloaded once. Upload it before leaving this page.',
        urgencyLevel: 'critical',
      },
      fileUploadConfig: {
        acceptedTypes: ['.p8'],
        maxSizeKb: 10,
        validator: 'asc-key-validator',
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
    apns_key_p8: {
      sensitive: true,
    },
    asc_api_key_p8: {
      sensitive: true,
    },
  },
  completionPortalLinks: {
    'user:enroll-apple-developer': [
      {
        label: 'Apple Developer Program',
        href: 'https://developer.apple.com/programs/enroll/',
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
