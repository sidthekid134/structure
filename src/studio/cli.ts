#!/usr/bin/env node
/**
 * studio-pro CLI — foreground daemon + vault utilities.
 */

// Bundled CLI invocations are production by default. Anyone running the CLI
// for development can override by setting NODE_ENV explicitly. This default
// disables the dev-session shortcut in src/studio/auth.ts.
process.env['NODE_ENV'] ??= 'production';

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import envPaths from 'env-paths';
import { StudioServer } from './server.js';
import { registerPendingHandoffToken } from './auth.js';
import { destroyLocalStudioInstall } from './studio-local-data-destroy.js';

function defaultStoreDir(): string {
  return process.env['STUDIO_STORE_DIR'] ?? envPaths('studio-pro', { suffix: '' }).data;
}

function acquireLock(storeDir: string): void {
  const lockPath = path.join(storeDir, '.studio-pro.lock');
  if (fs.existsSync(lockPath)) {
    const raw = fs.readFileSync(lockPath, 'utf8').trim();
    const oldPid = parseInt(raw, 10);
    if (Number.isFinite(oldPid)) {
      try {
        process.kill(oldPid, 0);
        console.error(`studio-pro: another instance is running (pid ${oldPid}).`);
        process.exit(1);
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
}

function releaseLock(storeDir: string): void {
  try {
    fs.unlinkSync(path.join(storeDir, '.studio-pro.lock'));
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
  acquireLock(storeDir);
  const handoff = crypto.randomBytes(24).toString('base64url');
  registerPendingHandoffToken(handoff);
  const rawPort = process.env['STUDIO_PORT'];
  const parsedPort = rawPort !== undefined ? parseInt(rawPort, 10) : NaN;
  const studio = new StudioServer({
    storeDir,
    host: process.env['STUDIO_HOST'] ?? '127.0.0.1',
    port: Number.isFinite(parsedPort) ? parsedPort : 3737,
  });
  await studio.listen();
  const addr = studio.server.address();
  const boundPort =
    typeof addr === 'object' && addr !== null && 'port' in addr ? (addr as import('net').AddressInfo).port : 3737;
  const url = `http://localhost:${boundPort}/#handoff=${encodeURIComponent(handoff)}`;
  console.log(`Studio Pro: ${url}`);
  if (process.env['STUDIO_NO_OPEN'] !== '1') {
    openUrl(url);
  }
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      studio.close().finally(() => {
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
