#!/usr/bin/env node
/**
 * studio-pro CLI — foreground daemon + vault utilities.
 */

// Bundled CLI invocations are production by default. Anyone running the CLI
// for development can override by setting NODE_ENV explicitly. This default
// disables the dev-session shortcut in src/studio/auth.ts.
process.env['NODE_ENV'] ??= 'production';

// gaxios (used by google-auth-library) checks `typeof window !== 'undefined'`
// to choose between window.fetch and a dynamic `import('node-fetch')`. In the
// pkg bundle, node-fetch (ESM-only v3) is absent; Node.js 22 has a built-in
// fetch. Satisfy the check so gaxios uses native fetch and never attempts the
// dynamic import.
if (typeof globalThis.fetch !== 'undefined' && typeof (globalThis as Record<string, unknown>)['window'] === 'undefined') {
  (globalThis as Record<string, unknown>)['window'] = { fetch: globalThis.fetch.bind(globalThis) };
}

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import envPaths from 'env-paths';
import { StudioServer } from './server.js';
import { registerPendingHandoffToken } from './auth.js';
import { destroyLocalStudioInstall } from './studio-local-data-destroy.js';

const LOCK_FILE_NAME = '.studio-pro.lock';
const PORT_FILE_NAME = '.studio-pro.port';

function defaultStoreDir(): string {
  const explicit = process.env['STUDIO_STORE_DIR'];
  if (explicit) return explicit;
  const profile = process.env['STUDIO_PROFILE']?.trim();
  const appName = profile ? `studio-pro-${profile}` : 'studio-pro';
  return envPaths(appName, { suffix: '' }).data;
}

function lockFilePath(storeDir: string): string {
  return path.join(storeDir, LOCK_FILE_NAME);
}

function portFilePath(storeDir: string): string {
  return path.join(storeDir, PORT_FILE_NAME);
}

function acquireLock(storeDir: string): { acquired: true } | { acquired: false; pid: number } {
  const lockPath = lockFilePath(storeDir);
  if (fs.existsSync(lockPath)) {
    const raw = fs.readFileSync(lockPath, 'utf8').trim();
    const oldPid = parseInt(raw, 10);
    if (Number.isFinite(oldPid)) {
      try {
        process.kill(oldPid, 0);
        return { acquired: false, pid: oldPid };
      } catch (e: unknown) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== 'ESRCH') throw e;
      }
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
  }
  fs.writeFileSync(lockPath, `${process.pid}\n`, { mode: 0o600 });
  return { acquired: true };
}

function releaseLock(storeDir: string): void {
  try {
    fs.unlinkSync(lockFilePath(storeDir));
  } catch {
    /* ignore */
  }
}

function writePortFile(storeDir: string, port: number): void {
  fs.writeFileSync(portFilePath(storeDir), `${port}\n`, { mode: 0o600 });
}

function readPortFile(storeDir: string): number | null {
  try {
    const raw = fs.readFileSync(portFilePath(storeDir), 'utf8').trim();
    const port = parseInt(raw, 10);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function clearPortFile(storeDir: string): void {
  try {
    fs.unlinkSync(portFilePath(storeDir));
  } catch {
    /* ignore */
  }
}

function openUrl(url: string): void {
  try {
    if (process.platform === 'darwin') execFileSync('open', [url]);
    else if (process.platform === 'win32') execFileSync('cmd', ['/c', 'start', '', url]);
    else execFileSync('xdg-open', [url]);
  } catch {
    /* ignore */
  }
}

async function cmdStart(): Promise<void> {
  const storeDir = defaultStoreDir();
  fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  const rawPort = process.env['STUDIO_PORT'];
  const parsedPort = rawPort !== undefined ? parseInt(rawPort, 10) : NaN;
  const lock = acquireLock(storeDir);
  if (!lock.acquired) {
    const runningPort = readPortFile(storeDir) ?? (Number.isFinite(parsedPort) ? parsedPort : 3737);
    const runningUrl = `http://localhost:${runningPort}/`;
    console.error(`studio-pro: another instance is running (pid ${lock.pid}).`);
    console.log(`Studio Pro: ${runningUrl}`);
    if (process.env['STUDIO_NO_OPEN'] !== '1') {
      openUrl(runningUrl);
    }
    return;
  }

  const handoff = crypto.randomBytes(24).toString('base64url');
  registerPendingHandoffToken(handoff);
  const studio = new StudioServer({
    storeDir,
    host: process.env['STUDIO_HOST'] ?? '127.0.0.1',
    port: Number.isFinite(parsedPort) ? parsedPort : 3737,
  });
  try {
    await studio.listen();
  } catch (e) {
    clearPortFile(storeDir);
    releaseLock(storeDir);
    throw e;
  }
  const addr = studio.server.address();
  const boundPort =
    typeof addr === 'object' && addr !== null && 'port' in addr ? (addr as import('net').AddressInfo).port : 3737;
  writePortFile(storeDir, boundPort);
  const url = `http://localhost:${boundPort}/#handoff=${encodeURIComponent(handoff)}`;
  console.log(`Studio Pro: ${url}`);
  if (process.env['STUDIO_NO_OPEN'] !== '1') {
    openUrl(url);
  }
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      studio.close().finally(() => {
        clearPortFile(storeDir);
        releaseLock(storeDir);
        process.exit(0);
      });
    });
  }
}

function cmdVaultDestroy(args: string[]): void {
  const storeDir = defaultStoreDir();
  if (!args.includes('--i-am-sure')) {
    console.error('studio-pro vault destroy requires --i-am-sure');
    process.exit(1);
  }
  try {
    destroyLocalStudioInstall(storeDir);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  console.log(
    `Studio data destroyed under ${storeDir} (vault, sessions, api-token, organization, projects).`,
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? 'start';
  if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
    const pkgPath = path.join(__dirname, '../../package.json');
    const raw = fs.readFileSync(pkgPath, 'utf8');
    console.log(JSON.parse(raw).version as string);
    return;
  }
  if (cmd === 'start' || cmd === 'run') {
    await cmdStart();
    return;
  }
  if (cmd === 'vault' && argv[1] === 'destroy') {
    cmdVaultDestroy(argv.slice(2));
    return;
  }
  if (cmd === 'service') {
    console.error('studio-pro service install|uninstall is not implemented yet.');
    process.exit(1);
  }
  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
