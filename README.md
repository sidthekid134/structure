# Studio Pro

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![CI](https://github.com/sidthekid134/structure/actions/workflows/ci.yml/badge.svg)](https://github.com/sidthekid134/structure/actions/workflows/ci.yml)

**Automated infrastructure provisioning and credential vault for mobile apps.** Studio Pro runs locally on your machine, stores all secrets encrypted at rest, and walks you through provisioning Firebase, EAS, GitHub, Apple, Cloudflare, Google Play, and LLM integrations from a single UI — no cloud services, no telemetry, no account required.

---

## Why Studio Pro?

- **One command, fully provisioned.** Spinning up a new React Native / Expo project means 15+ manual steps across 6 different consoles. Studio Pro drives the dependency graph automatically, pausing only when genuine human action is required (registering an Apple developer account, creating an App Store listing, etc.).
- **Secrets stay on your machine.** Everything is AES-256-GCM encrypted with an Argon2id-derived key; vault access is gated by WebAuthn passkeys (Touch ID / Windows Hello). Nothing leaves your machine unless you choose to push it.
- **Plugin-driven and extensible.** Integrations are first-class plugins. Adding support for a new provider means writing a plugin file and a step handler — no changes to core. See [docs/authoring-plugins.md](./docs/authoring-plugins.md).

---

## Quickstart

### Download a binary (recommended)

Download the latest release for your platform from the [GitHub Releases page](https://github.com/sidthekid134/structure/releases):

| Platform | Binary |
|---|---|
| macOS (Apple Silicon) | `studio-pro-aarch64-apple-darwin` |
| Linux x86_64 | `studio-pro-x86_64-unknown-linux-gnu` |
| Linux arm64 | `studio-pro-aarch64-unknown-linux-gnu` |

> **Intel Mac users:** Apple Silicon binaries run transparently under Rosetta 2 on Intel Macs, or build from source (see below).

```bash
# macOS / Linux — extract and run (execute bit is preserved in the tarball)
tar xzf studio-pro-aarch64-apple-darwin.tar.gz
./studio-pro-aarch64-apple-darwin
```

Studio opens in your browser at `http://localhost:3737`. On first run, register a passkey (Touch ID or security key) to seal the vault. All subsequent access requires the passkey — there are no recovery codes.

### From source (development)

Requirements: Node 20+, npm.

```bash
git clone https://github.com/sidthekid134/structure
cd structure
npm install
npm run ui:install
npm run dev:full
```

Open `http://localhost:3737`. In development mode, a dev session is created automatically so you are not prompted for a passkey on every reload. To test passkey registration, open `http://localhost:3737?passkey=1` once.

See [BUILDING.md](./BUILDING.md) for building the CLI binary locally.

---

## Security model

| Layer | Behavior |
|---|---|
| Network | Binds loopback only (`127.0.0.1`). Refuses non-loopback connections unless `STUDIO_ALLOW_PUBLIC_BIND=1`. |
| Auth | WebAuthn passkey (PRF extension) gates vault unlock. HttpOnly `studio_session` cookie (4-hour TTL) for subsequent API calls. |
| Encryption | AES-256-GCM authenticated encryption. Argon2id key derivation (memory-hard; no PBKDF2). |
| Disk | Vault file created with `0600` permissions. Row-level encryption for individual credentials via HKDF-SHA256. |
| OAuth | PKCE + state parameter on all OAuth flows. Authorization codes are never logged. |
| Exports | Migration exports encrypted with keys derived from the active vault session or an optional bundle passphrase. |

Full details: [docs/security.md](./docs/security.md) · [docs/privacy.md](./docs/privacy.md)

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `STUDIO_STORE_DIR` | OS app data dir for `studio-pro` | Override data directory |
| `STUDIO_PORT` | `3737` | Listen port |
| `STUDIO_HOST` | `127.0.0.1` | Bind address |
| `STUDIO_SERVE_UI_FROM_SOURCE` | unset | `1` serves dashboard from source (dev only) |
| `STUDIO_NO_OPEN` | unset | `1` skips opening the browser |

---

## Documentation

| Doc | Description |
|---|---|
| [docs/architecture.md](./docs/architecture.md) | Integration → Plugin → Step hierarchy, vault design, API server, build pipeline |
| [docs/security.md](./docs/security.md) | Threat model, encryption, OAuth flow, file permissions |
| [docs/privacy.md](./docs/privacy.md) | Zero-telemetry policy, external endpoints, data residency |
| [docs/authoring-plugins.md](./docs/authoring-plugins.md) | Guide for adding new integrations and plugins |
| [docs/distribution.md](./docs/distribution.md) | Release process, binary builds, Homebrew tap |
| [BUILDING.md](./BUILDING.md) | Building from source, running tests |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | How to contribute |
| [CHANGELOG.md](./CHANGELOG.md) | Version history |

---

## Built-in integrations

| Integration | Plugins |
|---|---|
| Google Cloud Platform / Firebase | firebase-core, firebase-auth, firebase-firestore, firebase-storage, firebase-messaging, oauth-social |
| Apple Developer | apple-signing |
| Google Play | google-play |
| GitHub | github-repo, github-ci |
| Expo / EAS | eas-builds, eas-submit |
| Cloudflare | cloudflare-domain |
| LLM Providers | llm-openai, llm-anthropic, llm-gemini, llm-custom |

Adding a new integration: [docs/authoring-plugins.md](./docs/authoring-plugins.md).

---

## Plugins

Provisioning is plugin-driven. Built-ins live in `src/plugins/builtin/`. Step data lives in `src/provisioning/steps/` (one file per provider). See [docs/architecture.md](./docs/architecture.md) for the full design and [docs/authoring-plugins.md](./docs/authoring-plugins.md) for a step-by-step guide.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Please read [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) before opening issues or pull requests.

## Security vulnerabilities

Report security issues privately — see [SECURITY.md](./SECURITY.md) for the disclosure process.

## License

[MIT](./LICENSE) © 2026 Sidhartha Moparthi
