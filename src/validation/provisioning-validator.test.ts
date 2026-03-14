import { ProvisioningValidator, ValidationError } from './provisioning-validator';
import { AdapterExecutor } from '../services/adapter-executor';
import { NotFoundError } from '../credentials/vault';
import { Pool } from 'pg';

jest.mock('pg', () => ({
  Pool: jest.fn(),
}));

function makePool(rows: unknown[] = []): Pool {
  const client = {
    query: jest.fn().mockResolvedValue({ rows }),
    release: jest.fn(),
  };
  return { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
}

describe('ProvisioningValidator', () => {
  let adapterExecutor: AdapterExecutor;
  let validator: ProvisioningValidator;

  beforeEach(() => {
    adapterExecutor = new AdapterExecutor();
    adapterExecutor.registerAdapter('adapterA', async () => ({}));
    adapterExecutor.registerAdapter('adapterB', async () => ({}));
    validator = new ProvisioningValidator(makePool(), adapterExecutor);
  });

  describe('validateProvisioningRequest', () => {
    const validSequence = [{ name: 'adapterA', providerName: 'p', dependencies: [] }];

    it('passes for valid request', () => {
      expect(() =>
        validator.validateProvisioningRequest('app1', 'dev', validSequence, 5000)
      ).not.toThrow();
    });

    it('throws ValidationError for empty appId', () => {
      expect(() =>
        validator.validateProvisioningRequest('', 'dev', validSequence, 5000)
      ).toThrow(ValidationError);
      expect(() =>
        validator.validateProvisioningRequest('', 'dev', validSequence, 5000)
      ).toThrow('appId must be a non-empty string');
    });

    it('throws ValidationError for whitespace-only appId', () => {
      expect(() =>
        validator.validateProvisioningRequest('   ', 'dev', validSequence, 5000)
      ).toThrow('appId must be a non-empty string');
    });

    it('throws ValidationError for invalid environment', () => {
      expect(() =>
        validator.validateProvisioningRequest('app1', 'staging', validSequence, 5000)
      ).toThrow(ValidationError);
      expect(() =>
        validator.validateProvisioningRequest('app1', 'staging', validSequence, 5000)
      ).toThrow('environment must be one of');
    });

    it('accepts all valid environments', () => {
      for (const env of ['dev', 'preview', 'production']) {
        expect(() =>
          validator.validateProvisioningRequest('app1', env, validSequence, 5000)
        ).not.toThrow();
      }
    });

    it('throws ValidationError for empty adapterSequence', () => {
      expect(() =>
        validator.validateProvisioningRequest('app1', 'dev', [], 5000)
      ).toThrow('adapterSequence must be a non-empty array');
    });

    it('throws ValidationError for non-array adapterSequence', () => {
      expect(() =>
        validator.validateProvisioningRequest('app1', 'dev', 'not-an-array', 5000)
      ).toThrow('adapterSequence must be a non-empty array');
    });

    it('throws ValidationError for non-positive timeout', () => {
      expect(() =>
        validator.validateProvisioningRequest('app1', 'dev', validSequence, 0)
      ).toThrow('timeout must be a positive integer');
      expect(() =>
        validator.validateProvisioningRequest('app1', 'dev', validSequence, -5)
      ).toThrow('timeout must be a positive integer');
    });

    it('throws ValidationError for non-integer timeout', () => {
      expect(() =>
        validator.validateProvisioningRequest('app1', 'dev', validSequence, 1.5)
      ).toThrow('timeout must be a positive integer');
    });

    it('throws ValidationError for unknown adapter', () => {
      const sequence = [{ name: 'unknownAdapter', providerName: 'p', dependencies: [] }];
      expect(() =>
        validator.validateProvisioningRequest('app1', 'dev', sequence, 5000)
      ).toThrow('Unknown adapter: unknownAdapter');
    });

    it('throws ValidationError for circular dependency', () => {
      const sequence = [
        { name: 'adapterA', providerName: 'p', dependencies: ['adapterB'] },
        { name: 'adapterB', providerName: 'p', dependencies: ['adapterA'] },
      ];
      expect(() =>
        validator.validateProvisioningRequest('app1', 'dev', sequence, 5000)
      ).toThrow('Circular dependency detected');
    });
  });

  describe('validateCredentialsExist', () => {
    it('does not throw when operation exists', async () => {
      const pool = makePool([{ id: 'op-1' }]);
      const v = new ProvisioningValidator(pool, adapterExecutor);
      await expect(v.validateCredentialsExist('op-1', 'openai')).resolves.toBeUndefined();
    });

    it('throws NotFoundError when operation does not exist', async () => {
      const pool = makePool([]);
      const v = new ProvisioningValidator(pool, adapterExecutor);
      await expect(v.validateCredentialsExist('missing-op', 'openai')).rejects.toThrow(
        NotFoundError
      );
    });
  });

  describe('validateDependencyDAG', () => {
    it('passes for adapters with no dependencies', () => {
      const sequence = [
        { name: 'adapterA', providerName: 'p', dependencies: [] },
        { name: 'adapterB', providerName: 'p', dependencies: [] },
      ];
      expect(() => validator.validateDependencyDAG(sequence)).not.toThrow();
    });

    it('passes for valid dependency chain', () => {
      const sequence = [
        { name: 'adapterA', providerName: 'p', dependencies: [] },
        { name: 'adapterB', providerName: 'p', dependencies: ['adapterA'] },
      ];
      expect(() => validator.validateDependencyDAG(sequence)).not.toThrow();
    });

    it('throws ValidationError for circular dependency', () => {
      const sequence = [
        { name: 'adapterA', providerName: 'p', dependencies: ['adapterB'] },
        { name: 'adapterB', providerName: 'p', dependencies: ['adapterA'] },
      ];
      expect(() => validator.validateDependencyDAG(sequence)).toThrow(
        'Circular dependency detected in adapter sequence'
      );
    });

    it('throws ValidationError for unknown dependency reference', () => {
      const sequence = [
        { name: 'adapterA', providerName: 'p', dependencies: ['nonExistent'] },
      ];
      expect(() => validator.validateDependencyDAG(sequence)).toThrow(
        'Unknown dependency "nonExistent" for adapter "adapterA"'
      );
    });
  });
});
