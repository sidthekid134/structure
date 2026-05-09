import * as fs from 'fs';
import * as path from 'path';
import { GCP_SERVERLESS_STEP_HANDLERS } from '../core/gcp/gcp-serverless-step-handlers.js';

describe('gcp serverless web CI handlers', () => {
  it('registers CI-first web step handlers and removes local deploy handlers', () => {
    const stepKeys = new Set(GCP_SERVERLESS_STEP_HANDLERS.map((handler) => handler.stepKey));

    expect(stepKeys.has('web:cicd-prepare-contract')).toBe(true);
    expect(stepKeys.has('web:cicd-verify-deploy')).toBe(true);
    expect(stepKeys.has('web:cicd-verify-smoke')).toBe(true);

    expect(stepKeys.has('web:build-bundle')).toBe(false);
    expect(stepKeys.has('web:publish-serverless')).toBe(false);
    expect(stepKeys.has('web:run-smoke-check')).toBe(false);
  });

  it('does not contain local studio-ui build/deploy command paths', () => {
    const handlerSourcePath = path.resolve(
      process.cwd(),
      'src/core/gcp/gcp-serverless-step-handlers.ts',
    );
    const handlerSource = fs.readFileSync(handlerSourcePath, 'utf8');

    expect(handlerSource.includes('npm --prefix studio-ui run build')).toBe(false);
    expect(handlerSource.includes('studio-ui/dist')).toBe(false);
    expect(handlerSource.includes('Dockerfile.web')).toBe(false);
    expect(handlerSource.includes('cloud-run-delivery.yml')).toBe(false);
  });
});
