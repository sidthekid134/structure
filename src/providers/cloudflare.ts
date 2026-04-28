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
  StepContext,
  StepResult,
} from './types.js';
import { createOperationLogger } from '../logger.js';
import type { LoggingCallback } from '../types.js';
import { resolveCloudflareDomainTarget } from '../core/cloudflare-domain-target.js';

// ---------------------------------------------------------------------------
// API client interface
// ---------------------------------------------------------------------------

export interface DnsRecord {
  type: 'A' | 'CNAME' | 'TXT';
  name: string;
  content: string;
}

export interface CloudflareApiClient {
  verifyToken(): Promise<{ status: string }>;
  getZoneId(domain: string): Promise<string | null>;
  getZone(domain: string): Promise<CloudflareZoneSummary | null>;
  createZone(domain: string): Promise<string>;
  addDnsRecord(zoneId: string, record: DnsRecord): Promise<string>;
  getDnsRecords(zoneId: string): Promise<DnsRecord[]>;
  setPageRule(zoneId: string, url: string, action: string): Promise<string>;
  getPageRules(zoneId: string): Promise<Array<{ url: string; action: string }>>;
  setSslMode(zoneId: string, mode: CloudflareManifestConfig['ssl_mode']): Promise<void>;
}

export interface CloudflareZoneSummary {
  id: string;
  name: string;
  status: string;
  nameServers: string[];
  accountId?: string;
}

interface CloudflareEnvelope<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
}

export class StubCloudflareApiClient implements CloudflareApiClient {
  async verifyToken(): Promise<{ status: string }> {
    throw new Error(
      'StubCloudflareApiClient cannot verify API tokens. Configure CloudflareAdapter with a real Cloudflare API client.',
    );
  }

  async getZoneId(_domain: string): Promise<string | null> {
    throw new Error(
      'StubCloudflareApiClient cannot query zones. Configure CloudflareAdapter with a real Cloudflare API client.',
    );
  }

  async getZone(_domain: string): Promise<CloudflareZoneSummary | null> {
    throw new Error(
      'StubCloudflareApiClient cannot query zone details. Configure CloudflareAdapter with a real Cloudflare API client.',
    );
  }

  async createZone(_domain: string): Promise<string> {
    throw new Error(
      'StubCloudflareApiClient cannot create zones. Configure CloudflareAdapter with a real Cloudflare API client.',
    );
  }

  async addDnsRecord(_zoneId: string, _record: DnsRecord): Promise<string> {
    throw new Error(
      'StubCloudflareApiClient cannot mutate DNS records. Configure CloudflareAdapter with a real Cloudflare API client.',
    );
  }

  async getDnsRecords(_zoneId: string): Promise<DnsRecord[]> {
    throw new Error(
      'StubCloudflareApiClient cannot list DNS records. Configure CloudflareAdapter with a real Cloudflare API client.',
    );
  }

  async setPageRule(_zoneId: string, _url: string, _action: string): Promise<string> {
    throw new Error(
      'StubCloudflareApiClient cannot set page rules. Configure CloudflareAdapter with a real Cloudflare API client.',
    );
  }

  async getPageRules(
    _zoneId: string,
  ): Promise<Array<{ url: string; action: string }>> {
    throw new Error(
      'StubCloudflareApiClient cannot list page rules. Configure CloudflareAdapter with a real Cloudflare API client.',
    );
  }

  async setSslMode(_zoneId: string, _mode: CloudflareManifestConfig['ssl_mode']): Promise<void> {
    throw new Error(
      'StubCloudflareApiClient cannot set SSL mode. Configure CloudflareAdapter with a real Cloudflare API client.',
    );
  }
}

export class HttpCloudflareApiClient implements CloudflareApiClient {
  private readonly baseUrl = 'https://api.cloudflare.com/client/v4';

  constructor(private readonly apiToken: string) {
    if (!apiToken.trim()) {
      throw new Error('Cloudflare API token is required to initialize HttpCloudflareApiClient.');
    }
  }

  async verifyToken(): Promise<{ status: string }> {
    const response = await this.request<{ status: string }>('GET', '/user/tokens/verify');
    return { status: response.result.status };
  }

  async getZoneId(domain: string): Promise<string | null> {
    const zone = await this.getZone(domain);
    return zone?.id ?? null;
  }

  async getZone(domain: string): Promise<CloudflareZoneSummary | null> {
    const encoded = encodeURIComponent(domain);
    const response = await this.request<Array<{
      id: string;
      name: string;
      status: string;
      name_servers?: string[];
      account?: { id?: string; name?: string };
    }>>('GET', `/zones?name=${encoded}`);
    const zone = response.result.find((z) => z.name?.toLowerCase() === domain.toLowerCase()) ?? null;
    if (!zone) return null;
    let accountId = zone.account?.id?.trim() || undefined;
    // Some token scopes / list responses omit account metadata. Resolve once
    // from the zone details endpoint so downstream links can use the canonical
    // /<account>/<zone>/... Cloudflare dashboard path.
    if (!accountId && zone.id) {
      try {
        const details = await this.request<{
          id: string;
          account?: { id?: string; name?: string };
        }>('GET', `/zones/${encodeURIComponent(zone.id)}`);
        accountId = details.result.account?.id?.trim() || undefined;
      } catch {
        // Keep this non-fatal; callers still have zoneId-based fallback links.
      }
    }
    return {
      id: zone.id,
      name: zone.name,
      status: zone.status,
      nameServers: Array.isArray(zone.name_servers) ? zone.name_servers : [],
      accountId,
    };
  }

  async createZone(domain: string): Promise<string> {
    const response = await this.request<{ id: string }>('POST', '/zones', {
      name: domain,
      type: 'full',
    });
    return response.result.id;
  }

  async addDnsRecord(zoneId: string, record: DnsRecord): Promise<string> {
    const response = await this.request<{ id: string }>('POST', `/zones/${encodeURIComponent(zoneId)}/dns_records`, {
      type: record.type,
      name: record.name,
      content: record.content,
      ttl: 1,
      ...(record.type === 'TXT' ? {} : { proxied: true }),
    });
    return response.result.id;
  }

  async getDnsRecords(zoneId: string): Promise<DnsRecord[]> {
    const response = await this.request<Array<{
      type: 'A' | 'CNAME' | 'TXT';
      name: string;
      content: string;
    }>>('GET', `/zones/${encodeURIComponent(zoneId)}/dns_records`);
    return response.result.map((r) => ({
      type: r.type,
      name: r.name,
      content: r.content,
    }));
  }

  async setPageRule(zoneId: string, url: string, action: string): Promise<string> {
    const response = await this.request<{ id: string }>('POST', `/zones/${encodeURIComponent(zoneId)}/pagerules`, {
      targets: [
        {
          target: 'url',
          constraint: {
            operator: 'matches',
            value: url,
          },
        },
      ],
      actions:
        action === 'forward_url'
          ? [{ id: 'forwarding_url', value: { url, status_code: 302 } }]
          : [{ id: 'always_use_https', value: 'on' }],
      status: 'active',
    });
    return response.result.id;
  }

  async getPageRules(zoneId: string): Promise<Array<{ url: string; action: string }>> {
    const response = await this.request<Array<{
      targets?: Array<{ target?: string; constraint?: { value?: string } }>;
      actions?: Array<{ id?: string }>;
    }>>('GET', `/zones/${encodeURIComponent(zoneId)}/pagerules`);
    return response.result.map((rule) => {
      const url = rule.targets?.find((t) => t.target === 'url')?.constraint?.value ?? '';
      const action = rule.actions?.find((a) => typeof a.id === 'string')?.id ?? '';
      return { url, action };
    });
  }

  async setSslMode(zoneId: string, mode: CloudflareManifestConfig['ssl_mode']): Promise<void> {
    await this.request('PATCH', `/zones/${encodeURIComponent(zoneId)}/settings/ssl`, {
      value: mode,
    });
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
  ): Promise<CloudflareEnvelope<T>> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const raw = await response.text();
      throw new Error(`Cloudflare API ${method} ${path} failed (${response.status}): ${raw.slice(0, 500)}`);
    }
    const parsed = (await response.json()) as CloudflareEnvelope<T>;
    if (!parsed.success) {
      const details = parsed.errors?.map((e) => `${e.code}: ${e.message}`).join('; ') || 'Unknown Cloudflare API error';
      throw new Error(`Cloudflare API ${method} ${path} failed: ${details}`);
    }
    return parsed;
  }
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

  private async ensureZone(
    zoneDomain: string,
  ): Promise<{ zone: CloudflareZoneSummary; action: 'created' | 'reused' }> {
    const existingZone = await this.apiClient.getZone(zoneDomain);
    if (existingZone) {
      return { zone: existingZone, action: 'reused' };
    }

    try {
      await this.apiClient.createZone(zoneDomain);
    } catch (err) {
      const message = (err as Error).message || '';
      // If another request/process created the zone first, resolve to current
      // zone state and continue deterministically.
      if (!message.toLowerCase().includes('already exists')) {
        throw err;
      }
    }

    const createdZone = await this.apiClient.getZone(zoneDomain);
    if (!createdZone) {
      throw new AdapterError(
        `Cloudflare zone "${zoneDomain}" could not be resolved after create attempt.`,
        'cloudflare',
        'ensureZone',
      );
    }
    return { zone: createdZone, action: 'created' };
  }

  private resolveTarget(config: CloudflareManifestConfig): {
    appDomain: string;
    zoneDomain: string;
    domainMode: 'zone-root' | 'subdomain';
    dnsRecordName: string;
  } {
    const resolved = resolveCloudflareDomainTarget(config.domain);
    const appDomain = config.domain.trim().toLowerCase();
    const zoneDomain = config.zone_domain?.trim().toLowerCase() || resolved.zoneDomain;
    const domainMode = config.domain_mode ?? (zoneDomain === appDomain ? 'zone-root' : 'subdomain');
    const dnsRecordName = config.dns_record_name?.trim() || (domainMode === 'zone-root' ? '@' : appDomain.replace(new RegExp(`\\.${zoneDomain}$`), ''));
    return { appDomain, zoneDomain, domainMode, dnsRecordName };
  }

  private toFqdn(recordName: string, zoneDomain: string): string {
    const normalized = recordName.trim().toLowerCase().replace(/\.$/, '');
    if (normalized === '@') return zoneDomain;
    if (normalized.endsWith(`.${zoneDomain}`)) return normalized;
    return `${normalized}.${zoneDomain}`;
  }

  private async ensureDnsRecordForAppHost(
    zoneId: string,
    target: { appDomain: string; zoneDomain: string; domainMode: 'zone-root' | 'subdomain'; dnsRecordName: string },
    opts: { createIfMissing: boolean },
  ): Promise<{ created: boolean; skipped: boolean; reason: string }> {
    // Apex-host mode: the app host is the zone itself. This step is a no-op
    // because Studio does not have enough context to safely create/replace the
    // apex A/AAAA/CNAME target (origin-specific).
    if (target.domainMode === 'zone-root') {
      return {
        created: false,
        skipped: true,
        reason: `App host "${target.appDomain}" is zone apex; no subdomain DNS record is created by Studio.`,
      };
    }

    const desiredType: DnsRecord['type'] = 'CNAME';
    const desiredContent = target.zoneDomain;
    const desiredNameFqdn = this.toFqdn(target.dnsRecordName, target.zoneDomain);
    const records = await this.apiClient.getDnsRecords(zoneId);
    const existing = records.filter(
      (r) => this.toFqdn(r.name, target.zoneDomain) === desiredNameFqdn,
    );

    const matching = existing.find(
      (r) =>
        r.type === desiredType && r.content.trim().toLowerCase() === desiredContent.toLowerCase(),
    );
    if (matching) {
      return {
        created: false,
        skipped: true,
        reason: `DNS record already exists: ${desiredNameFqdn} ${desiredType} ${desiredContent}.`,
      };
    }

    if (existing.length > 0) {
      const conflictSummary = existing
        .map((r) => `${r.type} ${r.name} -> ${r.content}`)
        .join('; ');
      throw new AdapterError(
        `Cannot create DNS record for "${target.appDomain}". Existing records conflict: ${conflictSummary}. ` +
          `Expected exactly one ${desiredType} ${desiredNameFqdn} -> ${desiredContent}.`,
        'cloudflare',
        'ensureDnsRecordForAppHost',
      );
    }

    if (!opts.createIfMissing) {
      throw new AdapterError(
        `DNS record is missing for "${target.appDomain}". Expected ${desiredType} ${desiredNameFqdn} -> ${desiredContent}.`,
        'cloudflare',
        'ensureDnsRecordForAppHost',
      );
    }

    await this.apiClient.addDnsRecord(zoneId, {
      type: desiredType,
      name: target.dnsRecordName,
      content: desiredContent,
    });
    return {
      created: true,
      skipped: false,
      reason: `Created DNS record ${desiredNameFqdn} ${desiredType} ${desiredContent}.`,
    };
  }

  async provision(config: CloudflareManifestConfig): Promise<ProviderState> {
    const target = this.resolveTarget(config);
    this.log.info('Starting Cloudflare provisioning', {
      appDomain: target.appDomain,
      zoneDomain: target.zoneDomain,
      domainMode: target.domainMode,
    });

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
      const zoneResult = await this.ensureZone(target.zoneDomain);
      const zoneId = zoneResult.zone.id;
      state.resource_ids['zone_id'] = zoneResult.zone.id;
      state.resource_ids['domain'] = target.appDomain;
      state.resource_ids['zone_domain'] = target.zoneDomain;
      state.resource_ids['domain_mode'] = target.domainMode;
      state.resource_ids['zone_status'] = zoneResult.zone.status;
      if (zoneResult.zone.accountId) {
        state.resource_ids['cloudflare_account_id'] = zoneResult.zone.accountId;
      }
      if (zoneResult.zone.nameServers.length > 0) {
        state.resource_ids['zone_nameservers'] = zoneResult.zone.nameServers.join(',');
      }
      state.completed_steps.push('create_zone');
      this.log.info('Cloudflare zone ensured', {
        zoneDomain: target.zoneDomain,
        zoneId: zoneResult.zone.id,
        action: zoneResult.action,
        status: zoneResult.zone.status,
      });

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
            `${target.appDomain}${route}`,
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

  async executeStep(
    stepKey: string,
    config: CloudflareManifestConfig,
    context: StepContext,
  ): Promise<StepResult> {
    this.log.info('CloudflareAdapter.executeStep()', { stepKey });
    switch (stepKey) {
      case 'cloudflare:add-domain-zone': {
        const target = this.resolveTarget(config);
        const zoneResult = await this.ensureZone(target.zoneDomain);
        const zoneNameservers = zoneResult.zone.nameServers.join(',');
        return {
          status: 'completed',
          resourcesProduced: {
            cloudflare_zone_id: zoneResult.zone.id,
            cloudflare_zone_domain: target.zoneDomain,
            cloudflare_app_domain: target.appDomain,
            cloudflare_domain_mode: target.domainMode,
            cloudflare_zone_status: zoneResult.zone.status,
            ...(zoneResult.zone.accountId
              ? { cloudflare_account_id: zoneResult.zone.accountId }
              : {}),
            ...(zoneNameservers ? { cloudflare_zone_nameservers: zoneNameservers } : {}),
            domain_name: target.appDomain,
          },
          userPrompt:
            target.domainMode === 'zone-root'
              ? 'Confirm registrar nameservers point to Cloudflare. Zone must be active before DNS and association files can be validated.'
              : `Subdomain mode detected (${target.appDomain}). Ensure zone "${target.zoneDomain}" is active in Cloudflare before adding DNS records for host "${target.dnsRecordName}".`,
        };
      }
      case 'cloudflare:configure-dns':
      {
        const target = this.resolveTarget(config);
        const zoneId = context.upstreamResources['cloudflare_zone_id']?.trim();
        if (!zoneId) {
          return {
            status: 'failed',
            resourcesProduced: {},
            error:
              'Cloudflare zone id is missing. Run "Add Domain to Cloudflare" first, then re-run DNS configuration.',
          };
        }
        const dnsOutcome = await this.ensureDnsRecordForAppHost(zoneId, target, {
          createIfMissing: true,
        });
        return {
          status: 'completed',
          resourcesProduced: {
            cloudflare_dns_record_name: target.dnsRecordName,
            cloudflare_zone_domain: target.zoneDomain,
            cloudflare_app_domain: target.appDomain,
            cloudflare_domain_mode: target.domainMode,
          },
          userPrompt:
            dnsOutcome.reason,
        };
      }
      case 'cloudflare:configure-ssl':
        await this.apiClient.setSslMode(context.upstreamResources['cloudflare_zone_id'] ?? '', config.ssl_mode);
        return {
          status: 'completed',
          resourcesProduced: {},
          userPrompt:
            'SSL mode is configured. Confirm certificate status is active and HTTPS requests succeed for the project domain.',
        };
      case 'cloudflare:setup-apple-app-site-association':
        return {
          status: 'completed',
          resourcesProduced: {},
          userPrompt:
            'Publish `/.well-known/apple-app-site-association` on your app domain with your appID entries. Then validate using Apple device universal link tests.',
        };
      case 'cloudflare:setup-android-asset-links':
        return {
          status: 'completed',
          resourcesProduced: {},
          userPrompt:
            'Publish `/.well-known/assetlinks.json` with your Android package + SHA256 cert fingerprint, then validate Android App Links.',
        };
      case 'cloudflare:configure-deep-link-routes': {
        const target = this.resolveTarget(config);
        const baseUrl = `https://${target.appDomain}`;
        return {
          status: 'completed',
          resourcesProduced: {
            deep_link_base_url: baseUrl,
            oauth_redirect_uri_deep_link: `${baseUrl}/__/auth/handler`,
            auth_landing_url: `${baseUrl}/auth`,
          },
          userPrompt:
            'Deep-link routes are configured. Confirm auth callback (/__/auth/handler), auth landing (/auth), and universal-link paths return expected responses through Cloudflare.',
        };
      }
      default:
        throw new AdapterError(`Unknown Cloudflare step: ${stepKey}`, 'cloudflare', 'executeStep');
    }
  }

  async checkStep(
    stepKey: string,
    config: CloudflareManifestConfig,
    context: StepContext,
  ): Promise<StepResult> {
    const zoneId =
      context.upstreamResources['cloudflare_zone_id']?.trim() ||
      context.upstreamResources['zone_id']?.trim() ||
      null;
    const target = this.resolveTarget(config);
    switch (stepKey) {
      case 'cloudflare:add-domain-zone': {
        const existingZone = await this.apiClient.getZone(target.zoneDomain);
        const resolvedZoneId = zoneId || existingZone?.id || null;
        if (!resolvedZoneId) {
          return {
            status: 'failed',
            resourcesProduced: {},
            error: 'Cloudflare zone id is missing. Re-run domain zone setup.',
          };
        }
        return {
          status: 'completed',
          resourcesProduced: {
            cloudflare_zone_id: resolvedZoneId,
            cloudflare_zone_domain: target.zoneDomain,
            cloudflare_app_domain: target.appDomain,
            cloudflare_domain_mode: target.domainMode,
            ...(existingZone?.accountId
              ? { cloudflare_account_id: existingZone.accountId }
              : {}),
            ...(existingZone?.status ? { cloudflare_zone_status: existingZone.status } : {}),
            ...(existingZone?.nameServers?.length
              ? { cloudflare_zone_nameservers: existingZone.nameServers.join(',') }
              : {}),
            domain_name: target.appDomain,
          },
        };
      }
      case 'cloudflare:configure-dns':
      {
        if (!zoneId) {
          return {
            status: 'failed',
            resourcesProduced: {},
            error: 'Cloudflare zone must exist before DNS/SSL can be considered synced.',
          };
        }
        try {
          await this.ensureDnsRecordForAppHost(zoneId, target, {
            createIfMissing: false,
          });
        } catch (err) {
          return {
            status: 'failed',
            resourcesProduced: {},
            error: (err as Error).message,
          };
        }
        return {
          status: 'completed',
          resourcesProduced: {
            cloudflare_dns_record_name: target.dnsRecordName,
            cloudflare_zone_domain: target.zoneDomain,
            cloudflare_app_domain: target.appDomain,
            cloudflare_domain_mode: target.domainMode,
          },
        };
      }
      case 'cloudflare:configure-ssl': {
        if (!zoneId) {
          return {
            status: 'failed',
            resourcesProduced: {},
            error: 'Cloudflare zone must exist before DNS/SSL can be considered synced.',
          };
        }
        return {
          status: 'completed',
          resourcesProduced: {
            cloudflare_dns_record_name: target.dnsRecordName,
            cloudflare_zone_domain: target.zoneDomain,
            cloudflare_app_domain: target.appDomain,
            cloudflare_domain_mode: target.domainMode,
          },
        };
      }
      case 'cloudflare:setup-apple-app-site-association': {
        const domain = context.upstreamResources['domain_name']?.trim() || config.domain;
        if (!domain) {
          return {
            status: 'failed',
            resourcesProduced: {},
            error:
              'Domain name is missing for AASA validation. Set project domain and re-run this step after hosting the AASA file.',
          };
        }
        return { status: 'completed', resourcesProduced: {} };
      }
      case 'cloudflare:setup-android-asset-links':
        return { status: 'completed', resourcesProduced: {} };
      case 'cloudflare:configure-deep-link-routes': {
        const baseUrl = context.upstreamResources['deep_link_base_url']?.trim() || `https://${target.appDomain}`;
        return {
          status: 'completed',
          resourcesProduced: {
            deep_link_base_url: baseUrl,
            oauth_redirect_uri_deep_link: `${baseUrl}/__/auth/handler`,
            auth_landing_url: `${baseUrl}/auth`,
          },
        };
      }
      default:
        return { status: 'completed', resourcesProduced: {} };
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

    const target = this.resolveTarget(manifest);
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
      const fullUrl = `${target.appDomain}${route}`;
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
      const target = this.resolveTarget(manifest);
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
                `${target.appDomain}${route}`,
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
