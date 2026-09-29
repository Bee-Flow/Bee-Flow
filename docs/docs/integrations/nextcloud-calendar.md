---
title: Nextcloud — Calendar
---

# Nextcloud — Calendar

CalDAV-backed access to the user's calendars.

| | |
|---|---|
| Integration ID | `nextcloud-calendar` |
| Auth | NC session via connector |
| Required scope | `CALENDAR`, `DAV` |
| Source | `server/integrations/nextcloudCalendarTools.js` |

## Tools

| Tool | Purpose |
|------|---------|
| `nextcloud_calendar_list` | List the user's calendars. |
| `nextcloud_calendar_search` | Search events by date range / keyword. |
| `nextcloud_calendar_get_event` | Fetch one event by URI. |
| `nextcloud_calendar_create_event` | Create a new event. |
| `nextcloud_calendar_update_event` | Update title / time / attendees / body. |
| `nextcloud_calendar_delete_event` | Delete. |
| `nextcloud_calendar_list_attendees` | Who's invited and their RSVP status. |
| `nextcloud_calendar_respond` | Accept / decline / tentative on an invite. |

## Endpoints (CalDAV)

```
PROPFIND /remote.php/dav/calendars/{uid}/
REPORT   /remote.php/dav/calendars/{uid}/{calendar}/
GET      /remote.php/dav/calendars/{uid}/{calendar}/{event}.ics
PUT      /remote.php/dav/calendars/{uid}/{calendar}/{event}.ics
DELETE   /remote.php/dav/calendars/{uid}/{calendar}/{event}.ics
```

## Recurring events

Recurring events are returned as the master event plus a list of overrides (`RECURRENCE-ID`). Most tools accept either; the agent typically operates on the master.

## Time zones

Events are returned with their original `TZID`. The agent renders them in the user's preferred timezone (set in NC, mirrored from `auth/user`).

## Privacy

Event bodies (the description / notes field) flow through the Privacy Shield. Strict mode also redacts attendee names and addresses.

## Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| `403 Forbidden` on shared calendar | User lacks write permission | Owner shares with edit rights. |
| `409 Conflict` on update | Stale ETag (someone else edited concurrently) | Re-fetch and retry. |
| `Invalid TZID` | Bad timezone | Use IANA names (`Europe/Amsterdam`, not `CET`). |
