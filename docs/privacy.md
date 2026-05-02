# Privacy

## Table of Contents

1. [Zero Telemetry](#zero-telemetry)
2. [All Data Stays Local](#all-data-stays-local)
3. [External Endpoints](#external-endpoints)
4. [Passkey Credential Storage](#passkey-credential-storage)
5. [OAuth Token Handling](#oauth-token-handling)
6. [What Studio Never Does](#what-studio-never-does)

---

## Zero Telemetry

Studio Pro collects **no data**. There are no analytics events, no crash reports, no usage metrics, and no calls to any telemetry service — including Anthropic's own infrastructure. The codebase contains no analytics SDK and no phone-home logic of any kind.

---

## All Data Stays Local

Every piece of data Studio Pro manages lives on your machine:

| Data | Location |
|---|---|
| Encrypted credential vault | `~/.platform/credentials.enc` (or your configured `storeDir`) |
| SQLite event log | `~/.platform/` |
| Project metadata | `~/.platform/` |
| OAuth refresh tokens | Inside the encrypted vault |
| LLM API keys | Inside the encrypted vault |
| Service account JSON blobs | Inside the encrypted vault |
| Studio session cookies | Your browser's `localhost` cookie store |

Nothing is uploaded, synced, or replicated to any remote service unless you deliberately configure an integration that requires it (see below).

---

## External Endpoints

Studio Pro makes outbound network connections **only when you configure the corresponding integration and trigger a provisioning step**. The complete list of external services the tool can contact:

### Google Cloud Platform

- **When:** GCP integration is connected (OAuth token present) and a Firebase or GCP provisioning step runs.
- **What is sent:** GCP OAuth access tokens, GCP project configuration, Firebase app registration data.
- **Endpoints:** `googleapis.com` (Cloud Resource Manager, Firebase Management, IAM, etc.)

### GitHub

- **When:** A GitHub Personal Access Token (PAT) is stored in the vault and a GitHub step runs.
- **What is sent:** Repository name, secrets payload (CI environment variables), workflow files.
- **Endpoints:** `api.github.com`

### Expo / EAS

- **When:** An Expo token is stored in the vault and an EAS provisioning step runs.
- **What is sent:** App bundle identifiers, build configuration, credentials for managed builds.
- **Endpoints:** `api.expo.dev`, `expo.io`

### Apple Developer / App Store Connect

- **When:** Apple credentials are configured (App Store Connect API key) and an Apple signing or app registration step runs.
- **What is sent:** App IDs, bundle identifiers, certificate requests, push notification key metadata.
- **Endpoints:** `api.appstoreconnect.apple.com`, `developer.apple.com`

### Google Play

- **When:** A Google Play service account is configured and a Play publishing step runs.
- **What is sent:** App signing fingerprints, internal test track configurations.
- **Endpoints:** `androidpublisher.googleapis.com`, `play.googleapis.com`

### Cloudflare

- **When:** A Cloudflare API token is stored in the vault and a domain step runs.
- **What is sent:** Zone identifiers, DNS record configurations.
- **Endpoints:** `api.cloudflare.com`

### LLM Providers

Studio Pro can store API keys for up to four LLM providers per project. A key is only used when the corresponding module is selected and provisioned. The key is sent directly to the provider's API — it does not pass through any Studio-controlled proxy.

| Provider | Endpoint contacted | When |
|---|---|---|
| OpenAI | `api.openai.com` | When `llm-openai` module is active and key is validated |
| Anthropic | `api.anthropic.com` | When `llm-anthropic` module is active and key is validated |
| Google Gemini | `generativelanguage.googleapis.com` | When `llm-gemini` module is active and key is validated |
| Custom endpoint | Your configured base URL | When `llm-custom` module is active |

---

## Passkey Credential Storage

When you enroll a passkey for vault unlock:

- The **passkey private key is stored entirely inside the OS keychain** — macOS Keychain on macOS, Windows Hello on Windows.
- Studio Pro never sees the private key. It only receives the **PRF output** (a 32-byte symmetric value derived by the authenticator) which is used to unlock the vault DEK.
- If you delete the passkey from your OS keychain, you will need to re-enroll or use your vault passphrase to unlock.

This is a standard WebAuthn PRF-extension flow. No passkey data is transmitted over the network.

---

## OAuth Token Handling

- OAuth access tokens and refresh tokens are **encrypted inside the vault** using AES-256-GCM before being written to disk.
- Tokens are only sent to the provider's own HTTPS token endpoint (e.g. `oauth2.googleapis.com/token` for Google).
- Authorization codes from the OAuth callback are consumed immediately and are never logged or stored.
- Server request logs record field names and value shapes only (e.g. `string(43 chars)`) — raw token values never appear in log output.

---

## What Studio Never Does

- Does not transmit credentials, vault contents, or project metadata to Anthropic or any Studio-operated server.
- Does not load remote scripts or stylesheets at runtime — the Studio UI is fully embedded in the binary.
- Does not use browser-based tracking, fingerprinting, or cookies scoped beyond `localhost`.
- Does not write credentials in plaintext anywhere on disk — all sensitive values are encrypted before storage.
- Does not contact external services during startup — no version checks, no license validation, no ping requests.
