import { AdapterDefinition } from '../services/provisioning-orchestrator';
import { ProvisioningOperation, ProvisioningQueue } from '../types/provisioning';

/**
 * Creates a mock ProvisioningOperation with sensible defaults.
 */
export function createMockOperation(overrides?: Partial<ProvisioningOperation>): ProvisioningOperation {
  return {
    id: 'op-test-001',
    app_id: 'test-app',
    status: 'pending',
    environment: 'dev',
    created_at: new Date('2024-01-01T00:00:00Z'),
    updated_at: new Date('2024-01-01T00:00:00Z'),
    error_message: null,
    lock_acquired_at: null,
    ...overrides,
  };
}

/**
 * Creates a mock AdapterDefinition.
 */
export function createMockAdapter(
  name: string,
  providerName: string,
  dependencies: string[] = []
): AdapterDefinition {
  return { name, providerName, dependencies };
}

/**
 * Creates mock credentials for adapter execution.
 */
export function createMockCredentials(overrides?: Record<string, string>): Record<string, string> {
  return {
    api_key: 'test-api-key-abc123',
    secret: 'test-secret-xyz789',
    ...overrides,
  };
}

/**
 * Creates a mock ProvisioningQueue entry.
 */
export function createMockQueueEntry(overrides?: Partial<ProvisioningQueue>): ProvisioningQueue {
  return {
    id: 'queue-entry-001',
    operation_id: 'op-test-001',
    adapter_name: 'test-adapter',
    position: 0,
    status: 'queued',
    created_at: new Date('2024-01-01T00:00:00Z'),
    updated_at: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

/**
 * Builds a linear adapter chain: A -> B -> C
 */
export function createLinearAdapterChain(
  adapters: Array<{ name: string; providerName: string }>
): AdapterDefinition[] {
  return adapters.map((a, i) => ({
    name: a.name,
    providerName: a.providerName,
    dependencies: i === 0 ? [] : [adapters[i - 1].name],
  }));
}

/**
 * Builds a diamond adapter chain: A -> [B, C] -> D
 */
export function createDiamondAdapterChain(): AdapterDefinition[] {
  return [
    { name: 'diamond-a', providerName: 'p1', dependencies: [] },
    { name: 'diamond-b', providerName: 'p2', dependencies: ['diamond-a'] },
    { name: 'diamond-c', providerName: 'p3', dependencies: ['diamond-a'] },
    { name: 'diamond-d', providerName: 'p4', dependencies: ['diamond-b', 'diamond-c'] },
  ];
}

/**
 * Creates a mock pg client that responds to queries in sequence.
 */
export function createMockClient(
  queryResponses: Array<{ rows: unknown[] } | Error> = []
): { query: jest.Mock; release: jest.Mock } {
  let callIndex = 0;
  const query = jest.fn().mockImplementation(() => {
    const response = queryResponses[callIndex] ?? { rows: [] };
    callIndex++;
    if (response instanceof Error) return Promise.reject(response);
    return Promise.resolve(response);
  });
  const release = jest.fn();
  return { query, release };
}
