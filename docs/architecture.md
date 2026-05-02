# Architecture

## Table of Contents

1. [Overview](#overview)
2. [Four-Level Hierarchy](#four-level-hierarchy)
3. [Plugin Registry](#plugin-registry)
4. [Vault Architecture](#vault-architecture)
5. [Provisioning Graph](#provisioning-graph)
6. [Journey Phases](#journey-phases)
7. [Studio API Server](#studio-api-server)
8. [Step Files and Registry](#step-files-and-registry)
9. [Build Pipeline](#build-pipeline)

---

## Overview

Studio Pro consists of three integrated pieces running on your local machine:

```
┌─────────────────────────────────────────────────┐
│  studio-pro binary (pkg-bundled Node.js)        │
│                                                 │
│  ┌──────────────┐   ┌────────────────────────┐  │
│  │  CLI entry   │   │  Express API server    │  │
│  │  (cli.ts)    │   │  port 3737             │  │
│  └──────┬───────┘   └───────────┬────────────┘  │
│         │                       │               │
│         └──────────┬────────────┘               │
│                    ▼                            │
│         ┌──────────────────────┐                │
│         │  Studio React UI     │                │
│         │  (embedded in        │                │
│         │  src/studio/static/) │                │
│         └──────────────────────┘                │
│                    │                            │
│         ┌──────────▼──────────┐                 │
│         │  AES-256-GCM Vault  │                 │
│         │  ~/.platform/       │                 │
│         └─────────────────────┘                 │
└─────────────────────────────────────────────────┘
```

- **CLI** (`src/studio/cli.ts`) starts the server and opens a browser.
- **API server** is an Express HTTP server on `127.0.0.1:3737`. All REST and WebSocket endpoints live here.
- **Studio UI** is a Vite-built React app embedded into `src/studio/static/` at build time and served by the same Express process.
- **Vault** is an AES-256-GCM encrypted JSON file that holds all credentials, tokens, and project secrets.

---

## Four-Level Hierarchy

The provisioning system is organized as a strict four-level hierarchy:

```
Integration
  └── Plugin
        └── Step
              └── StepHandler
```

### Integration

The top-level vendor or platform grouping. Defined in `src/plugins/builtin-integrations.ts` as an `IntegrationDefinition`. The Studio UI renders one swimlane per integration in the dependency graph.

Built-in integrations (in display order):

| ID | Label | Scope | Auth Provider |
|---|---|---|---|
| `gcp` | Google Cloud | project | `gcp` (OAuth) |
| `apple` | Apple | organization | `apple` |
| `google-play` | Google Play | organization | — |
| `github` | GitHub | organization | `github` (OAuth) |
| `eas` | Expo EAS | organization | `expo` |
| `cloudflare` | Cloudflare | organization | — |
| `llm` | LLM Providers | project | — |

`scope: 'organization'` means one connection for all projects in your org. `scope: 'project'` means a separate connection per project (e.g., a dedicated GCP project per app).

### Plugin

A feature unit within an integration, defined as a `PluginDefinition`. A plugin owns a set of provisioning steps, optional teardown steps, and user-action gates. One plugin maps to exactly one `integrationId`.

Example plugins:

| Plugin ID | Integration | Description |
|---|---|---|
| `firebase-core` | `gcp` | GCP project, Firebase setup, service accounts |
| `firebase-auth` | `gcp` | Firebase Authentication |
| `firebase-firestore` | `gcp` | Cloud Firestore database |
| `firebase-messaging` | `gcp` | FCM push notifications |
| `apple-signing` | `apple` | Code signing, distribution certs, push keys |
| `github-repo` | `github` | Repository creation, secrets |
| `github-ci` | `github` | CI workflow files |
| `eas-builds` | `eas` | Managed EAS Build configuration |
| `eas-submit` | `eas` | App store submission |
| `google-play` | `google-play` | Android signing, Play Console |
| `cloudflare-domain` | `cloudflare` | DNS, domain routing |
| `llm-openai` | `llm` | OpenAI API key |
| `llm-anthropic` | `llm` | Anthropic API key |
| `llm-gemini` | `llm` | Google Gemini API key |
| `llm-custom` | `llm` | Custom LLM endpoint |
| `oauth-social` | `gcp` | Social sign-in (Google, Apple) |

Plugins are registered in tier order (tier 0 first, then tiers that depend on them) in `src/plugins/builtin/index.ts` via `registerBuiltinPlugins()`.

### Step

An atomic provisioning task, represented as a `ProvisioningStepNode`. Each step has:

- A stable `key` (e.g., `firebase:create-gcp-project`)
- An `automationLevel`: `'full'` (system executes), `'assisted'` (system initiates, user completes a handoff), or `'manual'` (user does it entirely outside the platform)
- An `environmentScope`: `'global'` or `'per-environment'`
- A `platforms` mask: `'ios'`, `'android'`, or absent (applies to both)
- `DependencyRef[]` listing required and optional upstream steps
- `ResourceOutput[]` describing artifacts the step produces

There is also a `UserActionNode` type (key prefix `user:`) for gates that require human action outside the system (e.g., enrolling in the Apple Developer Program, uploading a `.p8` key).

### StepHandler

The runtime executor for a step. Defined via the `StepHandler` interface in `src/provisioning/step-handler-registry.ts`. Handlers implement:

| Method | Purpose |
|---|---|
| `create` | Execute the provisioning action; returns artifacts |
| `delete` | Tear down the resource |
| `validate` | Check real-world state without making changes |
| `sync` | Read current state and update stored artifacts |

Handlers receive a `StepHandlerContext` containing the project ID, upstream artifacts, a `getToken()` helper, direct vault access, and the 32-byte vault DEK for reading/writing secrets.

---

## Plugin Registry

`PluginRegistry` (in `src/plugins/plugin-registry.ts`) is a **singleton** — accessed globally as `globalPluginRegistry`. It is populated once at server startup by `registerBuiltinPlugins()`, which must be called before `createApiRouter`.

Key methods:

| Method | Description |
|---|---|
| `register(plugin)` | Register a `PluginDefinition`; throws if `id` is already registered |
| `getPluginsForIntegration(integrationId)` | Returns all plugins belonging to an integration |
| `getStepsForProvider(provider)` | Returns all steps across plugins for a provider type |
| `resolveIntegrationId(provider)` | Maps a provider string to its parent `integrationId` |

The constructor does **not** auto-populate from `BUILTIN_INTEGRATIONS`; that list is used by the Studio UI for rendering integration cards. Plugin registration is explicit, in dependency order.

---

## Vault Architecture

### VaultManager

`VaultManager` (`src/vault.ts`) wraps an AES-256-GCM encrypted JSON file. It provides:

- `load(masterKey)` — decrypt and parse the vault JSON
- `save(data, masterKey)` — serialize, encrypt, and atomically write the vault file
- `filePath` — absolute path to `credentials.enc`

The `masterKey` is a raw 32-byte `Buffer` (the vault DEK). VaultManager does not perform key derivation itself — the caller provides the key, derived either by `deriveKeyArgon2id()` or the passkey PRF flow.

Writes are atomic: serialize → encrypt → write temp file → `fsync` → `rename`. The vault is never partially overwritten.

### vault-session.ts

`src/studio/vault-session.ts` provides the **session-scoped unlock** for the Studio server. After a successful passkey authentication or passphrase entry, the DEK is held in memory for the session duration (4 hours). All API routes that need vault access call `getVaultSession()` to retrieve the in-memory DEK. If the vault is sealed (no active session), routes return a `VaultSealedError`.

---

## Provisioning Graph

The provisioning plan is a **directed acyclic graph** (DAG) of `ProvisioningNode` items.

- Nodes are `ProvisioningStepNode` or `UserActionNode`.
- Edges are expressed as `DependencyRef[]` on each node (pointing to upstream `nodeKey` values).
- The orchestrator performs a **topological sort** and executes nodes in batches — all nodes in a batch have their dependencies satisfied.
- A `UserActionNode` encountered during execution **pauses the run** and surfaces instructions to the user.
- Nodes carry a `platforms` mask; the plan filters out nodes not applicable to the project's target platforms (iOS, Android, or both).
- `required: false` dependencies in `DependencyRef` make a node optional — the downstream step runs even if the optional upstream step was skipped or failed.

---

## Journey Phases

Steps are organized into three named journey phases that determine which Studio UI tab they appear in:

| Phase | UI Tab | Description |
|---|---|---|
| `credentials` | Credentials | API keys, tokens, certificates — things you supply |
| `cloud_firebase` / `infrastructure` | Infrastructure | GCP projects, Firebase setup, platform registrations |
| `runtime` | Runtime | CI secrets, EAS build config, store submission |

A plugin declares `defaultJourneyPhase` for all its steps, and can override individual steps via `journeyPhaseOverrides` (e.g., the GCP billing step is an `accounts` phase gate even though it lives inside `firebase-core`).

---

## Studio API Server

The Express server (`src/studio/server.ts`) listens on `127.0.0.1:3737` by default.

### Routes

| Path | Description |
|---|---|
| `GET /` | Serves the embedded React Studio UI (`src/studio/static/index.html`) |
| `GET /api/integrations` | Returns `BUILTIN_INTEGRATIONS` list |
| `GET /api/projects` | Lists all projects |
| `POST /api/projects` | Creates a new project |
| `GET /api/projects/:id/plan` | Returns the provisioning plan DAG for a project |
| `POST /api/projects/:id/plan/run` | Starts a provisioning run |
| `GET /api/vault/status` | Returns vault seal/unlock status |
| `POST /api/vault/unlock` | Unlock with passphrase or passkey PRF |
| `/webauthn/*` | WebAuthn registration and authentication flow |
| `/lifecycle/*` | Server shutdown and vault lock |

### WebSocket

```
ws://localhost:3737/ws/provisioning/:runId
```

Streams live provisioning events (step started, step completed, step failed, user action required) for a specific run. The connection requires a valid ephemeral token issued by the REST API — `validateWsEphemeralToken` is called during the WebSocket upgrade handshake.

### Session cookies

`httpOnly`, `sameSite=strict`, 4-hour TTL. All API routes (except the unlock and WebAuthn routes) require a valid session cookie via the `createAuthMiddlewares` middleware chain.

---

## Step Files and Registry

Step data (the `ProvisioningStepNode` definitions) are organized per-provider under `src/provisioning/`:

- `step-registry.ts` — aggregates and exports all step arrays: `FIREBASE_STEPS`, `LLM_OPENAI_STEPS`, `USER_ACTIONS`, etc.
- `eas-step-handlers.ts` and similar files — register `StepHandler` implementations
- `step-handler-registry.ts` — the runtime registry; handlers are looked up by step key during plan execution

Plugins reference steps by picking from their provider's step array (e.g., `FIREBASE_STEPS.find(s => s.key === 'firebase:create-gcp-project')`), keeping step data decoupled from plugin metadata.

---

## Build Pipeline

### TypeScript backend

```
tsc → dist/
```

The TypeScript compiler emits to `dist/`. ES modules with `.js` extensions are used throughout.

### Studio UI

```
Vite → src/studio/static/
```

The React UI in `studio-ui/` is built with Vite. Output lands in `src/studio/static/` (and mirrored to `dist/studio/static/` for `pkg`). The Express server serves this directory as static files.

### Single binary

```
npm run build:cli
→ @yao-pkg/pkg → binaries/studio-pro-<target>
```

`scripts/build-cli.js` uses `@yao-pkg/pkg` to bundle the compiled JS, the static UI, and native modules (`better-sqlite3`, `libsodium-wrappers-sumo`) into a single self-contained binary. Targets use Node 20 hostnames (e.g., `node20-darwin-arm64`).

Native modules are listed under `pkg.assets` in `package.json`. If `pkg` cannot bundle for a given platform, fall back to distributing `dist/` + `node_modules/` and running `node dist/studio/cli.js` directly.
