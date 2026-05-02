/**
 * Wipes local Studio install files under `storeDir` (vault, passkey registry, projects, etc.).
 * Used by `POST /api/vault/destroy` and `POST /api/auth/reset-local-data`.
 */

import * as fs from 'fs';
import * as path from 'path';

const WIPE_FILES = [
  'credentials.enc',
  'vault-meta.json',
  'key-wrappers.json',
  'users.json',
  'api-token',
  '.studio-pro.lock',
  'organization.json',
] as const;

const WIPE_DIRS = ['projects'] as const;

export function destroyLocalStudioInstall(storeDir: string): void {
  for (const name of WIPE_FILES) {
    const p = path.join(storeDir, name);
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (e) {
      throw new Error(`Failed to remove ${p}: ${(e as Error).message}`);
    }
  }
  for (const name of WIPE_DIRS) {
    const p = path.join(storeDir, name);
    try {
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    } catch (e) {
      throw new Error(`Failed to remove ${p}: ${(e as Error).message}`);
    }
  }
}
