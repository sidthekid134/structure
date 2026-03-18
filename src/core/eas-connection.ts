import * as childProcess from 'child_process';
import { VaultManager } from '../vault.js';
import {
  ProjectManager,
  IntegrationConfigRecord,
} from '../studio/project-manager.js';

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
    return this.vaultManager.getCredential(this.getVaultPassphrase(), 'eas', 'expo_token');
  }

  storeExpoToken(token: string): void {
    if (typeof token !== 'string' || token.trim().length === 0) {
      throw new Error('Expo token is required.');
    }
    this.vaultManager.setCredential(this.getVaultPassphrase(), 'eas', 'expo_token', token.trim());
  }

  storeExpoConnectionDetails(details: ExpoConnectionDetails): void {
    const passphrase = this.getVaultPassphrase();
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
    const passphrase = this.getVaultPassphrase();
    this.vaultManager.deleteCredential(passphrase, 'eas', 'expo_user_id');
    this.vaultManager.deleteCredential(passphrase, 'eas', 'expo_username');
    this.vaultManager.deleteCredential(passphrase, 'eas', 'expo_accounts');
    this.vaultManager.deleteCredential(passphrase, 'eas', 'expo_token_last_validated_at');
  }

  deleteStoredExpoToken(): boolean {
    return this.vaultManager.deleteCredential(this.getVaultPassphrase(), 'eas', 'expo_token');
  }

  async fetchExpoConnectionDetails(token: string): Promise<ExpoConnectionDetails> {
    const stdout = await new Promise<string>((resolve, reject) => {
      childProcess.execFile(
        'npx',
        ['eas-cli', 'whoami', '--non-interactive'],
        {
          env: {
            ...process.env,
            EXPO_TOKEN: token,
          },
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        },
        (error, out, stderr) => {
          if (error) {
            const details = stderr?.trim() || out?.trim() || error.message;
            reject(new Error(`eas-cli whoami failed: ${details}`));
            return;
          }
          resolve(out);
        },
      );
    });

    const lines = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const username = lines.find(
      (line) =>
        line !== 'Accounts:' &&
        !line.startsWith('★') &&
        !line.startsWith('To upgrade') &&
        !line.startsWith('Proceeding with outdated version'),
    );
    if (!username) {
      throw new Error(`Unable to parse username from eas-cli output: ${stdout}`);
    }

    const accountNames = lines
      .map((line) => {
        const match = line.match(/^[•*-]\s*(.+?)\s+\(Role:/);
        return match?.[1]?.trim() ?? null;
      })
      .filter((value): value is string => Boolean(value));

    return {
      // Use username as stable identifier in Studio since whoami output does not expose UUID.
      userId: username,
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

  private getVaultPassphrase(): string {
    const passphrase = process.env['STUDIO_VAULT_PASSPHRASE']?.trim();
    if (!passphrase) {
      throw new Error(
        'STUDIO_VAULT_PASSPHRASE is required to use Studio credential storage for EAS tokens.',
      );
    }
    return passphrase;
  }
}
