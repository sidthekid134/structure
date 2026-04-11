# Credential Vault

## Prerequisites

- Node.js (current LTS recommended)
- npm

## Install

From the repository root:

```bash
npm install
npm run ui:install
```

## Run in development (recommended)

```bash
npm run dev:full
```

This starts:

- backend TypeScript watch + Studio server
- UI build watch that outputs static assets for the backend to serve

Open: `http://127.0.0.1:3000`

## Other run modes

- Backend only (development): `npm run dev:backend`
- Build everything: `npm run build`
- Run built backend + UI: `npm run prod:backend`
- UI preview only: `npm run prod:ui`

## Quality checks

- Test: `npm test`
- Typecheck: `npm run typecheck`