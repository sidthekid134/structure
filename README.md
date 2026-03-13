# Platform Credential Manager

Secure local credential vault with password-based encryption.

## Setup

```bash
# Clone
git clone <repo-url>
cd <repo-dir>

# Install
npm install

# Build
npm run build

# Run tests
npm test
```

## Usage

On first run, you will be prompted to create a master password. Credentials are stored encrypted at `~/.platform/credentials.enc`.

```ts
import { Vault } from './src/credentials/vault';

const vault = new Vault(masterPassword);
await vault.store('aws', 'access_key', 'AKIAIOSFODNN7EXAMPLE');
const value = await vault.retrieve('aws', 'access_key');
```
