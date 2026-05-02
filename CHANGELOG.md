# Changelog

All notable changes to Studio Pro are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Breaking:** PBKDF2 key derivation removed. All passphrase-based key
  derivation now uses Argon2id (libsodium `crypto_pwhash`). Migration
  bundles created with a passphrase by pre-1.0 builds can no longer be
  imported. The vault DEK is unchanged (passkey/PRF-derived).
- `SecretManager.storeSecret`, `retrieveSecret`, and
  `storeProviderCredentials` are now async (Argon2id is async).
- `sealMigrationExport` and `openMigrationExport` are now async.

### Security

- OAuth callback URL is no longer logged to stdout (previously included the
  authorization code and any error parameters returned by the IdP).
- Structured logging in `src/core/oauth-manager.ts`,
  `src/core/gcp-connection.ts`, and `src/core/gcp/gcp-oauth-provider.ts`
  now flows through `src/logger.ts` so the sanitizer redacts known sensitive
  keys (`token`, `secret`, `apiKey`, `passphrase`, `privateKey`, …).
- A pretest lint (`npm run lint:no-raw-console`) blocks raw `console.*` calls
  in OAuth and credential code paths.
- `POST /api/auth/dev-session` is disabled in production CLI builds. It is
  available only when `NODE_ENV !== 'production'` and
  `STUDIO_SERVE_UI_FROM_SOURCE=1`.

### Added

- `LICENSE` (MIT).
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `CHANGELOG.md`.
- GitHub Issue and Pull Request templates under `.github/`.
- CI workflow (`.github/workflows/ci.yml`) that runs typecheck, tests, and
  build on every pull request and push to `main` (Ubuntu + macOS, Node 20).
- `package.json` metadata for OSS publishing (license, repository, bugs,
  homepage, keywords, engines, files allowlist).
- `prepack` script that errors with a friendly message — Studio Pro is
  distributed via GitHub Releases binaries, not npm.

## [1.0.0] - TBD

Initial public release. Mobile-flow functionality (Firebase, Apple Signing,
EAS, GitHub, Google Play, Cloudflare, OAuth provider, LLM providers) is
production-ready.

[Unreleased]: https://github.com/sidthekid134/structure/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/sidthekid134/structure/releases/tag/v1.0.0
