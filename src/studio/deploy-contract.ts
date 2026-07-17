export interface TargetDeployContract {
  root: string;
  dockerfile: string;
  buildContext: string;
  healthPath?: string;
}

export interface FullstackDeployContract {
  web: TargetDeployContract;
  api: TargetDeployContract;
}

const MODERN_DEFAULTS: FullstackDeployContract = {
  web: {
    root: 'apps/web',
    dockerfile: 'apps/web/Dockerfile',
    buildContext: '.',
  },
  api: {
    root: 'apps/api',
    dockerfile: 'apps/api/Dockerfile',
    buildContext: '.',
    healthPath: '/api/health',
  },
};

const LEGACY_DEFAULTS: FullstackDeployContract = {
  web: {
    root: '.',
    dockerfile: 'Dockerfile',
    buildContext: '.',
  },
  api: {
    root: '.',
    dockerfile: 'Dockerfile',
    buildContext: '.',
    healthPath: '/api/health',
  },
};

const DEPLOY_CONTRACT_KEYS = [
  'deploy_web_root',
  'deploy_web_dockerfile',
  'deploy_web_build_context',
  'deploy_api_root',
  'deploy_api_dockerfile',
  'deploy_api_build_context',
  'deploy_api_health_path',
] as const;

const FORBIDDEN_PATH_PATTERN = /[`;&|\n\r]|\$\(/;
const WINDOWS_ABSOLUTE_PATTERN = /^[A-Za-z]:[\\/]/;

function hasModernContractInput(inputs: Record<string, string> | undefined): boolean {
  if (!inputs) return false;
  return DEPLOY_CONTRACT_KEYS.some((key) => inputs[key]?.trim());
}

function readInput(
  inputs: Record<string, string> | undefined,
  key: string,
  fallback: string,
): string {
  const value = inputs?.[key]?.trim();
  return value || fallback;
}

function validateRelativePath(value: string, label: string): string {
  if (!value.trim()) {
    throw new Error(`${label} is required.`);
  }
  if (value.startsWith('/') || WINDOWS_ABSOLUTE_PATTERN.test(value)) {
    throw new Error(`${label} must be a repository-relative path, not an absolute path.`);
  }
  const segments = value.split(/[\\/]+/).filter(Boolean);
  if (segments.includes('..')) {
    throw new Error(`${label} must not contain ".." path traversal.`);
  }
  if (FORBIDDEN_PATH_PATTERN.test(value)) {
    throw new Error(`${label} contains unsupported shell metacharacters.`);
  }
  return value;
}

function validateHealthPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '/api/health';
  if (!trimmed.startsWith('/')) {
    throw new Error('API health path must start with "/".');
  }
  if (/\s/.test(trimmed)) {
    throw new Error('API health path must not contain whitespace.');
  }
  return trimmed;
}

export function quoteWorkflowShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function resolveDeployContractFromInputs(
  inputs: Record<string, string> | undefined,
): FullstackDeployContract {
  const defaults = hasModernContractInput(inputs) ? MODERN_DEFAULTS : LEGACY_DEFAULTS;
  const healthPath = readInput(
    inputs,
    'deploy_api_health_path',
    inputs?.['health_path']?.trim() || defaults.api.healthPath || '/api/health',
  );

  return {
    web: {
      root: validateRelativePath(readInput(inputs, 'deploy_web_root', defaults.web.root), 'Web app root'),
      dockerfile: validateRelativePath(
        readInput(inputs, 'deploy_web_dockerfile', defaults.web.dockerfile),
        'Web Dockerfile',
      ),
      buildContext: validateRelativePath(
        readInput(inputs, 'deploy_web_build_context', defaults.web.buildContext),
        'Web build context',
      ),
    },
    api: {
      root: validateRelativePath(readInput(inputs, 'deploy_api_root', defaults.api.root), 'API app root'),
      dockerfile: validateRelativePath(
        readInput(inputs, 'deploy_api_dockerfile', defaults.api.dockerfile),
        'API Dockerfile',
      ),
      buildContext: validateRelativePath(
        readInput(inputs, 'deploy_api_build_context', defaults.api.buildContext),
        'API build context',
      ),
      healthPath: validateHealthPath(healthPath),
    },
  };
}
