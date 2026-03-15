/**
 * Core types for the credential vault system.
 */

/** Schema version for the vault file format */
export const VAULT_SCHEMA_VERSION = '1.0';

/**
 * Represents a single provider's credential entry stored in the vault.
 */
export interface CredentialSchema {
  providerId: string;
  credentials: Record<string, string>;
  encryptedAt: number;
  version: string;
}

/**
 * The full vault structure stored at ~/.platform/credentials.enc
 */
export interface VaultData {
  schemaVersion: string;
  entries: Record<string, CredentialSchema>;
  createdAt: number;
  updatedAt: number;
}

/**
 * Logging callback type — receives a structured log entry without sensitive data.
 */
export interface LogEntry {
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  operation?: string;
  providerId?: string;
  timestamp: number;
  context?: Record<string, unknown>;
}

export type LoggingCallback = (entry: LogEntry) => void;

// ---------------------------------------------------------------------------
// Error hierarchy
// ---------------------------------------------------------------------------

/** Base class for all credential vault errors. */
export class CredentialError extends Error {
  public readonly timestamp: number;
  constructor(
    message: string,
    public readonly operation: string,
    public readonly providerId?: string,
  ) {
    super(message);
    this.name = 'CredentialError';
    this.timestamp = Date.now();
  }
}

/** Thrown when encryption or decryption fails. */
export class CryptoError extends CredentialError {
  constructor(
    message: string,
    operation: string,
    providerId?: string,
    public readonly cause?: unknown,
  ) {
    super(message, operation, providerId);
    this.name = 'CryptoError';
  }
}

/** Thrown when vault file I/O operations fail. */
export class VaultError extends CredentialError {
  constructor(
    message: string,
    operation: string,
    public readonly vaultPath?: string,
    public readonly cause?: unknown,
  ) {
    super(message, operation);
    this.name = 'VaultError';
  }
}

/** Thrown when input validation fails. */
export class ValidationError extends CredentialError {
  constructor(
    message: string,
    operation: string,
    public readonly field?: string,
    public readonly expected_type?: string,
    public readonly actual_value?: unknown,
  ) {
    super(message, operation);
    this.name = 'ValidationError';
  }
}

/**
 * Thrown when encryption or decryption validation fails.
 * Extends CryptoError so existing catch blocks remain compatible.
 */
export class EncryptionError extends CryptoError {
  constructor(
    message: string,
    operation: string,
    public readonly key_derivation_params?: Record<string, unknown>,
    providerId?: string,
    cause?: unknown,
  ) {
    super(message, operation, providerId, cause);
    this.name = 'EncryptionError';
  }
}
