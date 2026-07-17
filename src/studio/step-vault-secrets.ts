/**
 * Registry mapping provisioning step keys → the credential-stored secret values
 * those steps upload to a third-party system (GitHub repo/env secrets, etc.).
 *
 * Used by the Studio API to expose:
 *   - GET  .../provisioning/steps/:stepKey/secrets         (metadata only)
 *   - POST .../provisioning/steps/:stepKey/secrets/:name/reveal  (plaintext)
 */

import type { CredentialService } from '../services/credential-service.js';
import type { CredentialType } from '../services/credential-service.js';

export type StepSecretContentType = 'text' | 'json';

export interface StepSecretDescriptor {
  /** Stable identifier within a step (matches the third-party secret name). */
  name: string;
  /** UI label, e.g. "EXPO_TOKEN". */
  label: string;
  /** Short human description of where it ends up. */
  description: string;
  /** Where the value gets uploaded by the step (used in UI badge). */
  destination: string;
  /** CredentialType for org-level lookup, or null for project-level. */
  credentialType: CredentialType;
  /** If true, look up at org scope ('__organization__'); else use the request projectId. */
  orgScope: boolean;
  /** Hint to UI for how to render/copy (e.g. JSON gets pretty-printed). */
  contentType: StepSecretContentType;
}

/**
 * stepKey → list of secrets uploaded by the step.
 *
 * Order matters: it is the order shown in the UI.
 */
const STEP_SECRETS: Readonly<Record<string, readonly StepSecretDescriptor[]>> = {
  'eas:store-token-in-github': [
    {
      name: 'EXPO_TOKEN',
      label: 'EXPO_TOKEN',
      description:
        'Expo robot token written at the GitHub repository level (one value, shared by every workflow job — env-level secrets are not used because the same token applies to every environment). Read by `expo/expo-github-action@v8` and `eas-cli` in workflows.',
      destination: 'GitHub repository secret',
      credentialType: 'expo_token',
      orgScope: true,
      contentType: 'text',
    },
  ],
  'github:inject-secrets': [
    {
      name: 'FIREBASE_SERVICE_ACCOUNT',
      label: 'FIREBASE_SERVICE_ACCOUNT',
      description:
        'Firebase service-account JSON written at the GitHub environment level (one copy per project env). Used by deploy/build workflows to authenticate to GCP/Firebase. Env-scoped because preview vs production typically point at different Firebase projects.',
      destination: 'GitHub environment secret',
      credentialType: 'gcp_service_account_json',
      orgScope: false,
      contentType: 'json',
    },
  ],
};

export function getStepSecretDescriptors(stepKey: string): readonly StepSecretDescriptor[] {
  return STEP_SECRETS[stepKey] ?? [];
}

export function findStepSecretDescriptor(
  stepKey: string,
  secretName: string,
): StepSecretDescriptor | undefined {
  return getStepSecretDescriptors(stepKey).find((s) => s.name === secretName);
}

export interface StepSecretStatus extends StepSecretDescriptor {
  present: boolean;
  /** Length of the stored plaintext, when present (helps spot empty/truncated values). */
  length: number;
}

export function readStepSecretStatuses(
  credentialService: CredentialService,
  stepKey: string,
  projectId: string,
): StepSecretStatus[] {
  const descriptors = getStepSecretDescriptors(stepKey);
  return descriptors.map((descriptor) => {
    const scopeId = descriptor.orgScope ? '__organization__' : projectId;
    const value = credentialService.retrieveCredential(scopeId, descriptor.credentialType);
    return {
      ...descriptor,
      present: typeof value === 'string' && value.length > 0,
      length: typeof value === 'string' ? value.length : 0,
    };
  });
}

export function readStepSecretValue(
  credentialService: CredentialService,
  descriptor: StepSecretDescriptor,
  projectId: string,
): string | null {
  const scopeId = descriptor.orgScope ? '__organization__' : projectId;
  return credentialService.retrieveCredential(scopeId, descriptor.credentialType) ?? null;
}
