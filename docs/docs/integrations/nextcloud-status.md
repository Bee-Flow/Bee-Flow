---
title: Nextcloud — User Status
---

# Nextcloud — User Status

Get and set the user's availability and custom status message.

| | |
|---|---|
| Integration ID | `nextcloud-status` |
| Auth | NC session |
| Required NC app | `user_status` (built-in) |
| Source | `server/integrations/nextcloudStatusTools.js` |

## Tools

| Tool | Purpose |
|------|---------|
| `nextcloud_status_get` | Get the user's current status. |
| `nextcloud_status_set` | Set status type + custom message + emoji. |
| `nextcloud_status_clear` | Clear the custom message. |
| `nextcloud_status_set_predefined` | Set a predefined status (`vacationing`, `commuting`, etc.). |

## Status types

| Type | Visible as |
|------|------------|
| `online` | Green dot |
| `away` | Yellow dot |
| `dnd` | Red dot, suppresses notifications |
| `invisible` | Grey dot |
| `offline` | Grey, no presence |

## Endpoints

```
GET  /ocs/v2.php/apps/user_status/api/v1/user_status
PUT  /ocs/v2.php/apps/user_status/api/v1/user_status/status
PUT  /ocs/v2.php/apps/user_status/api/v1/user_status/message/custom
DELETE /ocs/v2.php/apps/user_status/api/v1/user_status/message
```

## Use cases

- "Set my status to DND with the message 'Heads down on Q3 reporting' for 2 hours."
- "Clear my status."
- (Automation) "When my calendar shows 'Lunch', set status to away with 🍝."

## Caveats

Auto-status (e.g. NC's built-in "in a meeting" detection) may overwrite manual statuses. Bee Flow doesn't fight this — set yours explicitly to override.
