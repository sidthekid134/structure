/**
 * Registry mapping provisioning step keys → the vault-stored secret values
 * those steps upload to a third-party system (GitHub repo/env secrets, etc.).
 *
 * Used by the Studio API to expose:
 *   - GET  .../provisioning/steps/:stepKey/secrets         (metadata only)
 *   - POST .../provisioning/steps/:stepKey/secrets/:name/reveal  (plaintext)
 *
 * The plaintext endpoint lets operators copy the *exact* value the
 * orchestrator would have uploaded — so a "bearer token is invalid" failure
 * downstream can be diagnosed by pasting the value into a local `eas whoami`
 * (or compared against the GitHub Secrets UI) without re-running the step.
 */

import type { VaultManager } from '../vault.js';

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
  /** Vault provider namespace (matches `vaultManager.getCredential` arg). */
  vaultProvider: string;
  /**
   * Vault credential key. May contain `{projectId}` which gets substituted
   * with the active project id at lookup time.
   */
  vaultKey: string;
  /** Hint to UI for how to render/copy (e.g. JSON gets pretty-printed). */
  contentType: StepSecretContentType;
}

/**
 * stepKey → list of secrets uploaded by the step.
 *
 * Order matters: it is the order shown in the UI. Keep `name` aligned with
 * the actual third-party secret name (this is what users will see in
 * GitHub → Settings → Secrets and variables, etc.).
 */
const STEP_SECRETS: Readonly<Record<string, readonly StepSecretDescriptor[]>> = {
  'eas:store-token-in-github': [
    {
      name: 'EXPO_TOKEN',
      label: 'EXPO_TOKEN',
      description:
        'Expo robot token written at the GitHub repository level (one value, shared by every workflow job — env-level secrets are not used because the same token applies to every environment). Read by `expo/expo-github-action@v8` and `eas-cli` in workflows.',
      destination: 'GitHub repository secret',
      vaultProvider: 'eas',
      vaultKey: 'expo_token',
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
      vaultProvider: 'firebase',
      vaultKey: '{projectId}/service_account_json',
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

function resolveVaultKey(template: string, projectId: string): string {
  return template.split('{projectId}').join(projectId);
}

export interface StepSecretStatus extends StepSecretDescriptor {
  present: boolean;
  /** Length of the stored plaintext, when present (helps spot empty/truncated values). */
  length: number;
}

export function readStepSecretStatuses(
  vaultManager: VaultManager,
  vaultPassphrase: string,
  stepKey: string,
  projectId: string,
): StepSecretStatus[] {
  const descriptors = getStepSecretDescriptors(stepKey);
  return descriptors.map((descriptor) => {
    const key = resolveVaultKey(descriptor.vaultKey, projectId);
    const value = vaultManager.getCredential(vaultPassphrase, descriptor.vaultProvider, key);
    return {
      ...descriptor,
      present: typeof value === 'string' && value.length > 0,
      length: typeof value === 'string' ? value.length : 0,
    };
  });
}

export function readStepSecretValue(
  vaultManager: VaultManager,
  vaultPassphrase: string,
  descriptor: StepSecretDescriptor,
  projectId: string,
): string | null {
  const key = resolveVaultKey(descriptor.vaultKey, projectId);
  const value = vaultManager.getCredential(vaultPassphrase, descriptor.vaultProvider, key);
  return value ?? null;
}
