# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Studio Pro, **please do not open a
public GitHub issue**.

Instead, report it privately via one of the following:

1. **GitHub Security Advisory** (preferred):
   <https://github.com/sidthekid134/structure/security/advisories/new>
2. **Email:** siddhu.moparthi@gmail.com with the subject line
   `[studio-pro security]`.

Please include:

- A description of the vulnerability and its potential impact.
- Steps to reproduce, or a proof-of-concept.
- The version (or commit) of Studio Pro you are running.
- Your platform (macOS / Linux, Node version if relevant).

You should receive an acknowledgement within **72 hours**. We aim to provide
an initial assessment within **7 days** and a fix or mitigation within
**30 days** for high-severity issues.

## In Scope

The following are considered valid security reports:

- Vault leakage: any path that exposes the encrypted vault contents in
  plaintext outside the user's machine, or to other local users.
- OAuth token leakage: any path that exposes refresh tokens, access tokens, or
  authorization codes via logs, error messages, network traffic, or files.
- Cryptographic weaknesses: incorrect use of AES-GCM nonces, weak KDF
  parameters, missing authentication, downgrade attacks against the export
  envelope format.
- Authentication bypass: unauthorized access to the Studio HTTP API,
  passkey-bypass, session-cookie hijacking that does not require local root.
- Remote code execution via untrusted input (HTTP request body, project
  bundle import, plugin metadata).
- Local privilege escalation via files written with overly permissive modes.

## Out of Scope

- Local denial-of-service via resource exhaustion. Studio Pro is a
  loopback-only daemon — a local user with `kill(2)` rights can already stop
  the process.
- Issues that require local root or physical access to the user's machine.
  A local root user can already read process memory and unsealed vault data.
- Issues in dependencies that have been patched upstream and are tracked in
  our `npm audit` workflow. Please file these as regular issues, not security
  reports.
- Vulnerabilities in third-party services (Google Cloud, Apple, Expo, GitHub).
  Report those to the respective vendor.

## Disclosure

We follow a coordinated disclosure model. After a fix is shipped, we will
publish a GitHub Security Advisory crediting the reporter (unless they
prefer to remain anonymous) and a CVE if applicable.

## Security Posture

For an overview of how Studio Pro stores credentials, derives keys, and
handles OAuth flows, see [docs/security.md](./docs/security.md).
