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
| Teams meeting notes | `Calendars.ReadWrite`, `OnlineMeetings.ReadWrite`, `OnlineMeetingRecording.Read.All`, `OnlineMeetingTranscript.Read.All` | — (no agent tools; powers [Meeting Notes](#microsoft-teams-meeting-notes)) |

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

## Microsoft Teams meeting notes

:::warning[Pro tier feature]

Meeting Notes requires a Pro or higher licence key.

:::

The Teams meetings you **organise** become Meeting Notes — transcript, summary and action items, produced by Bee Flow's own pipeline. No bot joins the call.

### How it works

1. **Outlook calendar** (`/me/calendarView`) — upcoming and recently ended events with a Teams link appear in **Meeting Notes → Upcoming**, next to Nextcloud Talk and Google Meet.
2. **onlineMeetings** — after the meeting, Bee Flow looks the meeting up by its join link (`/me/onlineMeetings?$filter=JoinWebUrl eq '…'`) and lists its recordings.
3. **Recording download** — the MP4 is streamed to disk, the audio track is extracted and the video deleted at once. The audio goes through your configured transcription engine, diarisation and speaker naming (calendar attendees anchor the names), exactly like an upload.
4. **Transcript fallback** — a meeting that was transcribed but not recorded is imported from its Teams transcript (WebVTT) with the speakers' Teams names. Such a note has no audio.

Microsoft's own Copilot meeting summaries are never used.

### Requirements

| Requirement | Detail |
|---|---|
| You organise the meeting | Under delegated permissions, Microsoft Graph gives recordings and transcripts to the **organiser** only. Meetings someone else organises show **Organizer only**. |
| A recording (or transcript) exists | Someone presses record in Teams, or Bee Flow switches on Teams' **Record automatically** for the meeting (see below). Unrecorded meetings are skipped quietly after 24 hours. |
| Admin consent | `OnlineMeetingRecording.Read.All` and `OnlineMeetingTranscript.Read.All` need admin consent in Entra ID. Add them to the app registration and grant consent. |
| Bee Flow licence | Pro or higher (`meeting_notes` feature). |

**Transcript API access.** Since mid-2026 Microsoft switches Graph access to meeting transcripts **off by default** per tenant (Teams admin center → Meetings → Meeting settings → *Transcript API access*, or `Set-CsTeamsMeetingConfiguration -EnableGraphTranscriptAccess $true`). Recordings are not behind that switch, which is why Bee Flow uses the recording first and the transcript only as a fallback. With the switch off, meetings without a recording simply produce no note.

### Re-authorizing

Connections made before this feature have only the old `OnlineMeetings.Read` scope. Affected users see a reconnect banner in the Upcoming tab and in **Settings → Preferences**; **Reconnect Microsoft 365** runs the consent again and keeps the existing Outlook and OneDrive access.

### Upcoming tab & automatic recording

- Each Teams meeting you organise has a **record / skip** toggle — per occurrence, or for the whole series.
- With **Also switch on Teams recording** enabled, turning a meeting on sets `recordAutomatically` on it (`OnlineMeetings.ReadWrite`). Teams shows everyone in the call that it is being recorded. Without it the row says **Record in Teams**.
- Auto-import (off by default) and the default language live in **Settings → Preferences**; org admins set them for everyone under **Settings → Organisation**.
- Manual import: **New transcription → Microsoft Teams** lists the meetings you organised in the last week.
- Invited colleagues in your own organisation get read access to the note. Bee Flow does not notify them.

### Statuses & errors

| Code | Meaning | Fix |
|---|---|---|
| `not_organizer` | This account did not organise the meeting | Ask the organiser to connect Microsoft 365. |
| `no_recording` | No recording or transcript 24 h after the end | Record the meeting, or turn on automatic recording. |
| `needs_teams_scopes` | The connection lacks the Teams permissions | Reconnect Microsoft 365; an admin may need to grant consent. |
| `transcript_access_disabled` | The tenant switched transcript API access off | Use recordings, or ask the Teams admin to enable it. |
| `recording_too_large` | The extracted audio is over 500 MB | Split the meeting or upload the audio by hand. |

### Before you roll it out

Recording meetings is processing of personal data: set a lawful basis, tell participants, and consider a DPIA. In the Netherlands the works council (OR) has consent rights over systems that can monitor employees (art. 27 lid 1 k/l WOR).

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
