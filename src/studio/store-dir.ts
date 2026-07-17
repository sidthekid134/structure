import envPaths from 'env-paths';

/**
 * Resolve the Studio persistent data directory.
 *
 * Priority:
 * 1) STRUCTURE_STORE_DIR explicit override
 * 2) STRUCTURE_PROFILE namespaced app-data directory
 * 3) default app-data directory
 */
export function resolveStudioStoreDir(env: NodeJS.ProcessEnv): string {
  const explicit = env['STRUCTURE_STORE_DIR']?.trim();
  if (explicit) return explicit;

  const profile = env['STRUCTURE_PROFILE']?.trim();
  const appName = profile ? `structure-${profile}` : 'structure';
  return envPaths(appName, { suffix: '' }).data;
}
