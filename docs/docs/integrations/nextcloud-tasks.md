---
title: Nextcloud — Tasks
---

# Nextcloud — Tasks

[Nextcloud Tasks](https://apps.nextcloud.com/apps/tasks) — VTODO-based to-do lists synced via CalDAV.

| | |
|---|---|
| Integration ID | `nextcloud-tasks` |
| Auth | NC session |
| Required NC app | `tasks` |
| Source | `server/integrations/nextcloudTasksTools.js` |

## Tools

| Tool | Purpose |
|------|---------|
| `nextcloud_tasks_list_calendars` | List task calendars (CalDAV containers). |
| `nextcloud_tasks_list` | List todos in a calendar. |
| `nextcloud_tasks_search` | Search by title / completion / due date. |
| `nextcloud_tasks_create` | Create a todo. |
| `nextcloud_tasks_update` | Edit title / due / priority / notes. |
| `nextcloud_tasks_complete` | Mark complete. |
| `nextcloud_tasks_delete` | Delete. |

## Endpoints (CalDAV / VTODO)

```
PROPFIND /remote.php/dav/calendars/{uid}/
REPORT   /remote.php/dav/calendars/{uid}/{cal}/   (with VTODO filter)
GET      /remote.php/dav/calendars/{uid}/{cal}/{todo}.ics
PUT      /remote.php/dav/calendars/{uid}/{cal}/{todo}.ics
```

VTODO fields used: `SUMMARY`, `DESCRIPTION`, `DUE`, `PRIORITY`, `STATUS`, `PERCENT-COMPLETE`, `CATEGORIES`, `RELATED-TO` (subtasks).

## Use cases

- "Add a task `Pay invoice` due Friday with priority 5."
- "List my open tasks tagged `urgent`."
- (Automation) On a Deck card with `due_date` set, mirror it as a Tasks todo.

## Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| `No task calendars` | User hasn't created a task list | Create one in the Tasks app first. |
| `Cannot delete completed task` (some setups) | NC config | Toggle `Show completed tasks` in the app. |
