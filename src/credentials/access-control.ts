import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { OperationLock } from './operation-lock';
import { Vault } from './vault';

const OPERATIONS_DIR = join(homedir(), '.platform', 'operations');

export interface OperationState {
  operationId: string;
  appId: string;
  startTime: number;
  stepsCompleted: string[];
  currentStep: string | null;
  errors: string[];
}

export class CredentialAccessContext {
  private readonly vault: Vault;
  private readonly lock: OperationLock;
  private readonly operationsDir: string;

  constructor(masterPassword: string, operationsDir: string = OPERATIONS_DIR) {
    this.vault = new Vault(masterPassword);
    this.lock = new OperationLock();
    this.operationsDir = operationsDir;
  }

  async withOperation<T>(
    appId: string,
    operationId: string,
    fn: (state: OperationState) => Promise<T>,
  ): Promise<T> {
    await this.lock.acquire(appId);

    const state: OperationState = {
      operationId,
      appId,
      startTime: Date.now(),
      stepsCompleted: [],
      currentStep: null,
      errors: [],
    };

    try {
      return await fn(state);
    } catch (err: any) {
      // Store error state but keep completed work intact for retry
      state.errors.push(err.message ?? String(err));
      throw err;
    } finally {
      this.lock.release(appId);
    }
  }

  getCredentialForOperation(operationId: string, provider: string, key: string): string {
    // Log access for audit trail — credential value is never logged
    console.log(
      `[audit] operation="${operationId}" provider="${provider}" key="${key}" accessed at=${new Date().toISOString()}`,
    );
    return this.vault.retrieve(provider, key);
  }

  isStepCompleted(operationId: string, stepName: string): boolean {
    const markerFile = join(this.operationsDir, operationId, `${stepName}.done`);
    return existsSync(markerFile);
  }

  markStepCompleted(operationId: string, stepName: string): void {
    const stepDir = join(this.operationsDir, operationId);
    if (!existsSync(stepDir)) {
      mkdirSync(stepDir, { recursive: true, mode: 0o700 });
    }
    const markerFile = join(stepDir, `${stepName}.done`);
    writeFileSync(markerFile, new Date().toISOString(), { mode: 0o600 });
  }
}
