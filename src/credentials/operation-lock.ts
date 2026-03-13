import { closeSync, existsSync, mkdirSync, openSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const LOCKS_DIR = join(homedir(), '.platform', 'locks');
const DEFAULT_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 100;

export class LockTimeoutError extends Error {
  constructor(appId: string) {
    super(`Timeout acquiring lock for app: "${appId}"`);
    this.name = 'LockTimeoutError';
  }
}

export class OperationLock {
  private readonly locksDir: string;

  constructor(locksDir: string = LOCKS_DIR) {
    this.locksDir = locksDir;
  }

  private lockPath(appId: string): string {
    return join(this.locksDir, `${appId}.lock`);
  }

  private ensureLocksDir(): void {
    if (!existsSync(this.locksDir)) {
      mkdirSync(this.locksDir, { recursive: true, mode: 0o700 });
    }
  }

  async acquire(appId: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<void> {
    this.ensureLocksDir();
    const lockFile = this.lockPath(appId);
    const deadline = Date.now() + timeoutMs;

    while (true) {
      try {
        // 'wx' flag: exclusive create — fails with EEXIST if file already exists
        const fd = openSync(lockFile, 'wx');
        closeSync(fd);
        return;
      } catch (err: any) {
        if (err.code !== 'EEXIST') throw err;
      }

      if (Date.now() >= deadline) {
        throw new LockTimeoutError(appId);
      }

      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  release(appId: string): void {
    const lockFile = this.lockPath(appId);
    if (existsSync(lockFile)) {
      unlinkSync(lockFile);
    }
  }
}
