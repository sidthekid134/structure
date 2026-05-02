/**
 * VaultSession — sealed/unsealed state for the long-running daemon (passkey DEK only).
 *
 * Semantics
 * ---------
 *   sealed   → no DEK in memory; vault on disk is encrypted; credential reads throw
 *              `VaultSealedError` so callers return HTTP 423.
 *   unsealed → 32-byte DEK resident in memory, idle timer running. Access via
 *              `getVaultDEK()` resets the idle timer.
 *
 * The session auto-reseals after `idleTimeoutMs` of inactivity (default 60 min).
 * It also reseals on `SIGTERM`/`SIGINT`.
 */

import { EventEmitter } from 'events';

export class VaultSealedError extends Error {
  readonly code = 'VAULT_SEALED' as const;
  constructor(message = 'Vault is sealed. Unlock the vault before continuing.') {
    super(message);
    this.name = 'VaultSealedError';
  }
}

export interface VaultSessionOptions {
  /** Idle timeout in ms before the session is auto-resealed. Default: 60 min. */
  idleTimeoutMs?: number;
}

export type VaultSessionEvent = 'unsealed' | 'sealed' | 'extended';
export type VaultSealReason = 'manual' | 'idle' | 'shutdown';

const DEFAULT_IDLE_TIMEOUT_MS = 60 * 60 * 1000;

export class VaultSession extends EventEmitter {
  private dekBuf: Buffer | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private unsealedAt: number | null = null;
  private lastUsedAt: number | null = null;
  private readonly idleTimeoutMs: number;

  constructor(options: VaultSessionOptions = {}) {
    super();
    this.idleTimeoutMs = Math.max(1000, options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
  }

  isSealed(): boolean {
    return this.dekBuf === null;
  }

  status(): {
    sealed: boolean;
    unsealedAt: number | null;
    lastUsedAt: number | null;
    idleTimeoutMs: number;
    expiresAt: number | null;
  } {
    return {
      sealed: this.isSealed(),
      unsealedAt: this.unsealedAt,
      lastUsedAt: this.lastUsedAt,
      idleTimeoutMs: this.idleTimeoutMs,
      expiresAt: this.lastUsedAt ? this.lastUsedAt + this.idleTimeoutMs : null,
    };
  }

  /** Install DEK after WebAuthn verify. */
  setVaultDEK(dek: Buffer): void {
    if (!Buffer.isBuffer(dek) || dek.length !== 32) {
      throw new TypeError('Vault DEK must be a 32-byte Buffer.');
    }
    this.zeroizeDek();
    this.dekBuf = Buffer.from(dek);
    const now = Date.now();
    this.unsealedAt = now;
    this.lastUsedAt = now;
    this.armIdleTimer();
    this.emit('unsealed');
  }

  /** Returns the active DEK or throws `VaultSealedError`. */
  getVaultDEK(): Buffer {
    if (this.dekBuf) {
      this.lastUsedAt = Date.now();
      this.armIdleTimer();
      this.emit('extended');
      return Buffer.from(this.dekBuf);
    }
    throw new VaultSealedError();
  }

  /** Manually seal the vault. */
  seal(): void {
    if (this.isSealed()) return;
    this.clearIdleTimer();
    this.zeroizeDek();
    this.unsealedAt = null;
    this.lastUsedAt = null;
    this.emit('sealed', 'manual');
  }

  attachShutdownHandlers(): void {
    const onExit = () => {
      this.clearIdleTimer();
      this.zeroizeDek();
      this.unsealedAt = null;
      this.lastUsedAt = null;
      this.emit('sealed', 'shutdown');
    };
    process.once('SIGINT', onExit);
    process.once('SIGTERM', onExit);
    process.once('beforeExit', onExit);
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.zeroizeDek();
      this.unsealedAt = null;
      this.lastUsedAt = null;
      this.emit('sealed', 'idle');
    }, this.idleTimeoutMs);
    if (typeof this.idleTimer.unref === 'function') {
      this.idleTimer.unref();
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private zeroizeDek(): void {
    if (this.dekBuf) {
      this.dekBuf.fill(0);
      this.dekBuf = null;
    }
  }
}

let _session: VaultSession | null = null;

/**
 * Returns the process-wide vault session, lazily creating it on first call.
 *
 * `STUDIO_VAULT_IDLE_MS` overrides the auto-reseal timer when set to a positive integer.
 */
export function getVaultSession(options?: VaultSessionOptions): VaultSession {
  if (!_session) {
    const envIdleMs = parseInt(process.env['STUDIO_VAULT_IDLE_MS'] ?? '', 10);
    const merged: VaultSessionOptions = {
      idleTimeoutMs:
        options?.idleTimeoutMs ?? (Number.isFinite(envIdleMs) && envIdleMs > 0 ? envIdleMs : undefined),
    };
    _session = new VaultSession(merged);
    _session.attachShutdownHandlers();
  }
  return _session;
}

/** Convenience: returns the DEK or throws `VaultSealedError`. */
export function getVaultUnlock(): Buffer {
  return getVaultSession().getVaultDEK();
}
