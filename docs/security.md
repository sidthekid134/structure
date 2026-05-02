# Security

## Table of Contents

1. [Threat Model](#threat-model)
2. [Encryption Overview](#encryption-overview)
3. [Vault File Format](#vault-file-format)
4. [Key Derivation](#key-derivation)
5. [Row-Level Credential Encryption](#row-level-credential-encryption)
6. [OAuth Security](#oauth-security)
7. [Studio Session Security](#studio-session-security)
8. [File Permissions](#file-permissions)
9. [What IS Protected](#what-is-protected)
10. [What Is NOT Protected](#what-is-not-protected)
11. [Dependency Posture](#dependency-posture)

---

## Threat Model

Studio Pro is a **local-only process**, not a server. There is no cloud backend, no shared database, and no multi-user access model. The relevant threat categories are:

| Threat | Mitigated by |
|---|---|
| Filesystem read (another user reads your vault file) | AES-256-GCM encryption at rest; 0600 file permissions |
| Vault passphrase brute-force | Argon2id memory-hard KDF (64 MiB, 2 iterations); makes GPU/ASIC attacks economically infeasible |
| OAuth token leakage via logs | Authorization codes and tokens are never logged; only field names and value shapes appear in server logs |
| OAuth token leakage via disk | Tokens stored encrypted inside the vault, never written plaintext |
| CSRF on the local Studio API | `sameSite=strict` session cookies; PKCE on all OAuth flows |
| Another local process intercepts the loopback OAuth callback | Loopback address + short-lived state parameter; code exchanged immediately and not stored |
| Passkey private-key exfiltration | Passkey private key lives entirely in the OS keychain (macOS Keychain, Windows Hello); Studio never touches it |

Studio Pro explicitly does **not** address:
- Local root access (a root-privileged process on the same machine can read process memory)
- Malware with user-level process access
- Compromised dependencies in your Node.js environment

---

## Encryption Overview

All secrets at rest use **AES-256-GCM** authenticated encryption.

- **Algorithm:** AES-256-GCM (AEAD — provides both confidentiality and integrity)
- **Key length:** 256 bits (32 bytes)
- **IV:** 16 bytes, randomly generated per encryption call
- **Auth tag:** 16 bytes (GCM default)
- **KDF:** Argon2id via `libsodium-wrappers-sumo`

Wire format (hex-encoded, colon-separated):

```
<iv_hex>:<authTag_hex>:<ciphertext_hex>
```

The auth tag is verified before any plaintext is returned. A tampered or corrupted vault file produces a `CryptoError` and is never partially decrypted.

---

## Vault File Format

The vault is stored as a single encrypted JSON file (typically `~/.platform/credentials.enc`). The logical structure after decryption is a versioned JSON object. Before decryption, the wire format encodes:

| Field | Size | Notes |
|---|---|---|
| IV (nonce) | 16 bytes (hex) | Random per write |
| Auth tag | 16 bytes (hex) | GCM integrity tag |
| Ciphertext | variable | Encrypted JSON payload |

The vault is written atomically:

1. Serialize and encrypt in memory.
2. Write to a temp file in the same directory.
3. `fsync` the temp file descriptor.
4. Rename (atomic on POSIX) to the final path.

This guarantees the vault file is never left in a partial or corrupt state after a crash or power loss.

---

## Key Derivation

### Argon2id (current — v1.0+)

The vault master key (DEK) is derived from the passphrase using **Argon2id**, the OWASP-recommended password-hashing function. Implementation uses `libsodium-wrappers-sumo` — the base `libsodium-wrappers` build omits password-hashing primitives; the sumo build is required.

Parameters (INTERACTIVE preset):

| Parameter | Value | Notes |
|---|---|---|
| Algorithm | Argon2id (ID 2) | `crypto_pwhash_ALG_ARGON2ID13` |
| Ops limit | 2 | `crypto_pwhash_OPSLIMIT_INTERACTIVE` |
| Memory limit | 67,108,864 bytes (64 MiB) | `crypto_pwhash_MEMLIMIT_INTERACTIVE` |
| Output length | 32 bytes | AES-256 key |

The salt is derived deterministically from a SHA-256 hash of the vault file path, so vault unlocks are stateless — no separate salt file is needed.

At the interactive preset, key derivation takes approximately 100 ms on typical hardware. The memory requirement means an attacker cannot parallelize brute-force attempts cheaply — 64 MiB per attempt limits GPU-scale attacks.

### Passkey PRF unlock

When a WebAuthn passkey is enrolled, the Studio server uses the **PRF extension** (`prf.eval`) to derive a per-credential symmetric key. This key unlocks the vault DEK without the user ever entering a passphrase. The passkey private key never leaves the OS authenticator; only the PRF output (a 32-byte value) is returned to the JavaScript layer.

### PBKDF2 — removed

The previous PBKDF2 key derivation path (`deriveKey`) was removed in **v1.0**. Vaults or migration bundles encrypted under PBKDF2-derived keys are no longer readable. Re-pair your vault by exporting credentials before upgrading from a pre-1.0 build.

---

## Row-Level Credential Encryption

Individual credentials stored inside the vault use **row-level encryption** derived from the vault DEK:

- A per-credential key is derived via **HKDF-SHA256** using the vault DEK as the input key material.
- The derivation info includes the credential identifier, so each credential has a unique encryption key even if the vault DEK is the same across entries.
- This limits blast radius: compromising one credential's derived key does not directly expose others.

---

## OAuth Security

All OAuth 2.0 flows use:

- **PKCE** (Proof Key for Code Exchange) — a fresh `code_verifier`/`code_challenge` pair is generated per authorization request. This prevents authorization code interception attacks, even on the loopback interface.
- **State parameter** — a cryptographically random value bound to the session, verified on callback. Mismatched state causes the flow to abort.
- **Loopback redirect URI** — the OAuth callback lands on `127.0.0.1` (or `localhost`); the authorization code is consumed immediately and never written to disk or logs.
- **Authorization codes are never logged** — server request logs record field names and value shapes only (e.g. `string(43 chars)`), not raw values.

---

## Studio Session Security

The Studio local web server (port 3737) uses session cookies with the following properties:

| Property | Value |
|---|---|
| `httpOnly` | `true` — inaccessible to JavaScript |
| `sameSite` | `strict` — not sent on cross-site navigations |
| TTL | 4 hours |
| Scope | `127.0.0.1` / `localhost` only |

WebSocket connections at `/ws/provisioning/:runId` require a short-lived ephemeral token validated by `validateWsEphemeralToken` before the upgrade completes. The ephemeral token is issued by the REST API and is single-use.

---

## File Permissions

- The vault file (`credentials.enc`) is created with mode **0600** (owner read/write only).
- The `storeDir` (default `~/.platform`) should not be world-readable. Studio does not currently enforce this at runtime, but you should verify: `chmod 700 ~/.platform`.
- The Studio server binds to `127.0.0.1` by default; it does not listen on a public interface.

---

## What IS Protected

- **Vault contents at rest** — all credentials, tokens, API keys, and service account JSON blobs are AES-256-GCM encrypted before being written to disk.
- **Vault integrity** — GCM authentication tag detects any tampering or corruption of the encrypted file.
- **Passphrase strength** — the Argon2id KDF makes brute-force attacks against a stolen vault file expensive in both time and memory.
- **OAuth tokens in transit** — tokens are only sent to their provider's HTTPS token endpoint. They are never logged or transmitted to any Studio-controlled server.
- **Authorization codes** — consumed immediately on callback receipt; not stored, not logged.
- **Passkey private key** — never held by Studio; stays inside the OS keychain or hardware authenticator.

## What Is NOT Protected

- **Local root** — a process running as root on the same machine can attach to the Studio process and read plaintext credentials from memory after the vault is unlocked.
- **User-level malware** — malware running as the same OS user can read the vault file and, if the vault is unlocked in the same session, may be able to extract the in-memory DEK.
- **Unlocked session window** — while the Studio server is running with an active passkey session, credentials are accessible via the local API. Lock the vault (or stop the server) when not in use.
- **Provider-side security** — Studio cannot protect against compromised GCP projects, revoked Apple certificates, or leaked tokens that were already sent to external providers.

---

## Dependency Posture

- **No telemetry** — the codebase contains no analytics, no crash-reporting SDKs, and no calls to any Anthropic or third-party telemetry endpoint.
- **No phone-home** — Studio makes outbound network calls only when you explicitly trigger a provisioning step or configure an integration. See [privacy.md](./privacy.md) for the full list of external endpoints.
- **libsodium-wrappers-sumo** is used for Argon2id only. The sumo build is audited and published by the libsodium project.
