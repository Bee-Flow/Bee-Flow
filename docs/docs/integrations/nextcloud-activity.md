---
title: Nextcloud — Activity
---

# Nextcloud — Activity

The [Activity](https://apps.nextcloud.com/apps/activity) app surfaces a unified feed of file changes, shares, comments, mentions. Bee Flow reads it (read-only) so the assistant can answer "what changed yesterday?" type questions.

| | |
|---|---|
| Integration ID | `nextcloud-activity` |
| Auth | NC session |
| Required NC app | `activity` (built-in for NC 28+) |
| Source | `server/integrations/nextcloudActivityTools.js` |

## Tools

| Tool | Purpose |
|------|---------|
| `nextcloud_activity_list` | List recent activity entries. |
| `nextcloud_activity_search` | Filter by date range / type / user. |
| `nextcloud_activity_get` | Fetch a single entry. |

## Activity types

Common types seen in the feed:

| Type | Triggered by |
|------|--------------|
| `file_created` | New file uploaded |
| `file_changed` | File modified |
| `file_deleted` | Soft-delete |
| `file_restored` | Restored from trash |
| `shared_with_you` | Someone shared a file/folder with you |
| `shared_link_by_you` | You created a public share |
| `commented` | New comment on a file |
| `mentioned` | You were `@`-mentioned |
| `tag_assigned` | Tag added to a file |

## Endpoint

```
GET /ocs/v2.php/apps/activity/api/v2/activity?since=...&limit=...
```

## Use cases

- "What did Alice change in the Marketing folder this week?"
- "Show me everything I was @-mentioned in yesterday."
- (Automation) Daily digest of activity in a watched folder, posted to Talk.

## Read-only

This integration is intentionally read-only. The Activity app doesn't expose write endpoints, and Bee Flow does not synthesise events.
