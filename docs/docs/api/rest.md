---
title: REST reference
---

# REST reference

A hand-written tour of the most-used endpoints, grouped by area. For **every** route the server
mounts (about 1,800), with the permission, licence feature and capability each one needs and the
fields its request accepts, see the generated [endpoint reference](reference.md); it is read from
the code on every change, so where the two differ, the generated one is right. The same data as an
OpenAPI 3.1 document: [openapi.json](pathname:///openapi.json).

Auth column abbreviations:

- **P**: public. The route has no gate in front of it. Login, health and similar routes.
- **U**: a signed-in user. A browser sends its session cookie (`connect.sid`); a script or the
  Nextcloud connector sends a signed bearer JWT with `X-Beeflow-Source: nextcloud-connector`.
  The login itself hands out no token. See [Authentication](auth.md).
- **A**: a signed-in user who is also an admin: a platform admin, an admin of the organisation
  in the path, or the named permission (for example `admin_compliance`). The exact gate is in the
  endpoint reference.
- **S**: authenticated by a signature or a secret instead of a user: an HMAC over the body, or a
  token in the path.

## Health

| Method | Path | Auth | Purpose |
|--------|------|:----:|---------|
| GET | `/api/health` | P | `{status, version, tier}` |
| GET | `/api/guard/health` | P | Guard sidecar health probe |

There is no public `/metrics` endpoint. Admins can read the in-memory counters at `GET /api/admin/metrics` (JSON, or Prometheus text with `?format=prometheus`) — see [Reference → Telemetry](../reference/telemetry.md).

## Auth & sessions

| Method | Path | Auth | Purpose |
|--------|------|:----:|---------|
| GET | `/auth/setup-status` | P | Is the org bootstrapped? OAuth providers configured? Available locales |
| POST | `/auth/setup` | P | First-time admin password setup (one-shot) |
| POST | `/auth/admin-login` | P | Username/password login |
| POST | `/auth/signup` | P | User registration (if enabled) |
| GET | `/auth/invite/:token` | P | Resolve invite token |
| POST | `/auth/logout` | U | End session |
| GET | `/auth/user` | U | Current user record |
| GET | `/auth/my-permissions` | U | Permissions, groups, orgs, beta features |
| POST | `/auth/update-profile` | U | Update profile (name, avatar, language) |
| GET | `/api/session-token` | U | Mint a bridge token for a popup→iframe handoff or a native client; send it back as the `X-Session-Token` header. The response is `{token, expiresIn}` |
| GET | `/auth/admin/signup-settings` | A | Read signup config |
| PUT | `/auth/admin/signup-settings` | A | Write signup config |
| GET | `/auth/admin/waitlist` | A | List pending signups |
| POST | `/auth/admin/waitlist/:userId/approve` | A | Approve waitlist entry |
| POST | `/auth/admin/waitlist/:userId/reject` | A | Reject waitlist entry |
| POST | `/auth/pending-signup` | P | Add to waitlist |
| GET | `/auth/organizations/public` | P | Public organisations (for embedded chat) |

## OAuth & SSO

| Method | Path | Auth | Purpose |
|--------|------|:----:|---------|
| GET | `/auth/login/:provider` | P | Start OAuth / OIDC — `google`, `microsoft`, `nextcloud` |
| GET | `/auth/callback/:provider` | P | OAuth / OIDC callback; register this as the redirect URI |
| GET | `/auth/login` | P | Nextcloud OAuth, legacy path kept for clients registered before `/login/:provider` existed |
| GET | `/auth/callback` | P | Nextcloud OAuth callback, same legacy pair |
| GET | `/auth/login-pickup` | P | OAuth callback redirect handler (embedded-iframe popup handoff) |

## Connector handshake

| Method | Path | Auth | Purpose |
|--------|------|:----:|---------|
| POST | `/auth/connector/bootstrap` | S | NC connector → SaaS first-time tenant provisioning |
| POST | `/auth/webhook/nc-user-sync` | S | NC events forwarded by the connector |

There is no handshake endpoint and no consent endpoint under `/auth`. The
connector signs its own JWT and presents it on every request — see
[Authentication → Nextcloud session](auth.md#nextcloud-session).

## Users, organisations and groups

User, organisation and group management lives under `/auth`, not `/api`. There are no API keys:
see [Authentication](auth.md#scripted--server-to-server-access) for how a script signs in.

| Method | Path | Auth | Purpose |
|--------|------|:----:|---------|
| GET | `/auth/users` | U | List users: an org admin sees their organisation, everyone else only themselves |
| POST | `/auth/users` | A | Create a user in an organisation you administer |
| PUT | `/auth/users/:id` | A | Update a user |
| DELETE | `/auth/users/:id` | A | Delete a user |
| POST | `/auth/users/me/leave-org` | U | Leave your organisation |
| GET | `/auth/organizations` | U | List the organisations you can see |
| POST | `/auth/organizations` | A | Create an organisation (platform admin) |
| GET | `/auth/organizations/:id` | U | Read an organisation |
| PUT | `/auth/organizations/:id` | A | Update an organisation |
| DELETE | `/auth/organizations/:id` | A | Delete an organisation (platform admin) |
| GET | `/auth/groups` | U | List groups |
| POST | `/auth/groups` | A | Create a group |
| PUT | `/auth/groups/:id` | A | Update a group |
| DELETE | `/auth/groups/:id` | A | Delete a group |
| POST | `/auth/groups/:id/members` | A | Add members |
| DELETE | `/auth/groups/:id/members/:userId` | A | Remove a member |

## Agents

Agents are mounted at `/agents` (not `/api/agents`).

| Method | Path | Auth | Purpose |
|--------|------|:----:|---------|
| GET | `/agents` | U | List visible agents |
| POST | `/agents` | U | Create agent |
| GET | `/agents/:id` | U | Read agent |
| PUT | `/agents/:id` | U | Update agent |
| DELETE | `/agents/:id` | U | Delete agent |
| PATCH | `/agents/:id/publish` | U | Switch publishing on or off and set who can see the agent |
| POST | `/agents/:id/publish-version` | U | Publish the current concept as a new version |
| GET | `/agents/:id/tools` | U | Resolved tool list for this agent + user |

## Conversations & messages

Conversations are agent-scoped. There is no standalone `/api/conversations` collection.

| Method | Path | Auth | Purpose |
|--------|------|:----:|---------|
| GET | `/agents/:id/conversations` | U | List conversations for this agent |
| POST | `/agents/:id/conversations` | U | Start a new conversation |
| GET | `/agents/:id/conversations/:convId` | U | Read |
| PATCH | `/agents/:id/conversations/:convId` | U | Update metadata (title, archive, etc.) |
| DELETE | `/agents/:id/conversations/:convId` | U | Soft delete |
| GET | `/agents/:id/conversations/:convId/workspace` | U | Conversation workspace (artefacts) |

Direct (no-agent) chat conversations live under `/ai/direct/conversations` instead — see below.

## Chat (streaming)

Agent chat sits under the agent (`/agents/:id/chat…`); direct chat and the other chat surfaces are mounted at `/ai`. Streaming uses SSE — see [Streaming](sse.md) for the event protocol.

| Method | Path | Auth | Purpose |
|--------|------|:----:|---------|
| POST | `/agents/:id/chat/stream` | U | Agent chat — stream a turn (SSE). An agent with embedding switched on also answers without a session |
| POST | `/agents/:id/chat` | U | Agent chat — one turn, answered as plain JSON |
| POST | `/ai/chat/direct/stream` | U | Direct (no-agent) chat — stream a turn (SSE) |
| GET | `/ai/direct/conversations` | U | List direct-mode conversations |
| GET | `/ai/direct/conversations/:id` | U | Read direct conversation |
| PATCH | `/ai/direct/conversations/:id` | U | Update direct conversation |
| POST | `/api/chat/dlp-decision` | U | Resolve a Privacy Shield interactive decision (`{decisionId, choice}`) — `choice` is `redact`/`block`/`allow`. |

## Knowledge bases

Knowledge bases (org-wide, used by agents and direct chat) live under `/api/kb`. There is no agent-scoped knowledge API any more: an agent uses the knowledge bases attached to it.

| Method | Path | Auth | Purpose |
|--------|------|:----:|---------|
| GET | `/api/kb` | U | List KBs |
| POST | `/api/kb` | U | Create KB |
| GET | `/api/kb/:id` | U | Read KB |
| PATCH | `/api/kb/:id` | U | Update settings |
| DELETE | `/api/kb/:id` | U | Delete KB |
| GET | `/api/kb/published` | U | List published / shared KBs |
| GET | `/api/kb/categories` | U | List categories |
| POST | `/api/kb/categories` | U | Create category (requires the `manage_knowledge` permission) |
| GET | `/api/kb/:id/documents` | U | List documents |
| POST | `/api/kb/:id/ingest/file` | U | Upload a document (multipart) |
| POST | `/api/kb/:id/ingest/text` | U | Ingest plain text |
| POST | `/api/kb/:id/ingest/url` | U | Ingest from URL |
| POST | `/api/kb/:id/ingest/sitemap` | U | Bulk ingest from sitemap |
| DELETE | `/api/kb/:id/documents/:docId` | U | Remove document |
| GET | `/api/kb/favorites` | U | List my favourite KBs |
| PUT | `/api/kb/:id/favorite` | U | Mark KB as favourite |
| DELETE | `/api/kb/:id/favorite` | U | Unmark KB |

## Automations

Community feature — building automations is in the free core. Sharing them across a team
(`automation_sharing`) is Enterprise.

| Method | Path | Auth | Purpose |
|--------|------|:----:|---------|
| GET | `/api/automation` | U | List automations |
| POST | `/api/automation` | U | Create |
| GET | `/api/automation/:id` | U | Read |
| PUT | `/api/automation/:id` | U | Update |
| DELETE | `/api/automation/:id` | U | Delete |
| POST | `/api/automation/:id/activate` | U | Switch on |
| POST | `/api/automation/:id/deactivate` | U | Switch off |
| POST | `/api/automation/:id/run` | U | Run now (waits up to 60 s for the result) |
| POST | `/api/automation/:id/dry-run` | U | Test run, side effects synthesised |
| GET | `/api/automation/:id/runs` | U | List runs |
| GET | `/api/automation/runs/:id` | U | Run detail |
| GET | `/api/automation/runs/:id/steps` | U | The steps of a run, with their inputs and outputs |
| POST | `/api/automation/runs/:runId/cancel` | U | Cancel a running run |
| POST | `/api/automation/:id/runs/:runId/retry` | U | Run again with the original trigger payload |
| POST | `/api/automation/:id/webhook` | U | Create a webhook URL and its secret (the secret is returned once) |
| GET | `/api/automation/:id/webhooks` | U | List webhook URLs (without secrets) |
| POST | `/api/automation/:id/webhook/:slug/rotate` | U | New secret, same URL |
| DELETE | `/api/automation/:id/webhook/:slug` | U | Delete a webhook URL |
| POST | `/api/automation/webhook/:slug` | S¹ | Webhook trigger entry |

¹ HMAC-SHA256 signature in `X-BeeFlow-Signature` plus a single-use `X-BeeFlow-Nonce`, no token. See [Automations → Webhook trigger format](../features/automations.md#webhook-trigger-format).

## Webpages (Enterprise)

| Method | Path | Auth | Purpose |
|--------|------|:----:|---------|
| GET | `/api/webpages` | U | List crawled pages |
| POST | `/api/webpages` | U | Add a URL to crawl |
| GET | `/api/webpages/:id` | U | Read |
| DELETE | `/api/webpages/:id` | U | Remove |

## Meeting notes and transcriptions (Enterprise)

| Method | Path | Auth | Purpose |
|--------|------|:----:|---------|
| GET | `/api/transcriptions` | U | List |
| POST | `/api/transcriptions` | U | Submit audio |
| GET | `/api/transcriptions/:id` | U | Read |
| GET | `/api/transcriptions/gmeet-meetings` | U | Upcoming Google Meet meetings with their record choice |
| POST | `/api/transcriptions/from-gmeet` | U | Import a finished Google Meet recording |
| GET | `/api/transcriptions/teams-meetings` | U | Upcoming Microsoft Teams meetings with their record choice |
| PATCH | `/api/transcriptions/teams-meetings/:eventId` | U | Record or skip one Teams meeting |
| GET | `/api/transcriptions/teams-recordings` | U | Recently ended Teams meetings you organised |
| POST | `/api/transcriptions/from-teams` | U | Import a finished Teams meeting |
| GET/PUT | `/api/teams-notes-settings/user/me` | U | Your Teams → Meeting Notes settings |
| GET/PUT | `/api/teams-notes-settings/:orgId` | U | Organisation Teams settings (PUT needs an org admin) |

## Skills

Community feature, generally available and on by default. The whole mount sits behind
`requireCapability('skills')`, so an org that switched Skills off (or whose cloud plan leaves
it out) gets no route at all. Every write additionally needs the `manage_skills` permission. There is no
marketplace: skills are written, not browsed or installed.

| Method | Path | Auth | Purpose |
|--------|------|:----:|---------|
| GET | `/api/skills` | U | List skills, with `canEdit` and the last test verdict |
| GET | `/api/skills/usage-summary` | U | Agents / automations / last-used per skill |
| POST | `/api/skills` | U | Create a skill |
| GET | `/api/skills/:id` | U | One skill |
| PUT | `/api/skills/:id` | U | Update a skill |
| DELETE | `/api/skills/:id` | U | Delete a skill (409 while it is still in use) |
| GET | `/api/skills/:id/usage` | U | Which agents and automation steps name it |
| POST | `/api/skills/:id/test` | U | Run one graded turn against the skill |
| GET | `/api/skills/:id/test-runs` | U | Past test verdicts |
| POST | `/api/skills/ai/draft` | U | Let the AI draft a skill |
| POST | `/api/skills/:id/ai/improve` | U | Let the AI fill in an empty skill |

## Integrations

| Method | Path | Auth | Purpose |
|--------|------|:----:|---------|
| GET | `/api/integrations/connections` | U | List my connections |
| POST | `/api/integrations/connections` | U | Add a connection |
| PATCH | `/api/integrations/connections/:id` | U | Update a connection |
| DELETE | `/api/integrations/connections/:id` | U | Remove a connection |
| GET | `/auth/admin/:orgId/nc-integrations` | A | Org-level NC integration toggles |
| PUT | `/auth/admin/:orgId/nc-integrations` | A | Update org-level toggles |
| GET | `/auth/admin/:orgId/nc-integrations/groups` | A | Per-group disable lists |
| PUT | `/auth/admin/:orgId/nc-integrations/groups/:groupId` | A | Update per-group disables |

Each provider has its own connect and disconnect routes under `/api/integrations/<provider>/` (Google, Microsoft, GitHub, Withings and others); they are in the [endpoint reference](reference/api-integrations.md).

## License

| Method | Path | Auth | Purpose |
|--------|------|:----:|---------|
| GET | `/api/license/status` | U | Active tier + features + limits |
| POST | `/api/license/activate` | A | Apply a JWT licence key |
| POST | `/api/license/refresh` | A | Fetch the licence again from the licence server |
| GET | `/api/license/health` | A | State of the licence refresher |
| DELETE | `/api/license/deactivate` | A | Revert to Community |

## Audit & compliance (Enterprise+)

Gated by the `compliance_hub_gdpr` license feature. The hub is a check-runner — admins schedule and inspect compliance checks (GDPR readiness, retention policy, etc.).

| Method | Path | Auth | Purpose |
|--------|------|:----:|---------|
| GET | `/api/compliance/overview` | A | Tier-aware compliance summary |
| GET | `/api/compliance/checks` | A | List all checks for this org |
| GET | `/api/compliance/checks/:id/history` | A | Past results for a single check |
| POST | `/api/compliance/checks/run` | A | Run every applicable check now |
| POST | `/api/compliance/checks/:id/run` | A | Run a single check now |
| GET | `/api/compliance/registry` | A | The static check definitions (catalog) |
| GET | `/api/compliance/settings` | A | Read compliance settings |
| PUT | `/api/compliance/settings` | A | Write compliance settings |
| POST | `/api/compliance/settings/onboarded` | A | Mark the compliance hub as onboarded |

## Incoming webhooks

Routes that other systems call. None of them uses a user session.

| Method | Path | Auth | Purpose |
|--------|------|:----:|---------|
| POST | `/api/automation/webhook/:slug` | S | Automation webhook trigger (see Automations above) |
| POST | `/api/stripe/webhook` | S | Stripe billing events (Bee Flow cloud only; verified with Stripe's signature) |
| POST | `/auth/webhook/nc-user-sync` | S | Nextcloud user events forwarded by the connector |

## Notes

- Errors are JSON ([format](index.md#error-format)).
- Streaming endpoints (`/agents/:id/chat/stream`, `/ai/chat/direct/stream`, `/ai/voice/turn`) speak SSE — see [Streaming](sse.md).
