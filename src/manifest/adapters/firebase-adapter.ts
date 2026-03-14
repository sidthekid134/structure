import * as https from 'https';
import { LiveResource } from '../../types/manifest';
import { computeHash } from '../hash-calculator';
import { RateLimitError } from '../retry-handler';
import { BaseAdapter, HttpResponse } from './base-adapter';

interface FirebaseApp {
  name: string;
  appId: string;
  displayName?: string;
  projectId?: string;
  bundleId?: string;
  packageName?: string;
  platform?: string;
}

interface FirebaseAppsResponse {
  apps?: FirebaseApp[];
}

export class FirebaseAdapter extends BaseAdapter {
  private accessToken = '';
  private projectId = '';

  async authenticate(credentials: Record<string, string>): Promise<void> {
    const serviceAccountKey = credentials['service_account_key'];
    const projectId = credentials['project_id'];

    if (!serviceAccountKey || !projectId) {
      throw new Error('Firebase credentials must include project_id and service_account_key');
    }

    this.projectId = projectId;

    // Decode service account key
    let serviceAccount: Record<string, string>;
    try {
      const decoded = Buffer.from(serviceAccountKey, 'base64').toString('utf8');
      serviceAccount = JSON.parse(decoded);
    } catch {
      throw new Error('service_account_key must be a base64-encoded JSON service account key');
    }

    this.accessToken = await this.getAccessToken(serviceAccount);
    this.authenticated = true;
  }

  private async getAccessToken(serviceAccount: Record<string, string>): Promise<string> {
    // Build JWT assertion for service account auth
    const { createSign } = await import('crypto');
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iss: serviceAccount['client_email'],
        scope: 'https://www.googleapis.com/auth/firebase',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
      }),
    ).toString('base64url');

    const signingInput = `${header}.${payload}`;
    const sign = createSign('RSA-SHA256');
    sign.update(signingInput);
    const signature = sign.sign(serviceAccount['private_key'], 'base64url');
    const jwt = `${signingInput}.${signature}`;

    const tokenResponse = await this.httpPost(
      'https://oauth2.googleapis.com/token',
      `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
      { 'Content-Type': 'application/x-www-form-urlencoded' },
    );

    if (tokenResponse.statusCode !== 200) {
      throw new Error(`Failed to get Firebase access token: HTTP ${tokenResponse.statusCode}`);
    }

    const tokenData = this.parseJson<{ access_token: string }>(tokenResponse.body);
    return tokenData.access_token;
  }

  async listResources(): Promise<LiveResource[]> {
    this.requireAuth();

    const response = await this.fetchWithRetry(() =>
      this.httpGet(
        `https://firebase.googleapis.com/v1beta1/projects/${this.projectId}/apps`,
        { Authorization: `Bearer ${this.accessToken}` },
      ),
    );

    if (response.statusCode !== 200) {
      throw new Error(`Firebase list apps failed: HTTP ${response.statusCode} - ${response.body}`);
    }

    const data = this.parseJson<FirebaseAppsResponse>(response.body);
    const apps = data.apps ?? [];

    const resources: LiveResource[] = [];
    for (const app of apps) {
      const config = await this.getResourceConfig(app.appId);
      resources.push({
        provider: 'firebase',
        resourceType: 'app',
        resourceId: app.appId,
        configuration: config,
      });
    }

    return resources;
  }

  async getResourceConfig(resourceId: string): Promise<Record<string, unknown>> {
    this.requireAuth();

    const response = await this.fetchWithRetry(() =>
      this.httpGet(
        `https://firebase.googleapis.com/v1beta1/${resourceId}`,
        { Authorization: `Bearer ${this.accessToken}` },
      ),
    );

    if (response.statusCode === 429 || response.statusCode === 503) {
      throw new RateLimitError(response.statusCode, `HTTP ${response.statusCode}`);
    }

    if (response.statusCode !== 200) {
      throw new Error(`Firebase get app config failed: HTTP ${response.statusCode}`);
    }

    const app = this.parseJson<FirebaseApp>(response.body);
    return {
      appId: app.appId,
      displayName: app.displayName ?? '',
      bundleId: app.bundleId ?? '',
      packageName: app.packageName ?? '',
      platform: app.platform ?? '',
      projectId: app.projectId ?? this.projectId,
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

  private httpPost(
    url: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const options = {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      };
      const req = https.request(options, (res) => {
        let responseBody = '';
        res.on('data', (chunk) => (responseBody += chunk));
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: responseBody }));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}
