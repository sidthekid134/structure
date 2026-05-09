import {
  CloudflareAdapter,
  type CloudflareApiClient,
  type CloudflareZoneSummary,
  type DnsRecord,
} from '../providers/cloudflare.js';
import type { CloudflareManifestConfig, StepContext } from '../providers/types.js';

class FakeCloudflareClient implements CloudflareApiClient {
  public addedRecords: DnsRecord[] = [];

  constructor(private readonly records: DnsRecord[]) {}

  async verifyToken(): Promise<{ status: string }> {
    return { status: 'active' };
  }

  async getZoneId(): Promise<string | null> {
    return 'zone-1';
  }

  async getZone(): Promise<CloudflareZoneSummary | null> {
    return {
      id: 'zone-1',
      name: 'example.com',
      status: 'active',
      nameServers: [],
      accountId: 'account-1',
    };
  }

  async createZone(): Promise<string> {
    return 'zone-1';
  }

  async addDnsRecord(_zoneId: string, record: DnsRecord): Promise<string> {
    this.addedRecords.push(record);
    return 'record-1';
  }

  async getDnsRecords(): Promise<DnsRecord[]> {
    return this.records;
  }

  async deleteDnsRecord(): Promise<void> {}

  async setPageRule(): Promise<string> {
    return 'page-rule-1';
  }

  async getPageRules(): Promise<Array<{ url: string; action: string }>> {
    return [];
  }

  async setSslMode(): Promise<void> {}

  async upsertOriginHostHeaderRule(): Promise<void> {}
}

const config: CloudflareManifestConfig = {
  provider: 'cloudflare',
  domain: 'app.example.com',
  zone_domain: 'example.com',
  domain_mode: 'subdomain',
  dns_record_name: 'app',
  deep_link_routes: [],
  ssl_mode: 'strict',
};

const context: StepContext = {
  projectId: 'project-1',
  environment: 'production',
  upstreamResources: { cloudflare_zone_id: 'zone-1' },
  vaultRead: async () => null,
  vaultWrite: async () => {},
};

describe('Cloudflare DNS UI link resources', () => {
  it('produces a project UI URL when it creates a CNAME record', async () => {
    const client = new FakeCloudflareClient([]);
    const adapter = new CloudflareAdapter(client);

    const result = await adapter.executeStep?.('cloudflare:configure-dns', config, context);

    expect(result?.status).toBe('completed');
    expect(result?.resourcesProduced).toMatchObject({
      cloudflare_dns_record_type: 'CNAME',
      cloudflare_dns_record_host: 'app.example.com',
      cloudflare_dns_record_content: 'example.com',
      cloudflare_app_url: 'https://app.example.com',
    });
    expect(client.addedRecords).toEqual([
      { type: 'CNAME', name: 'app', content: 'example.com' },
    ]);
  });

  it('does not produce a project UI URL for the A-record skip path', async () => {
    const client = new FakeCloudflareClient([
      { type: 'A', name: 'app.example.com', content: '203.0.113.10' },
    ]);
    const adapter = new CloudflareAdapter(client);

    const result = await adapter.executeStep?.('cloudflare:configure-dns', config, context);

    expect(result?.status).toBe('completed');
    expect(result?.resourcesProduced.cloudflare_app_url).toBeUndefined();
    expect(result?.resourcesProduced.cloudflare_dns_record_type).toBeUndefined();
    expect(client.addedRecords).toEqual([]);
  });
});
