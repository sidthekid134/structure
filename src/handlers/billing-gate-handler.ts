/**
 * Billing Gate Handler
 *
 * Checks GCP billing status and provides inline setup instructions
 * for enabling billing on a GCP project.
 */

import { checkBillingEnabled, GcpHttpError } from '../core/gcp/gcp-api-client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BillingSetupInstructions {
  already_enabled: boolean;
  billing_account_name: string | null;
  instructions: string[];
  console_url: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Returns inline billing setup instructions and checks whether billing
 * is already enabled on the GCP project.
 *
 * If billing is enabled, returns `already_enabled: true` with the account name.
 * If not enabled, returns numbered setup instructions with a Cloud Console link.
 */
export async function getBillingSetupInstructions(
  gcpProjectId: string,
  accessToken: string,
): Promise<BillingSetupInstructions> {
  let enabled = false;
  let billingAccountName: string | null = null;

  try {
    const info = await checkBillingEnabled(accessToken, gcpProjectId);
    enabled = info.enabled;
    billingAccountName = info.billingAccountName;
  } catch (err) {
    if (err instanceof GcpHttpError && err.statusCode === 403) {
      return {
        already_enabled: false,
        billing_account_name: null,
        instructions: [
          'You do not have permission to check billing status for this project.',
          'Ask a project Owner or Billing Account Administrator to enable billing.',
          `Go to: https://console.cloud.google.com/billing/linkedaccount?project=${gcpProjectId}`,
        ],
        console_url: `https://console.cloud.google.com/billing/linkedaccount?project=${gcpProjectId}`,
      };
    }
    throw err;
  }

  if (enabled) {
    return {
      already_enabled: true,
      billing_account_name: billingAccountName,
      instructions: [],
      console_url: `https://console.cloud.google.com/billing/linkedaccount?project=${gcpProjectId}`,
    };
  }

  return {
    already_enabled: false,
    billing_account_name: null,
    instructions: [
      'Go to Google Cloud Console → Billing.',
      'Click "Link a billing account".',
      'Select or create a billing account.',
      'Click "Set account" to confirm.',
      `Direct link: https://console.cloud.google.com/billing/linkedaccount?project=${gcpProjectId}`,
    ],
    console_url: `https://console.cloud.google.com/billing/linkedaccount?project=${gcpProjectId}`,
  };
}
