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

- "Find all open issues mentioning `regression` in `Bee-Flow/beeflow`."
- "Summarise the last 5 PRs merged to `main`."
- "Open an issue titled 'Docs: clarify license refresh' with a description from this conversation."
- (Automation) On a Talk message containing `bug:`, open a GitHub issue.

## Rate limits

GitHub's standard 5000 requests/hour applies to the whole org's traffic through the OAuth app. For high-volume automations, use a GitHub App instead of OAuth — the limits are per-installation.

## Privacy

Code snippets pulled by `github_get_file` and search results flow through the Privacy Shield. Custom regex categories (e.g. project codenames, secrets that lint-tools missed) are particularly useful here.

## Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| `403 Resource not accessible by integration` | Token / OAuth scope missing `repo` | Reconnect with `repo` scope. |
| `404 Not Found` on private repo | User isn't a collaborator | Org owner adds them. |
| `422 Validation Failed` on issue create | Required field missing | Provide `title` (mandatory). |
