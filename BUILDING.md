# Building Studio Pro

## Prerequisites

| Tool | Notes |
| --- | --- |
| Node.js | ≥ 20.x |
| npm | ≥ 10.x (repo is npm-first) |

Rust/Tauri are **not** required; distribution is the Node backend + Vite UI packaged with `@yao-pkg/pkg`.

## Setup

```bash
git clone <your-repo-url>
cd structure
npm install
npm run ui:install
```

### GCP OAuth credentials (required for Firebase/GCP integration)

GCP integration requires a Google OAuth desktop-app client. The official GitHub Releases binary ships with credentials pre-embedded by the release workflow. For local/source builds you must provide them yourself:

1. Create an OAuth 2.0 client in [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → "Desktop app" type.
2. Add `http://localhost` (no port) and `http://127.0.0.1` as authorized redirect URIs.
3. Create `.env.local` at the repo root (gitignored):

```bash
PLATFORM_GCP_OAUTH_CLIENT_ID=<your-client-id>.apps.googleusercontent.com
PLATFORM_GCP_OAUTH_CLIENT_SECRET=GOCSPX-<your-client-secret>
```

4. Load them before starting the server (e.g. `source .env.local && npm run dev:full`), or use [direnv](https://direnv.net/).

GCP OAuth is optional — all other integrations (EAS, GitHub, Apple, etc.) work without it.

## Development

```bash
npm run dev:full
```

Runs `tsc-watch` on the backend and Vite watch on `studio-ui`, emitting the UI into `src/studio/static/`. Open the URL logged by the server (default `http://localhost:3737`; the UI redirects `127.0.0.1` to `localhost` for WebAuthn).

## Production build (Node)

```bash
npm run build
```

Produces compiled JS under `dist/` and the static UI under `src/studio/static/` (and mirrored to `dist/studio/static` for `pkg`).

Run the server:

```bash
node dist/studio/server.js
```

## CLI single-binary (`studio-pro`)

After `npm run build:backend` (or full `npm run build`):

```bash
npm run build:cli
```

Uses `scripts/build-cli.js` and writes to `binaries/studio-pro-<rust-triple>`. Targets use Node 20 hostnames such as `node20-darwin-arm64` (see script).

All targets:

```bash
npm run build:cli:all
```

Native modules (`better-sqlite3`, libsodium) are listed under `pkg.assets` in `package.json`. If `pkg` fails for a platform, ship Node + `dist/` + `node_modules/` instead and run `node dist/studio/cli.js`.

## Releases & Homebrew

- Tag `v*` builds run `.github/workflows/release.yml`, which uploads `pkg` artifacts to GitHub Releases.
- Copy SHA256 sums into your external tap using `release/homebrew-studio-pro.rb.template`.
- Optional metadata shape for tooling: `release/latest.template.json`.

## Icons / PWA

The Vite app reads `studio-ui/public/manifest.webmanifest`. App icon: `studio-ui/public/studio-pro-icon.png`.
