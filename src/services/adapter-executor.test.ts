import { AdapterExecutor, AdapterFn } from './adapter-executor';

describe('AdapterExecutor', () => {
  let executor: AdapterExecutor;

  beforeEach(() => {
    executor = new AdapterExecutor();
  });

  describe('hasAdapter', () => {
    it('returns false for unregistered adapter', () => {
      expect(executor.hasAdapter('unknown')).toBe(false);
    });

    it('returns true for registered adapter', () => {
      executor.registerAdapter('github', async () => ({}));
      expect(executor.hasAdapter('github')).toBe(true);
    });
  });

  describe('executeAdapter', () => {
    it('calls the adapter with inputs and credentials', async () => {
      const mockFn: AdapterFn = jest.fn().mockResolvedValue({ repoId: '123' });
      executor.registerAdapter('github', mockFn);

      const inputs = { appName: 'my-app' };
      const credentials = { token: 'ghp_abc' };
      const result = await executor.executeAdapter('github', inputs, credentials);

      expect(mockFn).toHaveBeenCalledWith(inputs, credentials);
      expect(result).toEqual({ adapterName: 'github', success: true, output: { repoId: '123' } });
    });

    it('returns success: false when adapter is not registered', async () => {
      const result = await executor.executeAdapter('missing', {}, {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('Adapter not found: missing');
      expect(result.output).toEqual({});
    });

    it('catches adapter errors and returns success: false', async () => {
      executor.registerAdapter('failing', async () => {
        throw new Error('Deployment failed');
      });

      const result = await executor.executeAdapter('failing', {}, {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Deployment failed');
      expect(result.output).toEqual({});
    });

    it('handles non-Error throws', async () => {
      executor.registerAdapter('weird', async () => {
        throw 'string error';
      });

      const result = await executor.executeAdapter('weird', {}, {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('string error');
    });

    it('passes adapter output correctly', async () => {
      executor.registerAdapter('openai', async () => ({ model: 'gpt-4', status: 'ready' }));

      const result = await executor.executeAdapter('openai', {}, {});

      expect(result.success).toBe(true);
      expect(result.output).toEqual({ model: 'gpt-4', status: 'ready' });
    });
  });
});
