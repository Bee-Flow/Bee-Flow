---
title: GitHub
---

# GitHub

Bee Flow connects to GitHub with a personal access token.

:::warning[There is no GitHub OAuth app flow]

This page used to describe an OAuth App, an authorisation callback URL at
`/auth/github/callback` and `OAUTH_GITHUB_CLIENT_ID` / `OAUTH_GITHUB_CLIENT_SECRET`
environment variables. **None of that exists**: no such route is served and
those variables are read nowhere in the product. Use a token.

:::

## Setup (personal access token)

Paste a fine-grained personal access token in **Settings → Account → Integrations → GitHub → Token**. The token is encrypted at rest.

Scopes: read access to the repositories you want, plus `read:org` when you use the ISO evidence connector (branch protection, Dependabot SLA, PR approvals, secret scanning, CI). For write operations, add repository write.

## Tools

| Tool | Purpose |
|------|---------|
| `github_list_repos` | List repos the user has access to. |
| `github_search_code` | Code search across visible repos. |
| `github_get_file` | Read a file by `owner/repo/path@ref`. |
| `github_list_issues` | List issues. |
| `github_get_issue` | Read one issue + comments. |
| `github_create_issue` | Open an issue. |
| `github_comment_issue` | Comment. |
| `github_list_pulls` | List PRs. |
| `github_get_pull` | Read a PR + reviews. |
| `github_create_pull` | Open a PR (requires `repo` scope). |
| `github_list_commits` | Commit history with optional path filter. |
| `github_get_commit` | One commit, diff included. |

## Use cases

- "Find all open issues mentioning `regression` in `Bee-Flow/Bee-Flow`."
- "Summarise the last 5 PRs merged to `main`."
- "Open an issue titled 'Docs: clarify license refresh' with a description from this conversation."
- (Automation) On a Talk message containing `bug:`, open a GitHub issue.

## GitHub events (webhook) {#webhook}

:::info[Not offered in the builder]

GitHub is hidden as an event source in the automation builder. The webhook
below serves automations that were saved with a GitHub event trigger before it
was withdrawn, and an administrator who operates one of those is who this
section is for.

:::

The server accepts GitHub webhook deliveries at
`POST /api/automation/events/github`: no sign-in, a JSON body of at most
256 kB, and the shared rate limit of the provider event routes
(`AUTOMATION_EVENTS_RPM_PER_IP`, see [Environment variables](../self-hosting/env.md#inbound-and-integration-limits)).
The event name is taken from the `X-GitHub-Event` header.

A delivery names no organisation. It only carries a signature
(`X-Hub-Signature-256`, an HMAC-SHA256 over the raw body), so **the secret that
signed it decides which organisation receives the event**:

| Config entry | Reaches |
|--------------|---------|
| `org_<orgId>_github_webhook_secret` | One organisation. A delivery signed with this secret starts only the automations of that organisation's members. `<orgId>` is the organisation's id. |
| `automation_github_webhook_secret` | The whole installation. It names no organisation, so it is honoured only while the installation has **at most one** organisation. With two or more, a delivery signed with it is refused: it would reach every organisation's automations, and whoever knows the secret could forge events for all of them. |

The organisations' own entries are tried first, then the installation-wide one.
Give every organisation its own secret, and its own webhook in GitHub, as soon
as the installation has more than one.

| Answer | Meaning |
|--------|---------|
| `202` | Accepted and handed to the automations that subscribe to the event. |
| `401` `Bad signature` | The signature matches no configured secret. |
| `409` `github_webhook_needs_org_secret` | Signed with the installation-wide secret on an installation with several organisations. The server log says so too. Set a secret per organisation. |
| `503` `github_webhooks_unconfigured` | No entry exists at all, or the request is unsigned and there is no installation-wide entry. |

### Setting it up

1. In GitHub, add a webhook to the repository or organisation: payload URL
   `https://<your-host>/api/automation/events/github`, content type
   `application/json`, and a long random **Secret**.
2. Store the same secret in Bee Flow. There is no screen for it: each entry is a
   row in the `config` table of the server's database (`beeflow_core`), with
   the entry's name as `key` and the secret as `value`. The server picks a new
   row up within a minute.

At start-up the server encrypts every plain `config` row whose name ends in
`secret`, these two included. The webhook route reads them decrypted, so a row
written by hand keeps working after a restart.

## Rate limits

GitHub's rate limit (5,000 requests an hour for a personal access token) counts per token, so per user who connected one.

## Privacy

Code snippets pulled by `github_get_file` and search results flow through the Privacy Shield. Custom regex categories (e.g. project codenames, secrets that lint-tools missed) are particularly useful here.

## Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| `403 Resource not accessible by integration` | Token / OAuth scope missing `repo` | Reconnect with `repo` scope. |
| `404 Not Found` on private repo | User isn't a collaborator | Org owner adds them. |
| `422 Validation Failed` on issue create | Required field missing | Provide `title` (mandatory). |
