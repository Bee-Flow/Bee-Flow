---
title: REST reference
---

# REST reference

The most-used endpoints, grouped by area. Auth column abbreviations: **P** = public · **U** = user JWT · **A** = admin JWT · **S** = signed (HMAC / AppAPI).

## Health

| Method | Path | Auth | Purpose |
|--------|------|:----:|---------|
| GET | `/api/health` | P | `{status, version, tier}` |
| GET | `/api/guard/health` | P | Guard sidecar health probe |

A global Prometheus `/metrics` endpoint is on the roadmap but not currently exposed — see [Reference → Telemetry](../reference/telemetry.md).

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
| POST | `/api/session-token` | U | Issue popup→iframe session token |
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

## Users & API keys

| Method | Path | Auth | Purpose |
|--------|------|:----:|---------|
| GET | `/api/users` | A | List org users |
| POST | `/api/users` | A | Invite user |
| PATCH | `/api/users/:id` | A | Update user |
| DELETE | `/api/users/:id` | A | Delete user (soft) |
| GET | `/api/api-keys` | U | List my keys |
| POST | `/api/api-keys` | U | Create new key (returned once) |
| DELETE | `/api/api-keys/:id` | U | Revoke key |

## Organisations

| Method | Path | Auth | Purpose |
|--------|------|:----:|---------|
| GET | `/api/organisation` | U | Current org settings |
| PATCH | `/api/organisation` | A | Update org settings |
| GET | `/api/organisation/groups` | U | List groups |
| POST | `/api/organisation/groups` | A | Create group |
| PATCH | `/api/organisation/groups/:id` | A | Update group |
| DELETE | `/api/organisation/groups/:id` | A | Delete group |
| POST | `/api/organisation/groups/:id/members` | A | Add member |
| DELETE | `/api/organisation/groups/:id/members/:userId` | A | Remove member |

## Agents

Agents are mounted at `/agents` (not `/api/agents`).

| Method | Path | Auth | Purpose |
|--------|------|:----:|---------|
| GET | `/agents` | U | List visible agents |
| POST | `/agents` | U | Create agent |
| GET | `/agents/:id` | U | Read agent |
| PATCH | `/agents/:id` | U | Update agent |
| DELETE | `/agents/:id` | U | Delete agent |
| POST | `/agents/:id/publish` | U | Publish to Marketplace |
| POST | `/agents/:id/duplicate` | U | Fork an existing agent |
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

The chat router is mounted at `/ai`. Streaming uses SSE — see [Streaming](sse.md) for the event protocol.

| Method | Path | Auth | Purpose |
|--------|------|:----:|---------|
| POST | `/ai/chat` | U | Agent chat — stream a turn (SSE) |
| POST | `/ai/chat/direct/stream` | U | Direct (no-agent) chat — stream a turn (SSE) |
| GET | `/ai/direct/conversations` | U | List direct-mode conversations |
| GET | `/ai/direct/conversations/:id` | U | Read direct conversation |
| PATCH | `/ai/direct/conversations/:id` | U | Update direct conversation |
| POST | `/api/chat/dlp-decision` | U | Resolve a Privacy Shield interactive decision (`{decisionId, choice}`) — `choice` is `redact`/`block`/`allow`. |

## Knowledge bases

Standalone knowledge bases (org-wide, used by agents and direct chat) live under `/api/kb`. Agent-scoped knowledge (older API) lives under `/agents/:id/knowledge`.

| Method | Path | Auth | Purpose |
|--------|------|:----:|---------|
| GET | `/api/kb` | U | List KBs |
| POST | `/api/kb` | U | Create KB |
| GET | `/api/kb/:id` | U | Read KB |
| PATCH | `/api/kb/:id` | U | Update settings |
| DELETE | `/api/kb/:id` | U | Delete KB |
| GET | `/api/kb/published` | U | List published / shared KBs |
| GET | `/api/kb/categories` | U | List categories |
| POST | `/api/kb/categories` | A | Create category (requires `manage_knowledge`) |
| GET | `/api/kb/:id/documents` | U | List documents |
| POST | `/api/kb/:id/ingest/file` | U | Upload a document (multipart) |
| POST | `/api/kb/:id/ingest/text` | U | Ingest plain text |
| POST | `/api/kb/:id/ingest/url` | U | Ingest from URL |
| POST | `/api/kb/:id/ingest/sitemap` | U | Bulk ingest from sitemap |
| DELETE | `/api/kb/:id/documents/:docId` | U | Remove document |
| GET | `/api/kb/favorites` | U | List my favourite KBs |
| PUT | `/api/kb/:id/favorite` | U | Mark KB as favourite |
| DELETE | `/api/kb/:id/favorite` | U | Unmark KB |

Legacy agent-scoped knowledge endpoints (kept for backwards compat):

| Method | Path | Auth | Purpose |
|--------|------|:----:|---------|
| GET | `/agents/:id/knowledge` | U | List agent-attached knowledge items |
| POST | `/agents/:id/knowledge` | U | Attach text/URL knowledge to an agent |
| POST | `/agents/:id/knowledge/upload` | U | Upload a file (multipart) |
| POST | `/agents/:id/knowledge/url` | U | Attach by URL |
| POST | `/agents/:id/knowledge/search` | U | Search this agent's knowledge |
| DELETE | `/agents/:id/knowledge/:itemId` | U | Remove a knowledge item |

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

## Webpages (Community; sharing is Enterprise)

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
| POST | `/api/meet-bot/join` | U | Send the meeting bot to a URL |
| POST | `/api/meet-bot/:id/leave` | U | Recall the bot |

## Skills

Enterprise feature (since the 2026-10 enterprise split), and the whole mount also sits behind the **Skills beta** opt-in
(`requireCapability('skills')`), so an org that has not enabled the beta gets no route at
all. Every write additionally needs the `manage_skills` permission. There is no
marketplace: skills are written, not browsed or installed.

| Method | Path | Auth | Purpose |
|--------|------|:----:|---------|
| GET | `/api/skills` | U | List skills, with `canEdit` and the last test verdict |
| GET | `/api/skills/usage-summary` | U | Agents / automations / last-used per skill |
| POST | `/api/skills` | U | Create a skill |
| GET | `/api/skills/:id` | U | One skill |
| PUT | `/api/skills/:id` | U | Update a skill |
| DELETE | `/api/skills/:id` | U | Delete a skill (409 while it is still in use) |
| GET | `/api/skills/:id/usage` | U | Which agents and routine steps name it |
| POST | `/api/skills/:id/test` | U | Run one graded turn against the skill |
| GET | `/api/skills/:id/test-runs` | U | Past test verdicts |
| POST | `/api/skills/ai/draft` | U | Let the AI draft a skill |
| POST | `/api/skills/:id/ai/improve` | U | Let the AI fill in an empty skill |

## Integrations

| Method | Path | Auth | Purpose |
|--------|------|:----:|---------|
| GET | `/api/integrations` | U | List my connected integrations |
| POST | `/api/integrations/:id/connect` | U | Start OAuth/key flow |
| DELETE | `/api/integrations/:id` | U | Disconnect |
| GET | `/admin/:orgId/nc-integrations` | A | Org-level NC integration toggles |
| PUT | `/admin/:orgId/nc-integrations` | A | Update org-level toggles |
| GET | `/admin/:orgId/nc-integrations/groups` | A | Per-group disable lists |
| PUT | `/admin/:orgId/nc-integrations/groups/:groupId` | A | Update per-group disables |

## License

| Method | Path | Auth | Purpose |
|--------|------|:----:|---------|
| GET | `/api/license/status` | U | Active tier + features + limits |
| POST | `/api/license/apply` | A | Apply a JWT licence key |
| DELETE | `/api/license` | A | Revert to Community |

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

## Webhooks

| Method | Path | Auth | Purpose |
|--------|------|:----:|---------|
| POST | `/webhook/audit-events` | S | Receive SIEM-bound audit events (self) |
| POST | `/webhook/license-revocation` | S | Receive licence revocation push |

## Notes

- Errors are JSON ([format](index.md#error-format)).
- Streaming endpoints (`/ai/chat`, `/ai/chat/direct/stream`, `/api/voice/turn`) speak SSE — see [Streaming](sse.md).
