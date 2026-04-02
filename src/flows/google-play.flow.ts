/**
 * Google Play Guided Flow Definition
 *
 * 4-step guided flow for setting up Google Play publishing:
 *   1. Create Service Account in GCP Console
 *   2. Download Service Account JSON Key
 *   3. Upload Service Account JSON
 *   4. Upload Initial AAB — CRITICAL BOTTLENECK: must be manual first time
 */

import type { FlowDefinition } from './flow-definition-types.js';

export const GOOGLE_PLAY_FLOW: FlowDefinition = {
  flow_type: 'google_play',
  label: 'Google Play Setup',
  description:
    'Set up automated Google Play publishing. Includes a required one-time manual AAB upload to initialize your Play Console listing.',
  steps: [
    {
      step_number: 1,
      step_key: 'create-service-account',
      title: 'Create Google Play Service Account',
      description:
        'Create a service account in Google Cloud Console with permissions to publish apps to Google Play.',
      instructions: [
        { number: 1, text: 'Open Google Cloud Console for your GCP project.' },
        { number: 2, text: 'Go to IAM & Admin → Service Accounts.' },
        { number: 3, text: 'Click "Create Service Account".' },
        { number: 4, text: 'Enter a name (e.g., "play-publisher") and description.' },
        { number: 5, text: 'Click "Create and continue".' },
        { number: 6, text: 'Add the role "Service Account User" and click Continue.' },
        { number: 7, text: 'Click Done to create the service account.' },
        {
          number: 8,
          text: 'In Google Play Console, go to Setup → API access and link the service account.',
        },
        {
          number: 9,
          text: 'Grant the service account "Release Manager" permissions in Play Console.',
        },
      ],
      portal_url: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
      is_optional: false,
      dependencies: [],
    },
    {
      step_number: 2,
      step_key: 'download-service-account-key',
      title: 'Download Service Account Key',
      description:
        'Download the JSON key for your service account. Store it securely — it grants API access to your Play Console.',
      instructions: [
        { number: 1, text: 'In Google Cloud Console, open IAM & Admin → Service Accounts.' },
        { number: 2, text: 'Click the service account you just created.' },
        { number: 3, text: 'Go to the "Keys" tab.' },
        { number: 4, text: 'Click "Add Key" → "Create new key".' },
        { number: 5, text: 'Select JSON format and click Create.' },
        {
          number: 6,
          text: 'Save the downloaded JSON file securely. Do not commit it to source control.',
          warning: '⚠️ This file grants full API access to your Play Console account. Treat it like a password.',
        },
      ],
      portal_url: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
      is_optional: false,
      dependencies: ['create-service-account'],
    },
    {
      step_number: 3,
      step_key: 'upload-service-account-json',
      title: 'Upload Service Account JSON',
      description: 'Upload the Google Play service account JSON key file.',
      instructions: [
        { number: 1, text: 'Locate the JSON key file you downloaded in the previous step.' },
        { number: 2, text: 'Click "Choose file" and select the JSON file.' },
        { number: 3, text: 'Click Upload to validate and store the key securely.' },
      ],
      is_optional: false,
      file_upload_config: {
        accepted_types: ['.json', 'application/json'],
        max_size_kb: 10,
        validator: 'google_play_service_account',
      },
      dependencies: ['download-service-account-key'],
    },
    {
      step_number: 4,
      step_key: 'upload-initial-aab',
      title: 'Upload Initial AAB to Play Console',
      description:
        'Manually upload your first App Bundle (AAB) to Google Play Console to initialize the app listing. ' +
        'After this one-time step, all future uploads can be automated.',
      instructions: [
        { number: 1, text: 'Build your Android app in release mode to produce an .aab file.' },
        { number: 2, text: 'Open Google Play Console and go to your app.' },
        { number: 3, text: 'Go to Production (or Internal Testing) → Create new release.' },
        { number: 4, text: 'Upload your .aab file.' },
        { number: 5, text: 'Fill in release notes.' },
        { number: 6, text: 'Click "Review release" and then "Start rollout to Production".' },
        {
          number: 7,
          text: 'Once submitted, return here and click "Confirm initial upload done".',
        },
      ],
      portal_url: 'https://play.google.com/console/developers',
      is_optional: false,
      bottleneck_explanation:
        'Google Play requires the first version of your app to be uploaded manually via the Play Console. ' +
        'This is a platform limitation enforced by Google to verify your app before enabling the publishing API. ' +
        'After the initial upload, all future app versions can be published automatically through the Google Play Developer API.',
      dependencies: ['upload-service-account-json'],
    },
  ],
};
