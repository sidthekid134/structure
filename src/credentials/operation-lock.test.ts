import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-test-'));
const locksDir = path.join(tmpDir, 'locks');

jest.mock('os', () => ({
  ...jest.requireActual('os'),
  homedir: () => tmpDir,
}));

import { LockTimeoutError, OperationLock } from './operation-lock';

afterEach(() => {
  if (fs.existsSync(locksDir)) {
    for (const f of fs.readdirSync(locksDir)) {
      fs.unlinkSync(path.join(locksDir, f));
    }
  }
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('OperationLock.acquire', () => {
  it('creates a lock file on acquire', async () => {
    const lock = new OperationLock(locksDir);
    await lock.acquire('app1');
    expect(fs.existsSync(path.join(locksDir, 'app1.lock'))).toBe(true);
    lock.release('app1');
  });

  it('removes lock file on release', async () => {
    const lock = new OperationLock(locksDir);
    await lock.acquire('app1');
    lock.release('app1');
    expect(fs.existsSync(path.join(locksDir, 'app1.lock'))).toBe(false);
  });

  it('creates locks dir if it does not exist', async () => {
    const nestedDir = path.join(tmpDir, 'nested', 'locks');
    const lock = new OperationLock(nestedDir);
    await lock.acquire('app1');
    expect(fs.existsSync(path.join(nestedDir, 'app1.lock'))).toBe(true);
    lock.release('app1');
  });

  it('allows concurrent locks on different apps', async () => {
    const lock = new OperationLock(locksDir);
    await lock.acquire('app1');
    await lock.acquire('app2');
    expect(fs.existsSync(path.join(locksDir, 'app1.lock'))).toBe(true);
    expect(fs.existsSync(path.join(locksDir, 'app2.lock'))).toBe(true);
    lock.release('app1');
    lock.release('app2');
  });

  it('blocks concurrent lock on same app until released', async () => {
    const lock1 = new OperationLock(locksDir);
    const lock2 = new OperationLock(locksDir);

    await lock1.acquire('sameapp');

    let secondAcquired = false;
    const secondPromise = lock2.acquire('sameapp', 500).then(() => {
      secondAcquired = true;
    });

    // Second lock is not yet acquired
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(secondAcquired).toBe(false);

    // Release first lock — second should now acquire
    lock1.release('sameapp');
    await secondPromise;
    expect(secondAcquired).toBe(true);
    lock2.release('sameapp');
  });

  it('throws LockTimeoutError when lock cannot be acquired within timeout', async () => {
    const lock1 = new OperationLock(locksDir);
    const lock2 = new OperationLock(locksDir);

    await lock1.acquire('blocked');
    await expect(lock2.acquire('blocked', 150)).rejects.toThrow(LockTimeoutError);
    lock1.release('blocked');
  });
});

describe('OperationLock.release', () => {
  it('is idempotent — releasing a non-existent lock does not throw', () => {
    const lock = new OperationLock(locksDir);
    expect(() => lock.release('nonexistent')).not.toThrow();
  });
});
