---
title: Microsoft 365
---

# Microsoft 365

Bee Flow connects to Microsoft 365 via OAuth 2.0 against Microsoft Graph.

## Setup

1. Register an app in the [Azure portal](https://portal.azure.com) under **Microsoft Entra ID → App registrations**.
2. Add the redirect URIs you need. They are different for the two flows and both must be registered if you use both:
   - Signing in with Entra ID: `https://your-host/auth/callback/microsoft`
   - Connecting Outlook / Teams / OneDrive: `https://your-host/api/integrations/microsoft/callback`
3. Under **API permissions**, add the Microsoft Graph delegated permissions you need (see scopes below). Grant admin consent if your tenant requires it.
4. Set environment variables:
   ```bash
   OAUTH_MICROSOFT_CLIENT_ID=<application_id>
   OAUTH_MICROSOFT_CLIENT_SECRET=<client_secret>
   OAUTH_MICROSOFT_TENANT=common      # or your tenant ID
   ```
5. Restart the server.

## Integrations & scopes

| Integration ID | Graph scopes | Tools |
|----------------|--------------|-------|
| `outlook` | `Mail.Read`, `Mail.ReadWrite`, `Mail.Send`, `User.Read` | `outlook_search`, `outlook_read`, `outlook_compose`, `outlook_send`, `outlook_reply` |
| `outlook-readonly` | `Mail.Read`, `User.Read` | `outlook_search`, `outlook_read` |
| `ms-calendar` | `Calendars.ReadWrite` | `mscal_list`, `mscal_search`, `mscal_create`, `mscal_update`, `mscal_delete` |
| `ms-contacts` | `Contacts.Read` | `mscontacts_list`, `mscontacts_search` |
| `onedrive` | `Files.Read.All`, `Files.ReadWrite` | `onedrive_list`, `onedrive_search`, `onedrive_read`, `onedrive_upload` |

The two Outlook flavours exist for orgs that want a strict-read-only audit-friendly variant alongside a full read-write one.

## Per-service detail

### Outlook

- Calls Graph `/me/messages`. Search uses `$search` with KQL syntax (`from:alice subject:invoice`).
- Reply preserves conversation thread (`conversationId`).
- Drafts go to `/me/mailFolders/drafts/messages`.
- Attachments via `/me/messages/{id}/attachments`.

### MS Calendar

- Calls `/me/events`. Recurrence supported.
- Teams meetings auto-created when `isOnlineMeeting=true` is set.
- Time-zone handling via `originalStartTimeZone` / `originalEndTimeZone`.

### MS Contacts

- `/me/contacts` — read-only. We don't create/edit contacts to keep blast radius small.

### OneDrive

- `/me/drive/root` and `/me/drive/items/{id}/children`.
- Search via `/me/drive/root/search(q='...')`.
- Read returns binary, with text extraction for Office formats.
- Upload via `PUT /me/drive/items/{parent}:/{name}:/content` for ≤4 MB; resumable session for larger files.
- An Excel or csv file in OneDrive can also become a live **datatable** — see [Spreadsheets as datatables](./spreadsheet-datatables.md).

## Refresh tokens

Microsoft refresh tokens have a 90-day inactive lifetime. The server auto-refreshes on 401; if the user is inactive >90 days they'll need to reconnect.

## Privacy

Same Privacy Shield mechanism as Google. With Strict mode, recipient names, addresses and phone numbers tokenise.

## Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| `AADSTS50076` | MFA required, no token | Reconnect; Bee Flow uses interactive flow. |
| `403 Forbidden` | Missing Graph scope | Add scope, re-grant admin consent, reconnect. |
| `Conditional Access policy blocked` | Org policy denies non-managed device | Whitelist Bee Flow's app or run on a managed device. |
| `Token expired and refresh failed` | 90-day idle limit | User reconnects. |

## EU-region deployments

Set `OAUTH_MICROSOFT_TENANT=<your-tenant-id>` to lock the OAuth flow to a specific tenant. Combine with EU-region Microsoft Graph endpoints for data-residency compliance.
