# License

This repository contains multiple components, each governed by its own license. The canonical license for the Bee Flow application — the server (`server/`) and the frontend (`agent-hub/`) — is the **Sustainable Use License v1.0**.

The full text of that license is in [server/LICENSE.md](server/LICENSE.md) (identical copy at [agent-hub/LICENSE.md](agent-hub/LICENSE.md)).

## Component licensing overview

| Path | License | Why |
|---|---|---|
| [server/](server/) | Sustainable Use License v1.0 | Canonical Bee Flow application license. |
| [agent-hub/](agent-hub/) | Sustainable Use License v1.0 | Frontend SPA, distributed alongside the server. |
| [desktop/](desktop/) | Sustainable Use License v1.0 | Desktop client (Linux, macOS, Windows); a shell around the frontend SPA. |
| [mobile/](mobile/) | Sustainable Use License v1.0 | Android client, distributed as an APK. |
| [nextcloud-connector/](nextcloud-connector/) | AGPL-3.0-or-later | Required by the Nextcloud App Store for ExApps. The connector is a separate program that communicates with `server/` over HTTP/JWT only — see [NOTICE.md](NOTICE.md) for the AGPL-isolation argument. |
| [components/](components/) | Sustainable Use License v1.0 | n8n-compatible component nodes shipped by Bee Flow. |
| [guard-service/](guard-service/), [classify-service/](classify-service/) | Sustainable Use License v1.0 | Optional Python sidecar services. |

## Plain English summary of the Sustainable Use License

You can use Bee Flow yourself or inside your own organisation as much as you want, including modifying the source. You can fork it. You can run it on your own servers.

What you cannot do — without a separate commercial agreement with Bee Flow — is offer Bee Flow itself as a paid hosted service to third parties.

Some features (for example Webpages, Meeting Notes, Notebooks, App Studio, Projects, SSO beyond Nextcloud, the Compliance Hub, tokenising in the Privacy Shield, White-label and License issuance) require a valid Bee Flow license key with the Enterprise or Full tier. The community tier (unlimited users, chat with agents, knowledge bases, Skills, the Automation builder and every built-in integration) is fully functional without any license key. The exact list is `server/license/tiers.js`.

For the full legal text, exact definitions, and clauses on Patents, Termination, and No Liability, see [server/LICENSE.md](server/LICENSE.md).

## Need a different license?

Hosting Bee Flow as a paid service for third parties, or another commercial arrangement, requires a separate agreement. Contact: **tomkooy@beeflow.nl**.

## Third-party components

Distributed Bee Flow images and packages depend on open-source libraries and self-hosted ML models, each under their own license. See [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md) for the full attribution list, and [NOTICE.md](NOTICE.md) for required notices.
