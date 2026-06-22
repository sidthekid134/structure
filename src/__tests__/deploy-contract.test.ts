import { resolveDeployContractFromInputs } from '../studio/deploy-contract.js';

describe('resolveDeployContractFromInputs', () => {
  it('uses legacy root defaults when no new deploy contract fields are present', () => {
    expect(resolveDeployContractFromInputs(undefined)).toEqual({
      web: { root: '.', dockerfile: 'Dockerfile', buildContext: '.' },
      api: { root: '.', dockerfile: 'Dockerfile', buildContext: '.', healthPath: '/api/health' },
    });
  });

  it('uses modern monorepo defaults when any new deploy contract field is present', () => {
    expect(resolveDeployContractFromInputs({ deploy_web_root: 'apps/web' })).toEqual({
      web: { root: 'apps/web', dockerfile: 'apps/web/Dockerfile', buildContext: '.' },
      api: { root: 'apps/api', dockerfile: 'apps/api/Dockerfile', buildContext: '.', healthPath: '/api/health' },
    });
  });

  it('resolves partial modern API inputs', () => {
    expect(resolveDeployContractFromInputs({
      deploy_api_dockerfile: 'services/api/Dockerfile',
      deploy_api_health_path: '/healthz',
    }).api).toEqual({
      root: 'apps/api',
      dockerfile: 'services/api/Dockerfile',
      buildContext: '.',
      healthPath: '/healthz',
    });
  });

  it('supports the deprecated health_path alias', () => {
    expect(resolveDeployContractFromInputs({ health_path: '/ready' }).api.healthPath).toBe('/ready');
  });

  it('rejects absolute paths and traversal', () => {
    expect(() => resolveDeployContractFromInputs({ deploy_web_root: '/tmp/app' })).toThrow('absolute');
    expect(() => resolveDeployContractFromInputs({ deploy_api_root: '../api' })).toThrow('path traversal');
  });

  it('rejects shell metacharacters in path fields', () => {
    expect(() => resolveDeployContractFromInputs({ deploy_web_dockerfile: 'apps/web/Dockerfile; rm -rf .' })).toThrow(
      'metacharacters',
    );
    expect(() => resolveDeployContractFromInputs({ deploy_api_build_context: '$(pwd)' })).toThrow(
      'metacharacters',
    );
  });

  it('validates API health path', () => {
    expect(() => resolveDeployContractFromInputs({ deploy_api_health_path: 'health' })).toThrow('start with "/"');
    expect(() => resolveDeployContractFromInputs({ deploy_api_health_path: '/bad path' })).toThrow('whitespace');
  });
});
