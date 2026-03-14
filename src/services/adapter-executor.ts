export type AdapterFn = (
  inputs: Record<string, unknown>,
  credentials: Record<string, string>
) => Promise<Record<string, unknown>>;

export interface AdapterResult {
  adapterName: string;
  success: boolean;
  output: Record<string, unknown>;
  error?: string;
}

export class AdapterExecutor {
  private adapters: Map<string, AdapterFn>;

  constructor(adapters: Map<string, AdapterFn> = new Map()) {
    this.adapters = adapters;
  }

  registerAdapter(name: string, fn: AdapterFn): void {
    this.adapters.set(name, fn);
  }

  hasAdapter(name: string): boolean {
    return this.adapters.has(name);
  }

  async executeAdapter(
    adapterName: string,
    inputs: Record<string, unknown>,
    credentials: Record<string, string>
  ): Promise<AdapterResult> {
    const adapter = this.adapters.get(adapterName);
    if (!adapter) {
      return {
        adapterName,
        success: false,
        output: {},
        error: `Adapter not found: ${adapterName}`,
      };
    }

    try {
      const output = await adapter(inputs, credentials);
      return { adapterName, success: true, output };
    } catch (err: unknown) {
      return {
        adapterName,
        success: false,
        output: {},
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
