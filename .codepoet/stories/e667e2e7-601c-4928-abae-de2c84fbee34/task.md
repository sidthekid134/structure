# Goal: Credential Management & Encryption
Manages secure storage and retrieval of all provider credentials using password-based encryption. Handles the encrypted local vault, master password creation, and credential access for all provisioning operations. Provides the security foundation for the entire system.

# Your Task: Users can create a master password and securely store encrypted credentials locally

## Description
Create the local encrypted vault file structure (~/.platform/credentials.enc), implement master password creation on first run, and build the encryption/decryption layer using password-based encryption. This establishes the secure storage foundation.

## Acceptance Criteria
- User is prompted to create a master password on first platform run
- Master password is hashed and stored securely (not plaintext)
- Credentials can be stored to vault and retrieved with correct decryption
- Vault file is binary-encrypted and unreadable without master password
- Attempting to retrieve non-existent credential returns clear error message

## Implementation Notes
- Create Vault class in src/credentials/vault.ts that manages ~/.platform/credentials.enc file lifecycle with read/write/exists methods.
- Implement password-based encryption using PBKDF2 for key derivation and AES-256-GCM for symmetric encryption in src/credentials/encryption.ts.
- Add MasterPasswordManager in src/credentials/master-password.ts that prompts user for password on first run, stores hashed password in ~/.platform/master.hash, and validates password on subsequent runs.
- Define CredentialEntry type in src/types/credentials.ts with fields: provider (string), key (string), value (string), createdAt (timestamp), updatedAt (timestamp).
- Implement vault.store(provider, key, value) to encrypt and append credential entry to vault file.
- Implement vault.retrieve(provider, key) to decrypt vault file and return matching credential value or throw NotFoundError.
- Add vault.list(provider) to return all keys for a given provider without exposing values.

## Completion
Verify your changes work — run relevant tests or checks appropriate for this project.

### Project hygiene
You are scaffolding a new project. Before installing any dependencies:
- Create a `.gitignore` appropriate for the stack (node_modules/, __pycache__/, .venv/, dist/, .env, etc.).
- Include a `README.md` with setup instructions (clone → install → run).

Then create `.codepoet/stories/e667e2e7-601c-4928-abae-de2c84fbee34/done.json` with this exact structure:
```json
{
  "status": "completed",
  "summary": "<brief summary of what you did>",
  "files_changed": ["list", "of", "files"]
}
```
IMPORTANT: The file MUST be at exactly `.codepoet/stories/e667e2e7-601c-4928-abae-de2c84fbee34/done.json`.
Do not create this file until you are fully done.
Do NOT perform any git operations (no git add, commit, or push).