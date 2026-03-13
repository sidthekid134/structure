import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { CredentialEntry } from '../types/credentials';
import { decrypt, encrypt } from './encryption';

const PLATFORM_DIR = join(homedir(), '.platform');
const VAULT_FILE = join(PLATFORM_DIR, 'credentials.enc');

export class NotFoundError extends Error {
  constructor(provider: string, key: string) {
    super(`Credential not found: provider="${provider}", key="${key}"`);
    this.name = 'NotFoundError';
  }
}

function ensurePlatformDir(): void {
  if (!existsSync(PLATFORM_DIR)) {
    mkdirSync(PLATFORM_DIR, { recursive: true, mode: 0o700 });
  }
}

export class Vault {
  private readonly password: string;

  constructor(masterPassword: string) {
    this.password = masterPassword;
  }

  exists(): boolean {
    return existsSync(VAULT_FILE);
  }

  private read(): CredentialEntry[] {
    if (!this.exists()) return [];
    const raw = readFileSync(VAULT_FILE);
    const json = decrypt(raw, this.password);
    return JSON.parse(json) as CredentialEntry[];
  }

  private write(entries: CredentialEntry[]): void {
    ensurePlatformDir();
    const json = JSON.stringify(entries);
    const encrypted = encrypt(json, this.password);
    writeFileSync(VAULT_FILE, encrypted, { mode: 0o600 });
  }

  store(provider: string, key: string, value: string): void {
    const entries = this.read();
    const now = Date.now();
    const existing = entries.findIndex((e) => e.provider === provider && e.key === key);

    if (existing >= 0) {
      entries[existing] = { ...entries[existing], value, updatedAt: now };
    } else {
      entries.push({ provider, key, value, createdAt: now, updatedAt: now });
    }

    this.write(entries);
  }

  retrieve(provider: string, key: string): string {
    const entries = this.read();
    const entry = entries.find((e) => e.provider === provider && e.key === key);
    if (!entry) throw new NotFoundError(provider, key);
    return entry.value;
  }

  list(provider: string): string[] {
    const entries = this.read();
    return entries.filter((e) => e.provider === provider).map((e) => e.key);
  }
}
