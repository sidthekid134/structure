import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'access-control-test-'));

jest.mock('os', () => ({
  ...jest.requireActual('os'),
  homedir: () => tmpDir,
}));

import { CredentialAccessContext } from './access-control';
import { Vault } from './vault';

const PASSWORD = 'test-master-password';
const vaultFile = path.join(tmpDir, '.platform', 'credentials.enc');
const operationsDir = path.join(tmpDir, 'operations');

function ctx(): CredentialAccessContext {
  return new CredentialAccessContext(PASSWORD, operationsDir);
}

afterEach(() => {
  if (fs.existsSync(vaultFile)) fs.unlinkSync(vaultFile);
  if (fs.existsSync(operationsDir)) {
    fs.rmSync(operationsDir, { recursive: true, force: true });
  }
  // Clean up lock files
  const locksDir = path.join(tmpDir, '.platform', 'locks');
  if (fs.existsSync(locksDir)) {
    for (const f of fs.readdirSync(locksDir)) {
      fs.unlinkSync(path.join(locksDir, f));
    }
  }
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('CredentialAccessContext.withOperation', () => {
  it('runs the provided function and returns its result', async () => {
    const result = await ctx().withOperation('app1', 'op1', async (_state) => 'done');
    expect(result).toBe('done');
  });

  it('releases the lock after the operation completes', async () => {
    const c = ctx();
    await c.withOperation('app1', 'op1', async () => 'ok');
    // Should be able to acquire the lock again immediately
    await expect(c.withOperation('app1', 'op2', async () => 'ok2')).resolves.toBe('ok2');
  });

  it('releases the lock even when the operation throws', async () => {
    const c = ctx();
    await expect(
      c.withOperation('app1', 'op1', async () => {
        throw new Error('operation failed');
      }),
    ).rejects.toThrow('operation failed');

    // Lock should be released — next operation on same app should succeed
    await expect(c.withOperation('app1', 'op2', async () => 'recovered')).resolves.toBe(
      'recovered',
    );
  });

  it('allows concurrent operations on different apps', async () => {
    const c = ctx();
    const results = await Promise.all([
      c.withOperation('app1', 'op1', async () => 'app1-result'),
      c.withOperation('app2', 'op2', async () => 'app2-result'),
    ]);
    expect(results).toEqual(['app1-result', 'app2-result']);
  });

  it('blocks concurrent operations on the same app', async () => {
    const c = ctx();
    const order: number[] = [];

    const op1 = c.withOperation('sameapp', 'op1', async () => {
      order.push(1);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      order.push(2);
    });

    // Small delay so op1 acquires the lock first
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    const op2 = c.withOperation('sameapp', 'op2', async () => {
      order.push(3);
    });

    await Promise.all([op1, op2]);
    // op1 must fully complete (push 1 then 2) before op2 starts (push 3)
    expect(order).toEqual([1, 2, 3]);
  });

  it('exposes operationId and appId in state', async () => {
    let capturedState: any;
    await ctx().withOperation('myapp', 'myop', async (state) => {
      capturedState = state;
    });
    expect(capturedState.operationId).toBe('myop');
    expect(capturedState.appId).toBe('myapp');
    expect(typeof capturedState.startTime).toBe('number');
  });
});

describe('CredentialAccessContext.getCredentialForOperation', () => {
  it('retrieves a credential stored in the vault', () => {
    // Pre-populate vault
    const vault = new Vault(PASSWORD);
    vault.store('openai', 'api_key', 'sk-testkey12345678901');

    const retrieved = ctx().getCredentialForOperation('op1', 'openai', 'api_key');
    expect(retrieved).toBe('sk-testkey12345678901');
  });

  it('does not include credential value in audit log output', () => {
    const vault = new Vault(PASSWORD);
    vault.store('anthropic', 'api_key', 'sk-ant-supersecret12345678');

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    ctx().getCredentialForOperation('op1', 'anthropic', 'api_key');

    const loggedMessage = logSpy.mock.calls[0][0];
    expect(loggedMessage).toContain('op1');
    expect(loggedMessage).toContain('anthropic');
    expect(loggedMessage).toContain('api_key');
    expect(loggedMessage).not.toContain('sk-ant-supersecret12345678');

    logSpy.mockRestore();
  });
});

describe('CredentialAccessContext idempotency (step markers)', () => {
  it('isStepCompleted returns false before markStepCompleted', () => {
    expect(ctx().isStepCompleted('op1', 'deploy')).toBe(false);
  });

  it('isStepCompleted returns true after markStepCompleted', () => {
    const c = ctx();
    c.markStepCompleted('op1', 'deploy');
    expect(c.isStepCompleted('op1', 'deploy')).toBe(true);
  });

  it('step markers are independent per operationId', () => {
    const c = ctx();
    c.markStepCompleted('op1', 'deploy');
    expect(c.isStepCompleted('op2', 'deploy')).toBe(false);
  });

  it('step markers are independent per stepName', () => {
    const c = ctx();
    c.markStepCompleted('op1', 'deploy');
    expect(c.isStepCompleted('op1', 'configure')).toBe(false);
  });

  it('keeps completed step markers even when operation fails', async () => {
    const c = ctx();
    try {
      await c.withOperation('app1', 'op1', async (state) => {
        c.markStepCompleted('op1', 'step1');
        state.stepsCompleted.push('step1');
        throw new Error('step2 failed');
      });
    } catch {
      // expected
    }

    // step1 marker should persist for retry
    expect(c.isStepCompleted('op1', 'step1')).toBe(true);
  });
});
