/**
 * Apple Signing Guided Flow Definition
 *
 * 6-step guided flow for setting up Apple code signing:
 *   1. Create App ID in Apple Developer Portal
 *   2. Enable Signing Capability
 *   3. Create Certificate
 *   4. Download .p8 Key (APNs / Sign In with Apple) — one-time download warning
 *   5. Upload .p8 File
 *   6. Verify Credentials
 */

import type { FlowDefinition } from './flow-definition-types.js';

export const APPLE_SIGNING_FLOW: FlowDefinition = {
  flow_type: 'apple_signing',
  label: 'Apple Signing Setup',
  description:
    'Set up Apple code signing for iOS app distribution via the App Store and TestFlight.',
  steps: [
    {
      step_number: 1,
      step_key: 'create-app-id',
      title: 'Create App ID',
      description:
        'Register a unique App ID (Bundle ID) for your iOS app in the Apple Developer Portal.',
      instructions: [
        { number: 1, text: 'Sign in to Apple Developer Portal.' },
        { number: 2, text: 'Go to Certificates, Identifiers & Profiles → Identifiers.' },
        { number: 3, text: 'Click the + button to register a new identifier.' },
        { number: 4, text: 'Select "App IDs" and click Continue.' },
        { number: 5, text: 'Enter your Bundle ID (e.g., com.yourcompany.yourapp).' },
        { number: 6, text: 'Enable the capabilities your app uses (e.g., Push Notifications, Sign In with Apple).' },
        { number: 7, text: 'Click Register to create the App ID.' },
      ],
      portal_url: 'https://developer.apple.com/account/resources/identifiers/list',
      is_optional: false,
      dependencies: [],
    },
    {
      step_number: 2,
      step_key: 'enable-signing-capability',
      title: 'Enable Signing Capability',
      description:
        'Ensure Push Notifications and Sign In with Apple capabilities are enabled for your App ID.',
      instructions: [
        { number: 1, text: 'In the Identifiers list, click your App ID.' },
        { number: 2, text: 'Under Capabilities, check "Push Notifications".' },
        { number: 3, text: 'If using Sign In with Apple, also check "Sign In with Apple".' },
        { number: 4, text: 'Click Save.' },
      ],
      portal_url: 'https://developer.apple.com/account/resources/identifiers/list',
      is_optional: false,
      dependencies: ['create-app-id'],
    },
    {
      step_number: 3,
      step_key: 'create-certificate',
      title: 'Create Distribution Certificate',
      description:
        'Create an Apple Distribution certificate for signing your app for App Store submission.',
      instructions: [
        { number: 1, text: 'Go to Certificates, Identifiers & Profiles → Certificates.' },
        { number: 2, text: 'Click the + button.' },
        { number: 3, text: 'Under Software, select "Apple Distribution" for App Store / Ad Hoc.' },
        { number: 4, text: 'Follow the CSR (Certificate Signing Request) instructions.' },
        { number: 5, text: 'Upload your CSR file and click Continue.' },
        { number: 6, text: 'Download and install the certificate.' },
      ],
      portal_url: 'https://developer.apple.com/account/resources/certificates/list',
      is_optional: false,
      dependencies: ['create-app-id'],
    },
    {
      step_number: 4,
      step_key: 'create-apns-key',
      title: 'Create APNs Key',
      description:
        'Create an APNs Authentication Key (.p8 file) for push notifications. ' +
        'This key can only be downloaded once — save it securely.',
      instructions: [
        { number: 1, text: 'Go to Certificates, Identifiers & Profiles → Keys.' },
        { number: 2, text: 'Click the + button to create a new key.' },
        { number: 3, text: 'Enter a key name (e.g., "APNs Key for MyApp").' },
        { number: 4, text: 'Check "Apple Push Notifications service (APNs)".' },
        {
          number: 5,
          text: 'Click Continue, then Register.',
          warning:
            '⚠️ IMPORTANT: The .p8 key file can only be downloaded ONCE. ' +
            'If you lose it, you must revoke the key and create a new one.',
        },
        { number: 6, text: 'Click "Download Key" to save the .p8 file.' },
        { number: 7, text: 'Note the Key ID shown on the page (e.g., ABCD123456).' },
      ],
      portal_url: 'https://developer.apple.com/account/resources/authkeys/list',
      is_optional: false,
      dependencies: ['create-app-id'],
    },
    {
      step_number: 5,
      step_key: 'upload-p8-key',
      title: 'Upload .p8 Key File',
      description: 'Upload the APNs .p8 key file you downloaded in the previous step.',
      instructions: [
        { number: 1, text: 'Locate the .p8 file you downloaded from Apple Developer Portal.' },
        {
          number: 2,
          text: 'Enter your Key ID (10 uppercase alphanumeric characters) and Team ID.',
        },
        { number: 3, text: 'Click "Choose file" and select your .p8 file.' },
        { number: 4, text: 'Click Upload to validate and store the key securely.' },
      ],
      is_optional: false,
      file_upload_config: {
        accepted_types: ['.p8', 'application/pkcs8', 'text/plain'],
        max_size_kb: 4,
        validator: 'apple_p8',
      },
      dependencies: ['create-apns-key'],
    },
    {
      step_number: 6,
      step_key: 'verify-credentials',
      title: 'Verify Credentials',
      description:
        'Confirm that all Apple signing credentials are valid and ready for automated provisioning.',
      instructions: [
        { number: 1, text: 'Review the credentials listed above.' },
        { number: 2, text: 'Ensure the App ID, certificate, and APNs key are all present.' },
        { number: 3, text: 'Click "Mark as verified" to confirm and unblock the provisioning pipeline.' },
      ],
      is_optional: false,
      dependencies: ['upload-p8-key'],
    },
  ],
};
