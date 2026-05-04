import { VaultManager } from '../vault.js';
import {
  ProjectManager,
  IntegrationConfigRecord,
} from '../studio/project-manager.js';
import { getVaultUnlock as resolveVaultUnlock } from '../studio/vault-session.js';

const EXPO_GRAPHQL_URL =
  process.env['EXPO_STAGING'] === '1' || process.env['EXPO_STAGING'] === 'true'
    ? 'https://staging-api.expo.dev/graphql'
    : 'https://api.expo.dev/graphql';

const CURRENT_ACTOR_QUERY = `
  query StudioEasConnectionCurrentActor {
    meActor {
      __typename
      id
      accounts {
        id
        name
      }
    }
  }
`;

interface CurrentActorResponse {
  data?: {
    meActor?: {
      __typename?: string | null;
      id?: string | null;
      accounts?: Array<{ id?: string | null; name?: string | null }> | null;
    } | null;
  };
  errors?: Array<{ message?: string | null }> | null;
}

export interface ExpoConnectionDetails {
  userId: string;
  username: string;
  accountNames: string[];
}

export interface EasConnectionStatus {
  available: boolean;
  connected: boolean;
  requires_token: boolean;
  details?: Omit<ExpoConnectionDetails, 'userId'>;
  integration?: IntegrationConfigRecord;
}

export class EasConnectionService {
  constructor(
    private readonly vaultManager: VaultManager,
    private readonly projectManager: ProjectManager,
  ) {}

  getStoredExpoToken(): string | undefined {
    return this.vaultManager.getCredential(resolveVaultUnlock(), 'eas', 'expo_token');
  }

  getStoredExpoUsername(): string | undefined {
    const raw = this.vaultManager.getCredential(resolveVaultUnlock(), 'eas', 'expo_username');
    const username = raw?.trim();
    return username || undefined;
  }

  getStoredExpoAccountNames(): string[] {
    const raw = this.vaultManager.getCredential(resolveVaultUnlock(), 'eas', 'expo_accounts');
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((v) => (typeof v === 'string' ? v.trim() : ''))
        .filter((v) => v.length > 0);
    } catch {
      return [];
    }
  }

  storeExpoToken(token: string): void {
    if (typeof token !== 'string' || token.trim().length === 0) {
      throw new Error('Expo token is required.');
    }
    this.vaultManager.setCredential(resolveVaultUnlock(), 'eas', 'expo_token', token.trim());
  }

  storeExpoConnectionDetails(details: ExpoConnectionDetails): void {
    const passphrase = resolveVaultUnlock();
    this.vaultManager.setCredential(passphrase, 'eas', 'expo_user_id', details.userId);
    this.vaultManager.setCredential(passphrase, 'eas', 'expo_username', details.username);
    this.vaultManager.setCredential(passphrase, 'eas', 'expo_accounts', JSON.stringify(details.accountNames));
    this.vaultManager.setCredential(
      passphrase,
      'eas',
      'expo_token_last_validated_at',
      new Date().toISOString(),
    );
  }

  deleteStoredExpoConnectionDetails(): void {
    const passphrase = resolveVaultUnlock();
    this.vaultManager.deleteCredential(passphrase, 'eas', 'expo_user_id');
    this.vaultManager.deleteCredential(passphrase, 'eas', 'expo_username');
    this.vaultManager.deleteCredential(passphrase, 'eas', 'expo_accounts');
    this.vaultManager.deleteCredential(passphrase, 'eas', 'expo_token_last_validated_at');
  }

  deleteStoredExpoToken(): boolean {
    return this.vaultManager.deleteCredential(resolveVaultUnlock(), 'eas', 'expo_token');
  }

  async fetchExpoConnectionDetails(token: string): Promise<ExpoConnectionDetails> {
    const response = await fetch(EXPO_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'StructureStudio/1.0 (EAS connection validation)',
      },
      body: JSON.stringify({ query: CURRENT_ACTOR_QUERY, variables: {} }),
    });

    if (!response.ok) {
      throw new Error(`Expo token validation failed: HTTP ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as CurrentActorResponse;
    if (payload.errors && payload.errors.length > 0) {
      const message = payload.errors
        .map((item) => item.message?.trim() ?? '')
        .filter((item) => item.length > 0)
        .join('; ');
      throw new Error(`Expo token validation failed: ${message || 'Unknown GraphQL error'}`);
    }

    const actor = payload.data?.meActor;
    if (!actor) {
      throw new Error('Expo token validation failed: GraphQL response did not include meActor.');
    }

    const accountNames = (actor.accounts ?? [])
      .map((entry) => entry.name?.trim() ?? '')
      .filter((name) => name.length > 0);

    const username = accountNames[0];
    if (!username) {
      throw new Error('Expo token validation failed: token has no accessible Expo accounts.');
    }

    return {
      userId: actor.id?.trim() || username,
      username,
      accountNames,
    };
  }

  async syncExpoIntegrationFromCredentialStore(
    tokenOverride?: string,
    detailsOverride?: ExpoConnectionDetails,
  ): Promise<EasConnectionStatus> {
    const token = tokenOverride ?? this.getStoredExpoToken();
    if (!token) {
      return { available: false, connected: false, requires_token: true };
    }

    const details = detailsOverride ?? await this.fetchExpoConnectionDetails(token);
    const organization = this.projectManager.getOrganization();
    if (!organization.integrations.eas) {
      this.projectManager.addOrganizationIntegration('eas');
    }

    const updatedOrganization = this.projectManager.updateOrganizationIntegration('eas', {
      status: 'configured',
      notes: `Connected via stored expo_token for ${details.username}. Expo account metadata is encrypted in credential vault.`,
      config: {
        token_source: 'credential_vault',
      },
    });

    return {
      available: true,
      connected: true,
      requires_token: false,
      details: {
        username: details.username,
        accountNames: details.accountNames,
      },
      integration: updatedOrganization.integrations.eas,
    };
  }

  async connect(token: string): Promise<EasConnectionStatus> {
    if (!token || !token.trim()) {
      throw new Error('Expo token is required.');
    }
    const normalizedToken = token.trim();
    const details = await this.fetchExpoConnectionDetails(normalizedToken);
    this.storeExpoToken(normalizedToken);
    this.storeExpoConnectionDetails(details);
    return this.syncExpoIntegrationFromCredentialStore(normalizedToken, details);
  }

  disconnect(): EasConnectionStatus & { removed: boolean } {
    const removed = this.deleteStoredExpoToken();
    this.deleteStoredExpoConnectionDetails();
    const organization = this.projectManager.getOrganization();
    let integration: IntegrationConfigRecord | undefined;

    if (organization.integrations.eas) {
      const updated = this.projectManager.updateOrganizationIntegration('eas', {
        status: 'pending',
        notes: 'EAS connection disabled. Reconnect with a token to configure this module.',
        config: {},
        replaceConfig: true,
      });
      integration = updated.integrations.eas;
    }

    return {
      removed,
      available: false,
      connected: false,
      requires_token: true,
      integration,
    };
  }

}
