import envPaths from 'env-paths';

/**
 * Resolve the Studio persistent data directory.
 *
 * Priority:
 * 1) STUDIO_STORE_DIR explicit override
 * 2) STUDIO_PROFILE namespaced app-data directory
 * 3) default app-data directory
 */
export function resolveStudioStoreDir(env: NodeJS.ProcessEnv): string {
  const explicit = env['STUDIO_STORE_DIR']?.trim();
  if (explicit) return explicit;

  const profile = env['STUDIO_PROFILE']?.trim();
  const appName = profile ? `studio-pro-${profile}` : 'studio-pro';
  return envPaths(appName, { suffix: '' }).data;
}
