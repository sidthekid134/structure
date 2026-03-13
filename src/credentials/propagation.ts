import { Vault } from './vault';

export type LlmDestination = 'vertex_ai' | 'openai' | 'anthropic';

export interface PropagationResult {
  destination: LlmDestination;
  success: boolean;
  error?: string;
}

export interface PropagateResults {
  results: PropagationResult[];
  allSucceeded: boolean;
}

export class CredentialPropagator {
  private readonly vault: Vault;

  constructor(masterPassword: string) {
    this.vault = new Vault(masterPassword);
  }

  /**
   * Distributes a single LLM API key to one or more provider destinations.
   * Each destination is handled independently — a failure for one does not
   * prevent propagation to others.
   */
  propagate(llmApiKey: string, destinations: LlmDestination[]): PropagateResults {
    const results: PropagationResult[] = [];

    for (const destination of destinations) {
      try {
        this.vault.store(destination, 'api_key', llmApiKey);
        results.push({ destination, success: true });
      } catch (err: any) {
        results.push({
          destination,
          success: false,
          // Never include the key value in error messages
          error: err.message ?? String(err),
        });
      }
    }

    return {
      results,
      allSucceeded: results.every((r) => r.success),
    };
  }
}
