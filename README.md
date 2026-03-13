# Platform Credential Manager

Secure local credential vault with password-based encryption, provisioning state tracking, and encrypted provider credential storage with audit trail.

## Setup

```bash
# Clone
git clone <repo-url>
cd <repo-dir>

# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test
```

## Provisioning Database

The provisioning schema manages three tables:

- **`provisioning_operations`** — tracks each provisioning job with status, idempotency key, and timestamps.
- **`provider_credentials`** — stores encrypted credential payloads per app/provider pair.
- **`provisioning_operation_logs`** — append-only audit log with per-step JSON results.

Run the migration against a PostgreSQL instance:

```bash
psql $DATABASE_URL -f src/db/schema.sql
```

Or use the programmatic migrator (runs schema.sql on first execution):

```ts
import { runMigration } from './src/db/migrate';
await runMigration(client); // node-postgres Client
```

## CredentialStore

Encrypts/decrypts credentials with AES-256-GCM and a scrypt-derived key (Argon2-equivalent). The master password hash is stored at `~/.provisioning/master.key`.

```ts
import { CredentialStore } from './src/credentials/credential-store';

const ciphertext = await CredentialStore.encrypt('my-secret', masterPassword);
const plaintext  = await CredentialStore.decrypt(ciphertext, masterPassword);
```

## Vault

Lower-level encrypted file-based store used by services above.

```ts
import { Vault } from './src/credentials/vault';

const vault = new Vault(masterPassword);
vault.store('aws', 'access_key', 'AKIAIOSFODNN7EXAMPLE');
const value = vault.retrieve('aws', 'access_key');
```
