import { LiveResource } from '../../types/manifest';
import { RateLimitError, withRetry } from '../retry-handler';

export { RateLimitError };

export interface HttpResponse {
  statusCode: number;
  body: string;
}

export abstract class BaseAdapter {
  protected authenticated = false;

  abstract authenticate(credentials: Record<string, string>): Promise<void>;

  abstract listResources(): Promise<LiveResource[]>;

  abstract getResourceConfig(resourceId: string): Promise<Record<string, unknown>>;

  protected async fetchWithRetry(fn: () => Promise<HttpResponse>): Promise<HttpResponse> {
    return withRetry(async (attempt) => {
      const response = await fn();
      if (response.statusCode === 429 || response.statusCode === 503) {
        throw new RateLimitError(response.statusCode, `HTTP ${response.statusCode} from provider`);
      }
      return response;
    });
  }

  protected parseJson<T>(body: string): T {
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new Error(`Failed to parse provider response as JSON: ${body.slice(0, 200)}`);
    }
  }

  protected requireAuth(): void {
    if (!this.authenticated) {
      throw new Error(`${this.constructor.name} must be authenticated before use`);
    }
  }
}
