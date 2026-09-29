---
title: Nextcloud — Notifications
---

# Nextcloud — Notifications

Read and dismiss native NC notifications, and (with the right scope) send new ones.

| | |
|---|---|
| Integration ID | `nextcloud-notifications` |
| Auth | NC session |
| Required NC app | `notifications` (built-in) |
| Required scope | `NOTIFICATIONS` |
| Source | `server/integrations/nextcloudNotificationsTools.js` |

## Tools

| Tool | Purpose |
|------|---------|
| `nextcloud_notifications_list` | List unread notifications. |
| `nextcloud_notifications_get` | Read one. |
| `nextcloud_notifications_dismiss` | Mark as read / dismiss. |
| `nextcloud_notifications_dismiss_all` | Clear all. |
| `nextcloud_notifications_send` | Send a notification (apps that own the namespace only). |

## Endpoints

```
GET    /ocs/v2.php/apps/notifications/api/v2/notifications
GET    /ocs/v2.php/apps/notifications/api/v2/notifications/{id}
DELETE /ocs/v2.php/apps/notifications/api/v2/notifications/{id}
DELETE /ocs/v2.php/apps/notifications/api/v2/notifications
POST   /ocs/v2.php/apps/notifications/api/v2/admin_notifications/{user}
```

## Use cases

- "What notifications do I have? Dismiss the ones from `files_versions`."
- (Automation) "When KB ingestion finishes, push a notification to the user who started it."
- "Send a Bee Flow notification to all users in `engineering` group when an automation fails."

## Permissions

Sending notifications via `nextcloud_notifications_send` requires admin in NC (it uses the `admin_notifications` endpoint). Only org admins running automations should configure this.
