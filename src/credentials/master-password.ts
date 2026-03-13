import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import * as readline from 'readline';

const PLATFORM_DIR = join(homedir(), '.platform');
const HASH_FILE = join(PLATFORM_DIR, 'master.hash');

function ensurePlatformDir(): void {
  if (!existsSync(PLATFORM_DIR)) {
    mkdirSync(PLATFORM_DIR, { recursive: true, mode: 0o700 });
  }
}

function hashPassword(password: string, salt: Buffer): string {
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  const salt = Buffer.from(saltHex, 'hex');
  const expectedHash = Buffer.from(hashHex, 'hex');
  const actualHash = scryptSync(password, salt, 64);
  return timingSafeEqual(expectedHash, actualHash);
}

function prompt(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (hidden && process.stdin.isTTY) {
      process.stdout.write(question);
      process.stdin.setRawMode(true);
      let input = '';
      process.stdin.on('data', (ch) => {
        const char = ch.toString();
        if (char === '\r' || char === '\n') {
          process.stdin.setRawMode(false);
          process.stdout.write('\n');
          rl.close();
          resolve(input);
        } else if (char === '\u0003') {
          process.exit();
        } else if (char === '\u007f') {
          input = input.slice(0, -1);
        } else {
          input += char;
        }
      });
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

export class MasterPasswordManager {
  hasPassword(): boolean {
    return existsSync(HASH_FILE);
  }

  /**
   * On first run: prompt user to create a master password, hash it, and store the hash.
   * On subsequent runs: prompt user to enter the password and validate it.
   * Returns the master password string for use in encryption.
   */
  async setup(): Promise<string> {
    ensurePlatformDir();

    if (!this.hasPassword()) {
      return this.createPassword();
    }
    return this.validatePassword();
  }

  private async createPassword(): Promise<string> {
    console.log('Welcome! Please create a master password to secure your credentials.');
    const password = await prompt('Master password: ', true);
    const confirm = await prompt('Confirm master password: ', true);

    if (password !== confirm) {
      throw new Error('Passwords do not match. Please try again.');
    }
    if (password.length < 8) {
      throw new Error('Master password must be at least 8 characters.');
    }

    const salt = randomBytes(32);
    const hashed = hashPassword(password, salt);
    writeFileSync(HASH_FILE, hashed, { mode: 0o600 });
    console.log('Master password created successfully.');
    return password;
  }

  private async validatePassword(): Promise<string> {
    const stored = readFileSync(HASH_FILE, 'utf8').trim();
    const password = await prompt('Enter master password: ', true);

    if (!verifyPassword(password, stored)) {
      throw new Error('Invalid master password.');
    }
    return password;
  }
}
