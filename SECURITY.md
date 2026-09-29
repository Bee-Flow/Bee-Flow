# Security Policy

## Reporting a vulnerability

Please report security issues privately to **tomkooy@beeflow.nl**. Do not
open a public GitHub issue.

We aim to acknowledge reports within 2 business days, share a remediation
plan within 7 days, and ship a fix within 30 days for high-severity issues.
For **critical** issues — actively exploited, or remotely exploitable without
authentication — we aim for a mitigation or workaround within 2 business days
and a fix within 14 days.

## Scope

This monorepo contains the full Bee Flow AI platform. In-scope concerns
include, per component:

- **`server/`** (Node.js API) — authentication/session handling, access
  control between organizations and users, the zero-knowledge envelope
  encryption (AES-256-GCM, Argon2id, OPAQUE), license verification, SSRF in
  integrations, injection via chat/RAG inputs
- **`agent-hub/`** (React SPA) — XSS / DOM-based vulnerabilities, auth-token
  and session-cookie handling, leakage of secrets through client-side code,
  open redirects, clickjacking, CSRF on state-changing client code
- **`nextcloud-connector/`** — the ExApp reverse proxy and its signed-fetch
  authentication against Nextcloud
- **`guard-service/`, `pii-service/`, `search-service/`, `whisperx-service/`,
  `reranker/`** (Python sidecars) — input handling of untrusted documents,
  audio and web content
- **`server/license/`**: licence-key (JWT) verification. The issuing license
  server is private and not in this repository
- Supply-chain risks (compromised npm/PyPI dependencies) in any component

## Out of scope

- Misconfigurations of self-hosted instances by their operators
- Issues in third-party services Bee Flow integrates with (Nextcloud, OAuth
  providers, model APIs) — please report to the respective vendors
- Theoretical vulnerabilities without a concrete exploitation path
- Findings on demo / staging instances that don't reproduce against the
  released code in `main`

## Disclosure

We follow a **coordinated disclosure** model: once a fix is shipped and
deployed to our managed instances, we publish a security advisory on the
[GitHub Security Advisories](https://github.com/Bee-Flow/Bee-Flow/security/advisories)
page crediting the reporter (unless they ask for anonymity).

## Bounty

We don't currently run a paid bounty program. We do acknowledge reporters
publicly (with permission) and are happy to send Bee Flow swag for
valuable findings.

## Versions covered

Only the latest minor release on the `main` branch is supported. Older
versions may receive backported fixes for critical issues at our discretion.

## Encryption

If you'd like to encrypt your report, please request our PGP key by mail to
**tomkooy@beeflow.nl** — we'll respond with the public key.
