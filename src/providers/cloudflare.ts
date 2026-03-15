/**
 * Cloudflare adapter — configures DNS records, deep link routes, and SSL/TLS
 * settings for the application domain.
 */

import * as crypto from 'crypto';
import {
  ProviderAdapter,
  CloudflareManifestConfig,
  ProviderState,
  DriftReport,
  DriftDifference,
  ReconcileDirection,
  AdapterError,
} from './types.js';
import { createOperationLogger } from '../logger.js';
import type { LoggingCallback } from '../types.js';

// ---------------------------------------------------------------------------
// API client interface
// ---------------------------------------------------------------------------

export interface DnsRecord {
  type: 'A' | 'CNAME' | 'TXT';
  name: string;
  content: string;
}

export interface CloudflareApiClient {
  getZoneId(domain: string): Promise<string | null>;
  createZone(domain: string): Promise<string>;
  addDnsRecord(zoneId: string, record: DnsRecord): Promise<string>;
  getDnsRecords(zoneId: string): Promise<DnsRecord[]>;
  setPageRule(zoneId: string, url: string, action: string): Promise<string>;
  getPageRules(zoneId: string): Promise<Array<{ url: string; action: string }>>;
  setSslMode(zoneId: string, mode: CloudflareManifestConfig['ssl_mode']): Promise<void>;
}

export class StubCloudflareApiClient implements CloudflareApiClient {
  async getZoneId(_domain: string): Promise<string | null> {
    return null;
  }

  async createZone(domain: string): Promise<string> {
    return `zone-${domain.replace(/\./g, '-')}-${Date.now()}`;
  }

  async addDnsRecord(_zoneId: string, record: DnsRecord): Promise<string> {
    return `record-${record.name}-${Date.now()}`;
  }

  async getDnsRecords(_zoneId: string): Promise<DnsRecord[]> {
    return [];
  }

  async setPageRule(_zoneId: string, _url: string, _action: string): Promise<string> {
    return `rule-${Date.now()}`;
  }

  async getPageRules(
    _zoneId: string,
  ): Promise<Array<{ url: string; action: string }>> {
    return [];
  }

  async setSslMode(_zoneId: string, _mode: CloudflareManifestConfig['ssl_mode']): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Cloudflare adapter
// ---------------------------------------------------------------------------

export class CloudflareAdapter implements ProviderAdapter<CloudflareManifestConfig> {
  private readonly log: ReturnType<typeof createOperationLogger>;

  constructor(
    private readonly apiClient: CloudflareApiClient = new StubCloudflareApiClient(),
    loggingCallback?: LoggingCallback,
  ) {
    this.log = createOperationLogger('CloudflareAdapter', loggingCallback);
  }

  async provision(config: CloudflareManifestConfig): Promise<ProviderState> {
    this.log.info('Starting Cloudflare provisioning', { domain: config.domain });

    const now = Date.now();
    const state: ProviderState = {
      provider_id: `cloudflare-${config.domain}`,
      provider_type: 'cloudflare',
      resource_ids: {},
      config_hashes: { config: this.hashConfig(config) },
      credential_metadata: {},
      partially_complete: false,
      failed_steps: [],
      completed_steps: [],
      created_at: now,
      updated_at: now,
    };

    try {
      // Step 1: Get or create zone
      let zoneId = await this.apiClient.getZoneId(config.domain);
      if (!zoneId) {
        zoneId = await this.apiClient.createZone(config.domain);
        this.log.info('Cloudflare zone created', { domain: config.domain, zoneId });
      }
      state.resource_ids['zone_id'] = zoneId;
      state.resource_ids['domain'] = config.domain;
      state.completed_steps.push('create_zone');

      // Step 2: Configure SSL/TLS
      try {
        await this.apiClient.setSslMode(zoneId, config.ssl_mode);
        state.resource_ids['ssl_mode'] = config.ssl_mode;
        state.completed_steps.push('set_ssl_mode');
      } catch (err) {
        state.failed_steps.push('set_ssl_mode');
        state.partially_complete = true;
        this.log.error('Failed to set SSL mode', { error: (err as Error).message });
      }

      // Step 3: Configure deep link routes
      for (const route of config.deep_link_routes) {
        try {
          const ruleId = await this.apiClient.setPageRule(
            zoneId,
            `${config.domain}${route}`,
            'forward_url',
          );
          state.resource_ids[`route_${route}`] = ruleId;
          state.completed_steps.push(`add_route_${route}`);
          this.log.info('Deep link route configured', { route });
        } catch (err) {
          state.failed_steps.push(`add_route_${route}`);
          state.partially_complete = true;
          this.log.error('Failed to configure deep link route', {
            route,
            error: (err as Error).message,
          });
        }
      }

      state.updated_at = Date.now();
      return state;
    } catch (err) {
      throw new AdapterError(
        `Cloudflare provisioning failed: ${(err as Error).message}`,
        'cloudflare',
        'provision',
        err,
      );
    }
  }

  async validate(
    manifest: CloudflareManifestConfig,
    liveState: ProviderState | null,
  ): Promise<DriftReport> {
    const differences: DriftDifference[] = [];

    if (!liveState) {
      return {
        provider_id: `cloudflare-${manifest.domain}`,
        provider_type: 'cloudflare',
        manifest_state: manifest,
        live_state: null,
        differences: [
          {
            field: 'domain',
            manifest_value: manifest.domain,
            live_value: null,
            conflict_type: 'missing_in_live',
          },
        ],
        orphaned_resources: [],
        requires_user_decision: false,
      };
    }

    const zoneId = liveState.resource_ids['zone_id'];
    if (!zoneId) {
      differences.push({
        field: 'zone_id',
        manifest_value: manifest.domain,
        live_value: null,
        conflict_type: 'missing_in_live',
      });
      return {
        provider_id: liveState.provider_id,
        provider_type: 'cloudflare',
        manifest_state: manifest,
        live_state: liveState,
        differences,
        orphaned_resources: [],
        requires_user_decision: false,
      };
    }

    // Check SSL mode
    const liveSslMode = liveState.resource_ids['ssl_mode'];
    if (liveSslMode !== manifest.ssl_mode) {
      differences.push({
        field: 'ssl_mode',
        manifest_value: manifest.ssl_mode,
        live_value: liveSslMode ?? null,
        conflict_type: liveSslMode ? 'value_mismatch' : 'missing_in_live',
      });
    }

    // Check routes
    const liveRules = await this.apiClient.getPageRules(zoneId);
    const liveRuleUrls = new Set(liveRules.map(r => r.url));

    for (const route of manifest.deep_link_routes) {
      const fullUrl = `${manifest.domain}${route}`;
      if (!liveRuleUrls.has(fullUrl)) {
        differences.push({
          field: `route.${route}`,
          manifest_value: route,
          live_value: null,
          conflict_type: 'missing_in_live',
        });
      }
    }

    return {
      provider_id: liveState.provider_id,
      provider_type: 'cloudflare',
      manifest_state: manifest,
      live_state: liveState,
      differences,
      orphaned_resources: [],
      requires_user_decision: false,
    };
  }

  async reconcile(
    report: DriftReport,
    direction: ReconcileDirection,
  ): Promise<ProviderState> {
    const manifest = report.manifest_state as CloudflareManifestConfig;

    if (!report.live_state) {
      return this.provision(manifest);
    }

    if (direction === 'manifest→live') {
      const zoneId = report.live_state.resource_ids['zone_id'];
      if (zoneId) {
        for (const diff of report.differences) {
          if (diff.conflict_type === 'missing_in_live' || diff.conflict_type === 'value_mismatch') {
            if (diff.field === 'ssl_mode') {
              await this.apiClient.setSslMode(zoneId, manifest.ssl_mode);
              report.live_state.resource_ids['ssl_mode'] = manifest.ssl_mode;
            } else if (diff.field.startsWith('route.')) {
              const route = diff.field.replace('route.', '');
              const ruleId = await this.apiClient.setPageRule(
                zoneId,
                `${manifest.domain}${route}`,
                'forward_url',
              );
              report.live_state.resource_ids[`route_${route}`] = ruleId;
            }
          }
        }
      }
    }

    report.live_state.updated_at = Date.now();
    return report.live_state;
  }

  async extractCredentials(state: ProviderState): Promise<Record<string, string>> {
    return {
      zone_id: state.resource_ids['zone_id'] ?? '',
      domain: state.resource_ids['domain'] ?? '',
    };
  }

  private hashConfig(config: CloudflareManifestConfig): string {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(config))
      .digest('hex')
      .slice(0, 16);
  }
}
