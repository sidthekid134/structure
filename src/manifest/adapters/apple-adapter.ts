import * as https from 'https';
import { LiveResource } from '../../types/manifest';
import { RateLimitError } from '../retry-handler';
import { BaseAdapter, HttpResponse } from './base-adapter';

interface AppStoreApp {
  id: string;
  attributes: {
    name: string;
    bundleId: string;
    sku: string;
    primaryLocale?: string;
  };
}

interface Profile {
  id: string;
  attributes: {
    name: string;
    profileType: string;
    uuid: string;
    profileState?: string;
  };
}

interface Certificate {
  id: string;
  attributes: {
    name: string;
    certificateType: string;
    serialNumber?: string;
    fingerprint?: string;
  };
}

export class AppleAdapter extends BaseAdapter {
  private jwtToken = '';
  private keyId = '';
  private teamId = '';
  private privateKey = '';

  async authenticate(credentials: Record<string, string>): Promise<void> {
    const { keyId, teamId, privateKey } = {
      keyId: credentials['key_id'],
      teamId: credentials['team_id'],
      privateKey: credentials['private_key'],
    };

    if (!keyId || !teamId || !privateKey) {
      throw new Error('Apple credentials must include key_id, team_id, and private_key');
    }

    this.keyId = keyId;
    this.teamId = teamId;
    this.privateKey = privateKey;
    this.jwtToken = this.buildJwt();
    this.authenticated = true;
  }

  private buildJwt(): string {
    const { createSign } = require('crypto');
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: 'ES256', kid: this.keyId, typ: 'JWT' }),
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iss: this.teamId,
        iat: now,
        exp: now + 1200,
        aud: 'appstoreconnect-v1',
      }),
    ).toString('base64url');

    const signingInput = `${header}.${payload}`;
    const sign = createSign('SHA256');
    sign.update(signingInput);
    const signature = sign.sign({ key: this.privateKey, dsaEncoding: 'ieee-p1363' }, 'base64url');
    return `${signingInput}.${signature}`;
  }

  async listResources(): Promise<LiveResource[]> {
    this.requireAuth();
    const resources: LiveResource[] = [];

    // List apps
    const appsResponse = await this.fetchWithRetry(() =>
      this.httpGet('https://api.appstoreconnect.apple.com/v1/apps?limit=200', {
        Authorization: `Bearer ${this.jwtToken}`,
      }),
    );

    if (appsResponse.statusCode !== 200) {
      throw new Error(`Apple list apps failed: HTTP ${appsResponse.statusCode}`);
    }

    const appsData = this.parseJson<{ data: AppStoreApp[] }>(appsResponse.body);
    for (const app of appsData.data ?? []) {
      const config = await this.getResourceConfig(app.id);
      resources.push({
        provider: 'apple',
        resourceType: 'app',
        resourceId: app.id,
        configuration: config,
      });
    }

    // List provisioning profiles
    const profilesResponse = await this.fetchWithRetry(() =>
      this.httpGet('https://api.appstoreconnect.apple.com/v1/profiles?limit=200', {
        Authorization: `Bearer ${this.jwtToken}`,
      }),
    );

    if (profilesResponse.statusCode === 200) {
      const profilesData = this.parseJson<{ data: Profile[] }>(profilesResponse.body);
      for (const profile of profilesData.data ?? []) {
        resources.push({
          provider: 'apple',
          resourceType: 'provisioning_profile',
          resourceId: profile.id,
          configuration: {
            name: profile.attributes.name,
            profileType: profile.attributes.profileType,
            uuid: profile.attributes.uuid,
            profileState: profile.attributes.profileState ?? '',
          },
        });
      }
    }

    // List certificates
    const certsResponse = await this.fetchWithRetry(() =>
      this.httpGet('https://api.appstoreconnect.apple.com/v1/certificates?limit=200', {
        Authorization: `Bearer ${this.jwtToken}`,
      }),
    );

    if (certsResponse.statusCode === 200) {
      const certsData = this.parseJson<{ data: Certificate[] }>(certsResponse.body);
      for (const cert of certsData.data ?? []) {
        resources.push({
          provider: 'apple',
          resourceType: 'certificate',
          resourceId: cert.id,
          configuration: {
            name: cert.attributes.name,
            certificateType: cert.attributes.certificateType,
            serialNumber: cert.attributes.serialNumber ?? '',
            fingerprint: cert.attributes.fingerprint ?? '',
          },
        });
      }
    }

    return resources;
  }

  async getResourceConfig(resourceId: string): Promise<Record<string, unknown>> {
    this.requireAuth();

    const response = await this.fetchWithRetry(() =>
      this.httpGet(`https://api.appstoreconnect.apple.com/v1/apps/${resourceId}`, {
        Authorization: `Bearer ${this.jwtToken}`,
      }),
    );

    if (response.statusCode === 429 || response.statusCode === 503) {
      throw new RateLimitError(response.statusCode, `HTTP ${response.statusCode}`);
    }

    if (response.statusCode !== 200) {
      throw new Error(`Apple get app failed: HTTP ${response.statusCode}`);
    }

    const data = this.parseJson<{ data: AppStoreApp }>(response.body);
    const app = data.data;
    return {
      appId: app.id,
      name: app.attributes.name,
      bundleId: app.attributes.bundleId,
      sku: app.attributes.sku,
      primaryLocale: app.attributes.primaryLocale ?? '',
    };
  }

  private httpGet(url: string, headers: Record<string, string>): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const options = {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers,
      };
      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end();
    });
  }
}
