# Contributing to Studio Pro

Thanks for your interest in contributing! This document covers the basics of
developing, testing, and submitting changes.

## Code of Conduct

Participation is governed by [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md). Be
respectful, constructive, and concise.

## Getting set up

```bash
git clone https://github.com/sidthekid134/structure.git
cd structure
npm install
npm run ui:install
npm run dev:full
```

That brings up the backend (loopback only, port `3737` by default) and the
Vite dev server with live reload. See [BUILDING.md](./BUILDING.md) for build
prerequisites and [docs/distribution.md](./docs/distribution.md) for how
release binaries are produced.

## Project layout (high level)

| Directory                        | Contents                                               |
| -------------------------------- | ------------------------------------------------------ |
| `src/`                           | Backend (Node, TypeScript)                             |
| `src/encryption.ts`, `src/vault.ts` | Crypto + on-disk vault                              |
| `src/core/`                      | OAuth managers, integration connections                |
| `src/plugins/`                   | Plugin system (Integration → Plugin → Module → Step)   |
| `src/provisioning/`              | Step registry, dependency graph types                  |
| `src/studio/`                    | HTTP server, REST API, auth, static UI bundle          |
| `studio-ui/`                     | React + Vite dashboard (separate npm workspace)        |
| `docs/`                          | User & contributor documentation                       |

## Workflow

1. **Fork & branch.** Use a topic branch (`feat/...`, `fix/...`, `docs/...`).
2. **Code.** Match the surrounding style; the codebase is TypeScript strict.
3. **Test.** `npm run typecheck && npm run test`. Add or update tests in
   `src/__tests__/`. UI changes: run through the live UI.
4. **Lint.** `npm run lint:no-raw-console` enforces structured logging in
   credential code paths.
5. **Commit.** Use clear, imperative commit messages
   (`fix(vault): reject legacy PBKDF2 vaults`).
6. **Open a PR.** Fill in the [pull request template](.github/PULL_REQUEST_TEMPLATE.md).

## What needs reviewer eyes

- Anything in `src/encryption.ts`, `src/vault.ts`, `src/core/oauth-manager.ts`,
  `src/studio/auth.ts`, `src/studio/auth-webauthn-router.ts`, or
  `src/studio/vault-session.ts` is security-sensitive.
- Logging in OAuth/credential code must go through `createOperationLogger`
  from `src/logger.ts` — never raw `console.*`. The pretest lint enforces
  this for the most sensitive files; treat the same rule as a soft norm
  elsewhere.
- New plugins should follow [docs/authoring-plugins.md](./docs/authoring-plugins.md)
  (forthcoming) and live under `src/plugins/builtin/`.

## Reporting bugs / requesting features

Use [GitHub Issues](https://github.com/sidthekid134/structure/issues) with
the appropriate template. For security issues, see
[SECURITY.md](./SECURITY.md) — please do not open a public issue.

## License

By contributing you agree your contributions are licensed under the
[MIT License](./LICENSE), the same license as the project.
