# Distribution

## Table of Contents

1. [Release Process](#release-process)
2. [Binaries](#binaries)
3. [Building Locally](#building-locally)
4. [Homebrew Tap](#homebrew-tap)
5. [Versioning and Changelog](#versioning-and-changelog)
6. [Fallback: Node + dist/](#fallback-node--dist)

---

## Release Process

Releases are cut by pushing a version tag. The GitHub Actions workflow handles the rest.

1. Update `package.json` version and `CHANGELOG.md`.
2. Commit: `git commit -m "chore: release v1.x.x"`.
3. Tag: `git tag v1.x.x`.
4. Push tag: `git push origin v1.x.x`.

The `v*` tag triggers `.github/workflows/release.yml`, which:

1. Checks out the repo on a matrix of macOS, Linux, and Windows runners.
2. Runs `npm ci && npm run ui:install`.
3. Runs `npm run build` (TypeScript + Vite UI).
4. Runs `npm run build:cli:all` (all `pkg` targets).
5. Attaches the binary artifacts to the GitHub Release created for the tag.

---

## Binaries

The release workflow produces three platform binaries using `@yao-pkg/pkg` with Node 20 hostnames:

| Binary | Target triple | Notes |
|---|---|---|
| `studio-pro-macos` | `node20-darwin-arm64` | Apple Silicon; Intel Macs can run via Rosetta 2 |
| `studio-pro-linux` | `node20-linux-x64` | x86-64; ARM Linux requires a manual build |
| `studio-pro-windows.exe` | `node20-win32-x64` | Windows 10/11 x64 |

Native modules (`better-sqlite3`, `libsodium-wrappers-sumo`) are bundled as `pkg` assets listed under `pkg.assets` in `package.json`.

To run a downloaded binary:

```bash
# macOS / Linux
chmod +x studio-pro-macos
./studio-pro-macos
```

```powershell
# Windows
.\studio-pro-windows.exe
```

The server starts on `http://localhost:3737` and opens a browser tab automatically.

---

## Building Locally

See [BUILDING.md](../BUILDING.md) for the complete setup guide. Quick reference:

### Prerequisites

- Node.js 20.x or later
- npm 10.x or later

### Development mode

```bash
npm install
npm run ui:install
npm run dev:full
```

This runs `tsc` in watch mode and Vite in watch mode simultaneously. The server restarts when TypeScript files change; the UI hot-reloads in the browser.

### Production Node build

```bash
npm run build
node dist/studio/server.js
```

`npm run build` compiles the TypeScript backend to `dist/` and builds the React UI into `src/studio/static/` (and `dist/studio/static/` for `pkg`).

### Single binary (current platform)

```bash
npm run build:backend   # or npm run build for the full build
npm run build:cli
```

Output: `binaries/studio-pro-<target>` (e.g., `binaries/studio-pro-node20-darwin-arm64`).

### All platform binaries

```bash
npm run build:cli:all
```

Builds for all three targets in sequence. Cross-compilation requires the target platform's native modules to be available — if `pkg` fails for a platform, use the [fallback method](#fallback-node--dist) instead.

---

## Homebrew Tap

A Homebrew tap is planned at `github.com/sidthekid134/homebrew-studio-pro`. Once active, installation will be:

```bash
brew tap sidthekid134/studio-pro
brew install studio-pro
```

The formula will reference the GitHub Release binary URL for the current macOS target and include the SHA-256 checksum. A template formula is available at `release/homebrew-studio-pro.rb.template` in the repository.

To update the formula for a new release:

1. Download the macOS binary from the GitHub Release.
2. Compute the SHA-256: `shasum -a 256 studio-pro-macos`.
3. Update the `url` and `sha256` fields in the formula.
4. Push to the tap repository.

---

## Versioning and Changelog

Studio Pro follows **semantic versioning** (`MAJOR.MINOR.PATCH`):

| Increment | When |
|---|---|
| `PATCH` | Backward-compatible bug fixes |
| `MINOR` | New plugins, new features, backward-compatible changes |
| `MAJOR` | Breaking changes to the vault format, CLI flags, or plugin API |

`CHANGELOG.md` at the repository root is updated for every release. Each entry lists:
- New integrations and plugins added
- Bug fixes and behavioral changes
- Any migration steps required (e.g., vault format changes)

### Version compatibility notes

- **Pre-1.0 vaults** — vaults encrypted with the old PBKDF2 KDF (pre-v1.0) are not readable by v1.0+. Export your credentials before upgrading. See [security.md](./security.md#pbkdf2--removed) for details.
- **Native module versions** — `better-sqlite3` and `libsodium-wrappers-sumo` are pinned in `package.json`. If you build from source, use `npm ci` (not `npm install`) to ensure exact versions.

---

## Fallback: Node + dist/

If the `pkg` binary does not work on your platform (uncommon native module issue or unsupported architecture), you can run Studio Pro directly from the compiled output:

```bash
git clone <repo>
cd structure
npm ci
npm run ui:install
npm run build
node dist/studio/cli.js
```

This is functionally identical to the bundled binary — the `pkg` binary is just a convenience wrapper that bundles Node.js and `node_modules` into a single file.

Optional metadata for tooling (e.g., update checkers) is available at `release/latest.template.json`.
