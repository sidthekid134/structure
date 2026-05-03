/**
 * Lifecycle API routes — version, vault sealing/unsealing.
 *
 * Mounted under `/api`. Routes here intentionally bypass token auth for
 * `/version` so the bundled UI can do a capability handshake before
 * presenting the bootstrap flow. `/vault/*` routes still require the session
 * cookie session (mounted after `sessionGuard` in server.ts).
 */

import { Router } from 'express';
import * as fs from 'fs';
import { VaultManager } from '../vault.js';
import { getVaultSession } from './vault-session.js';
import { PLATFORM_CORE_VERSION } from '../providers/types.js';
import { loadUsers, type UsersFile } from './users-store.js';
import { effectiveVaultKeyMode } from './vault-meta.js';
import { destroyLocalStudioInstall } from './studio-local-data-destroy.js';
import { loadKeyWrappers } from './key-wrappers.js';
import {
  canUseDevAutoUnlockForStore,
  ensureDevVaultMeta,
  isDevVaultAutoUnlockEnabled,
} from './dev-vault.js';

function installCanDecryptVault(
  storeDir: string,
  vaultFilePath: string | undefined,
  usersFile: UsersFile | null,
): boolean {
  if (!usersFile || usersFile.credentials.length === 0) return false;
  if (!vaultFilePath || !fs.existsSync(vaultFilePath)) return false;
  try {
    const kw = loadKeyWrappers(storeDir);
    return kw.wraps.length > 0;
  } catch {
    return false;
  }
}

export interface LifecycleRouterOptions {
  vaultManager: VaultManager;
  appVersion?: string;
  vaultPath?: string;
  storeDir: string;
}

export function createLifecycleRouter(opts: LifecycleRouterOptions): Router {
  const router = Router();
  const session = getVaultSession();

  // -------------------------------------------------------------------------
  // Capability handshake — bypasses token auth (see auth.ts bypass list).
  // The version endpoint is what the Tauri shell (or hosted UI in the future)
  // hits to verify the daemon contract is compatible before talking secrets.
  // -------------------------------------------------------------------------
  router.get('/version', (_req, res) => {
    let usersFile;
    try {
      usersFile = loadUsers(opts.storeDir);
    } catch {
      usersFile = null;
    }
    const installDecryptable = installCanDecryptVault(opts.storeDir, opts.vaultPath, usersFile);
    const devAutoUnlock = isDevVaultAutoUnlockEnabled(process.env)
      && installDecryptable
      && canUseDevAutoUnlockForStore(opts.storeDir);
    const canDecryptVault = installDecryptable;
    const needsVaultKeySetup = !canDecryptVault;
    res.json({
      app: 'studio-pro',
      appVersion: opts.appVersion ?? process.env['npm_package_version'] ?? 'dev',
      platformCoreVersion: PLATFORM_CORE_VERSION,
      studioProfile: process.env['STUDIO_PROFILE']?.trim() || 'default',
      apiVersion: 1,
      pid: process.pid,
      startedAt: process.uptime() * 1000,
      sealed: session.isSealed(),
      vaultExists: opts.vaultPath ? fs.existsSync(opts.vaultPath) : null,
      /** True when this install has an encrypted vault and the on-disk material to derive the DEK (vault + key wrappers + WebAuthn metadata). */
      canDecryptVault,
      /** Local dev-only mode: encrypted vault with deterministic auto-unlock DEK. */
      devAutoUnlock,
      /** First-time flow: no decryptable vault yet (create vault + WebAuthn binding). */
      needsVaultKeySetup,
      /** @deprecated Use needsVaultKeySetup */
      needsRegistration: needsVaultKeySetup,
      /** @deprecated Use canDecryptVault */
      hasCredentials: canDecryptVault,
      webauthnUserName: canDecryptVault && usersFile ? usersFile.userName : null,
      prfSupported: true,
      /** True when serving dashboard assets from `src/studio/static` (live reload). */
      serveUiFromSource: process.env['STUDIO_SERVE_UI_FROM_SOURCE'] === '1',
    });
  });

  // -------------------------------------------------------------------------
  // Vault sealing/unsealing
  // -------------------------------------------------------------------------
  router.get('/vault/status', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    let vaultKeyMode: string;
    try {
      if (isDevVaultAutoUnlockEnabled(process.env) && canUseDevAutoUnlockForStore(opts.storeDir)) {
        ensureDevVaultMeta(opts.storeDir);
      }
      vaultKeyMode = effectiveVaultKeyMode(opts.storeDir);
    } catch (e) {
      res.status(503).json({
        code: 'VAULT_LAYOUT_UNSUPPORTED',
        error: (e as Error).message,
      });
      return;
    }
    res.json({
      ...session.status(),
      vaultExists: opts.vaultPath ? fs.existsSync(opts.vaultPath) : null,
      vaultKeyMode,
    });
  });

  router.post('/vault/seal', (_req, res) => {
    session.seal();
    res.json({ ok: true, status: session.status() });
  });

  router.post('/vault/destroy', (req, res) => {
    const confirm = typeof req.body?.confirm === 'string' ? req.body.confirm : '';
    if (confirm !== 'DESTROY_ALL_STUDIO_DATA') {
      res.status(400).json({ error: 'Invalid confirmation.' });
      return;
    }
    try {
      destroyLocalStudioInstall(opts.storeDir);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
      return;
    }
    session.seal();
    res.json({ ok: true });
  });

  return router;
}
