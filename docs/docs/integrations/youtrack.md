---
title: YouTrack
---

# YouTrack

JetBrains' issue tracker. Bee Flow can search, read, create issues, and add comments.

## Setup

1. Generate a permanent token in YouTrack: **Profile → Account Security → Tokens → New token**. Scope: `YouTrack`.
2. Set environment variables:
   ```bash
   YOUTRACK_BASE_URL=https://your-org.youtrack.cloud
   YOUTRACK_API_TOKEN=perm:...
   ```
3. Restart server.

## Tools

| Tool | Purpose |
|------|---------|
| `youtrack_list_projects` | List projects visible to the token. |
| `youtrack_search_issues` | Issue query (uses YouTrack's query language). |
| `youtrack_get_issue` | Read one issue (description, comments, history). |
| `youtrack_create_issue` | Create an issue. |
| `youtrack_update_issue` | Update fields. |
| `youtrack_add_comment` | Append a comment. |
| `youtrack_change_assignee` | Reassign. |
| `youtrack_link_issues` | Add a relation between two issues. |
| `youtrack_log_work` | Record time spent. |
| `youtrack_manage_tags` | Add / remove tags. |

(Tools mirror the JetBrains MCP server roughly 1:1.)

## Query syntax

YouTrack's query language is unchanged from the UI:

```
project: BEE state: Open priority: Critical assignee: me
```

Bee Flow forwards the query string as-is.

## Use cases

- "Find all `Critical` issues open in the BEE project, assigned to me."
- "Add a comment to issue BEE-123 summarising this conversation."
- (Automation) When a Talk message starts with `/bug`, open a YouTrack issue.

## Permissions

The token's permissions decide what each tool can do. A read-only token will silently fail on `create` / `update` calls — pick the right token scope when generating.

## Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| `401 Unauthorized` | Token expired or revoked | Re-issue. |
| `404 Project not found` | ID typo | Use the project shortname (e.g. `BEE`), not numeric ID. |
| `403 Forbidden on create` | Token lacks Create Issue permission | Re-issue with broader scope. |
