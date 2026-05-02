/**
 * Persists how the encrypted vault file (`credentials.enc`) is keyed — passkey DEK only (`dek-v1`).
 */

import * as fs from 'fs';
import * as path from 'path';

export type VaultKeyMode = 'dek-v1';

export interface VaultMetaFile {
  vaultKeyMode: VaultKeyMode;
}

export function vaultMetaPath(storeDir: string): string {
  return path.join(storeDir, 'vault-meta.json');
}

export function readVaultMeta(storeDir: string): VaultMetaFile | null {
  const p = vaultMetaPath(storeDir);
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf8');
  const parsed = JSON.parse(raw) as VaultMetaFile;
  if (parsed.vaultKeyMode !== 'dek-v1') {
    throw new Error(
      `Unsupported vault-meta.json vaultKeyMode "${String((parsed as { vaultKeyMode?: string }).vaultKeyMode)}". ` +
        'Only dek-v1 (passkey) vaults are supported. Remove credentials.enc and vault-meta.json or run npm run reset:data.',
    );
  }
  return parsed;
}

export function writeVaultMeta(storeDir: string, meta: VaultMetaFile): void {
  fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(vaultMetaPath(storeDir), JSON.stringify(meta, null, 2) + '\n', { mode: 0o600 });
}

/**
 * When `vault-meta.json` is absent: no vault file → treat as fresh install (`dek-v1`);
 * vault file present without meta → ambiguous legacy layout, refuse to start.
 */
export function inferVaultKeyMode(storeDir: string): VaultKeyMode {
  const vaultPath = path.join(storeDir, 'credentials.enc');
  if (fs.existsSync(vaultPath)) {
    const meta = readVaultMeta(storeDir);
    if (!meta) {
      throw new Error(
        `Found ${vaultPath} without vault-meta.json — cannot determine encryption mode. ` +
          'Back up the file if needed, then run npm run reset:data or remove both files.',
      );
    }
    return meta.vaultKeyMode;
  }
  return 'dek-v1';
}

export function effectiveVaultKeyMode(storeDir: string): VaultKeyMode {
  return readVaultMeta(storeDir)?.vaultKeyMode ?? inferVaultKeyMode(storeDir);
}
