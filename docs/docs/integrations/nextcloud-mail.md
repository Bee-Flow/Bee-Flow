---
title: Nextcloud — Mail
---

# Nextcloud — Mail

Read, draft and send mail through the [Nextcloud Mail app](https://apps.nextcloud.com/apps/mail).

| | |
|---|---|
| Integration ID | `nextcloud-mail` |
| Auth | NC session (via connector) |
| Required NC app | `mail` |
| Required scope | `MAIL` |
| Source | `server/integrations/nextcloudMailTools.js` |

## Tools exposed

| Tool | Purpose |
|------|---------|
| `nextcloud_mail_list_accounts` | List the user's configured mail accounts. |
| `nextcloud_mail_list_mailboxes` | List folders for an account. |
| `nextcloud_mail_search` | Search messages: free text matches subject, sender or recipient; `from:`, `to:`, `subject:`, `body:`, `is:unread` and `flags:attachments` narrow it. Searches read the Mail cache and can run side by side. |
| `nextcloud_mail_read` | Fetch a message body. |
| `nextcloud_mail_read_attachment` | Read an attachment. |
| `nextcloud_mail_send` | Send a draft (or a freshly composed message). |
| `nextcloud_mail_set_flags` | Mark a message read/unread, flagged/unflagged, or junk. |
| `nextcloud_mail_save_attachment` | Save an email attachment directly to a folder in Nextcloud Files (no download/re-upload — handled server-side by the Mail app). |
| `nextcloud_mail_move` | Move to another folder. |

## Auth details

The user configures their mail accounts inside the Nextcloud Mail app first. Bee Flow's tools then use AppAPI's signed proxy to call the Mail REST API at `/index.php/apps/mail/api/...`.

The mail account passwords are stored by NC, encrypted at rest. Bee Flow never sees them; it relies on the NC session to act on behalf of the user.

## Endpoints called

```
GET  /index.php/apps/mail/api/accounts
GET  /index.php/apps/mail/api/accounts/{id}/folders
GET  /index.php/apps/mail/api/accounts/{id}/folders/{folder}/messages
GET  /index.php/apps/mail/api/accounts/{id}/folders/{folder}/messages/{id}
POST /index.php/apps/mail/api/accounts/{id}/draft
POST /index.php/apps/mail/api/accounts/{id}/send
PUT  /index.php/apps/mail/api/accounts/{id}/folders/{folder}/messages/{id}/flags
POST /index.php/apps/mail/api/accounts/{id}/folders/{folder}/messages/{id}/move
```

## Privacy Shield

Email bodies and attachments pulled via these tools go through the Privacy Shield before reaching the model. With Strict mode, recipient names and addresses are redacted; the assistant still works in placeholder-space and your screen un-redacts.

## Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| `No mail accounts configured` | User hasn't added any | They open Nextcloud Mail and add one. |
| `IMAP login failed` | Mail-app auth issue, not Bee Flow | Fix in NC Mail. |
| `Attachment too large` | Over the server's fixed 20 MB JSON body limit | Not tunable — fetch the mail without the attachment, or save it to a knowledge base instead. |
