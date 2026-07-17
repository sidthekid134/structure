# Structure

**Ship the app, not the setup.**

Structure is a local provisioning tool for app builders. It helps you take a project from “runs on my machine” to launch-ready by guiding the setup of Firebase, Google Cloud, GitHub, Expo EAS, Apple Developer, Google Play, Cloudflare, CI secrets, OAuth configuration, and LLM provider keys from one encrypted local workspace.

It is built for founders, solo developers, agencies, and small teams who can build the product but do not want to lose days to provider consoles, signing keys, service accounts, app store setup, DNS records, and fragile launch checklists.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![CI](https://github.com/sidthekid134/structure/actions/workflows/ci.yml/badge.svg)](https://github.com/sidthekid134/structure/actions/workflows/ci.yml)

---

## Why Structure?

Most production app setup is not hard because any one provider is impossible. It is hard because the work is scattered:

- Firebase needs projects, apps, services, credentials, and rules.
- Apple and Google Play need developer accounts, signing assets, bundle IDs, and store credentials.
- Expo EAS needs build and submission configuration.
- GitHub needs repositories, environments, workflow files, and secrets.
- Cloudflare needs domain zones, DNS records, and nameserver verification.
- OAuth callbacks must line up across web, iOS, Android, Firebase, and provider dashboards.
- API keys and service account JSON need to be stored somewhere safer than notes, chat, shell history, or random `.env` files.

Structure gives that setup a visible dependency graph. It runs what can be automated, pauses for required human actions, stores produced credentials in a local encrypted vault, and shows you what is complete, blocked, or ready to run next.

---

## What You Can Build With It

Structure supports project templates for:

| Template | Use Case |
|---|---|
| Mobile App | Cross-platform mobile apps with Firebase, EAS, app store, signing, push, and CI setup |
| Web App | Web-focused apps with auth, data, CI, DNS, and managed cloud foundations |
| API Backend | Backend services with cloud runtime, data, auth, and deployment workflows |
| Custom | Pick only the modules your project needs |

Built-in integrations include:

| Area | Structure Helps With |
|---|---|
| Google Cloud / Firebase | GCP project foundation, Firebase setup, Auth, Firestore, Storage, Messaging, service accounts |
| GitHub | Repository setup, CI workflow files, environments, repository secrets, environment secrets |
| Expo EAS | Mobile build configuration and store submission support |
| Apple Developer | App Store Connect credentials, code signing, distribution assets, push keys |
| Google Play | Android signing and publishing setup |
| Cloudflare | Domain zone setup, DNS routing, nameserver verification |
| LLM Providers | OpenAI, Anthropic, Gemini, or custom endpoint keys stored per project |
| Fullstack Delivery | Web/API Cloud Run deployment structure for `apps/web`, `apps/api`, and shared packages |

---

## How It Works

Structure runs locally and opens a browser UI backed by a local Express server. Your projects, credentials, and provisioning state stay on your machine.

The workflow is:

1. Create a project and choose a template or modules.
2. Connect the providers your project needs.
3. Review the generated provisioning plan.
4. Run ready steps from the dependency graph.
5. Complete any required manual gates, such as account enrollment or DNS delegation.
6. Inspect produced resources, uploaded secrets, and completed setup.

Provisioning is graph-based, so Structure understands which steps depend on which credentials, accounts, providers, and generated resources. That makes it easier to resume setup, troubleshoot blockers, and repeat the same launch path across projects.

---

## Security and Privacy

Structure is local-first by design.

| Layer | Behavior |
|---|---|
| Network | Binds to `127.0.0.1` by default. Public bind requires explicit opt-in. |
| Vault | Credentials are stored in a local encrypted vault. |
| Auth | WebAuthn passkeys can gate vault unlock. |
| Encryption | AES-256-GCM authenticated encryption with Argon2id key derivation where passphrases are used. |
| OAuth | OAuth flows use PKCE and state validation. Authorization codes are not logged. |
| Telemetry | No analytics, crash reporting, usage tracking, or phone-home logic. |

Structure only contacts external providers when you configure an integration and run a provisioning step that requires that provider.

Read more:

- [docs/security.md](./docs/security.md)
- [docs/privacy.md](./docs/privacy.md)
- [SECURITY.md](./SECURITY.md)

---

## Quickstart

### Download a Binary

Download the latest release for your platform from the [GitHub Releases page](https://github.com/sidthekid134/structure/releases).

| Platform | Download |
|---|---|
| macOS Apple Silicon | `Structure-v*.dmg` |
| Linux x86_64 | `structure-x86_64-unknown-linux-gnu.tar.gz` |
| Linux arm64 | `structure-aarch64-unknown-linux-gnu.tar.gz` |

Structure opens in your browser at:

```text
http://localhost:3737
```

On first run, create or unlock the local vault. Future access requires vault unlock.

### Run From Source

Requirements:

- Node 22+
- npm

```bash
git clone https://github.com/sidthekid134/structure
cd structure
npm install
npm run ui:install
npm run dev:full
```

Open:

```text
http://localhost:3738
```

Development mode uses `STRUCTURE_PROFILE=dev` and `STRUCTURE_PORT=3738` so it stays isolated from a production install. To test passkey registration in development, open:

```text
http://localhost:3738?passkey=1
```

See [BUILDING.md](./BUILDING.md) for local binary builds.

---

## Useful Commands

```bash
npm run dev:full        # Run backend and UI watcher for local development
npm run build           # Build UI and TypeScript backend
npm run build:cli       # Build the local CLI binary
npm run test            # Run Jest tests
npm run typecheck       # Type-check without emitting files
npm run reset:data      # Destroy local Structure data for the active profile
```

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `STRUCTURE_STORE_DIR` | OS app data dir for `structure` | Override data directory |
| `STRUCTURE_PROFILE` | unset | Isolate app data per profile, such as `dev` |
| `STRUCTURE_PORT` | `3737` | Listen port |
| `STRUCTURE_HOST` | `127.0.0.1` | Bind address |
| `STRUCTURE_SERVE_UI_FROM_SOURCE` | unset | Serve dashboard from source during development |
| `STRUCTURE_NO_OPEN` | unset | Skip opening the browser |

---

## Fullstack Repository Layout

For Structure-managed fullstack Cloud Run deployment, use:

```text
apps/web        # React or Next.js app
apps/api        # Node/Express or Flask service
packages/*      # shared packages
```

Each deployable service owns its Dockerfile. The default Docker build context is the repository root (`.`) so shared packages are available during image builds. Existing single-service and root-Dockerfile repositories continue to work.

---

## Extending Structure

Provisioning is plugin-driven.

- Built-in plugins live in `src/plugins/builtin/`.
- Step definitions live in `src/provisioning/steps/`.
- Runtime handlers are registered through `src/provisioning/step-handler-registry.ts`.
- Integrations are grouped through `src/plugins/builtin-integrations.ts`.

See [docs/authoring-plugins.md](./docs/authoring-plugins.md) for adding new integrations and provisioning steps.

---

## Documentation

| Doc | Description |
|---|---|
| [docs/architecture.md](./docs/architecture.md) | Core architecture, plugin registry, provisioning graph, API server |
| [docs/security.md](./docs/security.md) | Threat model, encryption, OAuth flow, file permissions |
| [docs/privacy.md](./docs/privacy.md) | Zero telemetry policy, external endpoints, data residency |
| [docs/authoring-plugins.md](./docs/authoring-plugins.md) | Add new integrations and plugin steps |
| [docs/distribution.md](./docs/distribution.md) | Release process and binary distribution |
| [BUILDING.md](./BUILDING.md) | Source setup, builds, and tests |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Contribution workflow |
| [CHANGELOG.md](./CHANGELOG.md) | Version history |

---

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](./CONTRIBUTING.md), and read [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) before opening issues or pull requests.

Report security issues privately through the process in [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE) © 2026 Sidhartha Moparthi
