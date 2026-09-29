---
title: Nextcloud — Notes
---

# Nextcloud — Notes

[Nextcloud Notes](https://apps.nextcloud.com/apps/notes) — plain-text / Markdown notes synced to a `Notes/` folder.

| | |
|---|---|
| Integration ID | `nextcloud-notes` |
| Auth | NC session |
| Required NC app | `notes` |
| Source | `server/integrations/nextcloudNotesTools.js` |

## Tools

| Tool | Purpose |
|------|---------|
| `nextcloud_notes_list` | List all notes. |
| `nextcloud_notes_search` | Search by title / content / tag. |
| `nextcloud_notes_get` | Read one note. |
| `nextcloud_notes_create` | Create a new note. |
| `nextcloud_notes_update` | Update title / content / tags / category. |
| `nextcloud_notes_append` | Append text to an existing note. |
| `nextcloud_notes_delete` | Delete. |

## Endpoints

```
GET    /index.php/apps/notes/api/v1/notes
GET    /index.php/apps/notes/api/v1/notes/{id}
POST   /index.php/apps/notes/api/v1/notes
PUT    /index.php/apps/notes/api/v1/notes/{id}
DELETE /index.php/apps/notes/api/v1/notes/{id}
```

## Use cases

- "Append today's standup summary to `Daily/2026-05-09`."
- "Create a note titled `Meeting prep` with the brief from the calendar event."
- "Find all notes tagged `book` and list them."

## Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Notes folder not configured` | NC user hasn't opened the Notes app yet | They open it once; default folder created. |
| `404 Not Found` | Note ID stale (sync conflict) | Re-search by title. |
