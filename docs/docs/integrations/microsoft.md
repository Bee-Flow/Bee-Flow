---
title: Microsoft 365
---

# Microsoft 365

Bee Flow connects to Microsoft 365 via OAuth 2.0 against Microsoft Graph.

## Setup

1. Register an app in the [Microsoft Entra admin center](https://entra.microsoft.com) under **App registrations**.
2. Add the redirect URIs as **Web** redirect URIs. They are different for the two flows and both must be registered if you use both:
   - Signing in with Entra ID: `https://your-host/auth/callback/microsoft`
   - Connecting Outlook / Teams / OneDrive, and the Teams admin consent link: `https://your-host/api/integrations/microsoft/callback`
3. Under **API permissions**, add the Microsoft Graph delegated permissions in the [scope table](#scopes) below, and grant admin consent for the ones that need it.
4. As a platform administrator, open **Admin → Security → SSO → Microsoft** and fill in the **Application (client) ID**, the client secret **Value** (not the Secret ID) and the **Directory (tenant) ID**. Leave the tenant empty, or use `common`, for a multi-tenant app; `organizations` and `consumers` are accepted too (`consumers` does not work for Teams meeting notes, which need work or school accounts). Bee Flow keeps these values in its database; there are no environment variables for them. The SSO settings need the `sso_saml` licence feature.
5. Press the test button on the same tab to check the client ID and secret against Microsoft.

For Teams meeting notes, the full setup (admin consent, Teams settings, the built-in tests) is on [Teams meeting notes setup](./teams-meeting-notes.md).

## Integrations & tools

| Integration ID | Tools |
|----------------|-------|
| `outlook` | `outlook_search`, `outlook_list_recent`, `outlook_read`, `outlook_read_many`, `outlook_compose` |
| `outlook-readonly` | `outlook_search`, `outlook_list_recent`, `outlook_read`, `outlook_read_many` |
| `ms-calendar` | `mscal_list`, `mscal_search`, `mscal_create`, `mscal_update`, `mscal_delete` |
| `ms-contacts` | `mscontacts_list`, `mscontacts_search` |
| `onedrive` | `onedrive_list`, `onedrive_search`, `onedrive_read`, `onedrive_upload` |
| Teams meeting notes | none (no agent tools; powers [Meeting Notes](#microsoft-teams-meeting-notes)) |

The two Outlook flavours exist for orgs that want a strict-read-only audit-friendly variant alongside a full read-write one.

## Scopes

Bee Flow asks for one set of delegated permissions for every integration at once: the sign-in set
below, plus four extra when a member connects Microsoft 365 (marked "connect only"). Add all of them
to the app registration. The admin-consent column follows Microsoft's
[permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference).

| Permission | Teams meeting notes | Admin consent | Used for |
|---|---|:---:|---|
| `openid`, `email`, `profile` | Asked for by Bee Flow | No | Sign-in |
| `offline_access` | Asked for by Bee Flow | No | Stay connected |
| `User.Read` | Asked for by Bee Flow | No | Sign-in |
| `Mail.Read`, `Mail.Send` | Asked for by Bee Flow | No | Mail |
| `Mail.ReadWrite` | Asked for by Bee Flow (connect only) | No | Mail |
| `Mail.Read.Shared`, `Mail.Send.Shared`, `Mail.ReadWrite.Shared` | Asked for by Bee Flow (connect only) | No | Shared mailboxes |
| `Calendars.ReadWrite` | **Required** | No | Calendar |
| `Files.ReadWrite` | Asked for by Bee Flow | No | Files |
| `Contacts.ReadWrite` | Asked for by Bee Flow | No | Contacts |
| `OnlineMeetings.ReadWrite` | Optional | No | Switching on Teams' **Record automatically** |
| `OnlineMeetingRecording.Read.All` | **Required** | **Yes** | Meeting recordings |
| `OnlineMeetingTranscript.Read.All` | Optional | **Yes** | Meeting transcripts |

Organisation-wide Teams import (application permissions) has its own table on
[Teams meeting notes setup](./teams-meeting-notes.md#option-b-organisation-wide).

## Per-service detail

### Outlook

- Calls Graph `/me/messages`. Search uses `$search` with KQL syntax (`from:alice subject:invoice`).
- Reply preserves conversation thread (`conversationId`).
- Drafts go to `/me/mailFolders/drafts/messages`.
- Attachments via `/me/messages/{id}/attachments`.
- **Many emails at once**: `outlook_read_many` reads up to 100 emails through Graph [JSON batching](https://learn.microsoft.com/en-us/graph/json-batching) (20 per request), plus the attachment lists of those that have any, instead of one call per email in a *for each*.
- **Throttling**: every Graph call waits out a 429 for as long as its `Retry-After` says (at most 30 seconds, up to three times) and sends again; a 503 or 504 is only retried for reads, never for a request that sends mail or creates an event. Outlook allows 10,000 requests per 10 minutes per mailbox, and a batch of 20 still counts as 20.

### MS Calendar

- Calls `/me/events`. Recurrence supported.
- Teams meetings auto-created when `isOnlineMeeting=true` is set.
- Time-zone handling via `originalStartTimeZone` / `originalEndTimeZone`.

### MS Contacts

- `/me/contacts`, read-only. We don't create/edit contacts to keep blast radius small.

### OneDrive

- `/me/drive/root` and `/me/drive/items/{id}/children`.
- Search via `/me/drive/root/search(q='...')`.
- Read returns binary, with text extraction for Office formats.
- Upload via `PUT /me/drive/items/{parent}:/{name}:/content` for ≤4 MB; resumable session for larger files.
- An Excel or csv file in OneDrive can also become a live **datatable**: see [Spreadsheets as datatables](./spreadsheet-datatables.md).

## Microsoft Teams meeting notes

:::warning[Licence feature]

Meeting Notes needs a licence that includes the `meeting_notes` feature (see [Licensing](../licensing/tiers.md)).

:::

Setting it up, the built-in tests and every error code: [Teams meeting notes setup](./teams-meeting-notes.md).

The Teams meetings you **organise** become Meeting Notes: transcript, summary and action items, produced by Bee Flow's own pipeline. No bot joins the call.

### How it works

1. **Outlook calendar** (`/me/calendarView`): upcoming and recently ended events with a Teams link appear in **Meeting Notes → Upcoming**, next to Nextcloud Talk and Google Meet.
2. **onlineMeetings**: after the meeting, Bee Flow looks the meeting up by its join link (`/me/onlineMeetings?$filter=JoinWebUrl eq '…'`) and lists its recordings.
3. **Recording download**: the MP4 is streamed to disk, the audio track is extracted and the video deleted at once. The audio goes through your configured transcription engine, diarisation and speaker naming (calendar attendees anchor the names), exactly like an upload.
4. **Transcript fallback**: a meeting that was transcribed but not recorded is imported from its Teams transcript (WebVTT) with the speakers' Teams names. Such a note has no audio.

Microsoft's own Copilot meeting summaries are never used.

### Requirements

| Requirement | Detail |
|---|---|
| You organise the meeting | Under delegated permissions, Microsoft Graph gives recordings and transcripts to the **organiser** only. Meetings someone else organises show **Organizer only**. With [organisation-wide import](./teams-meeting-notes.md#option-b-organisation-wide) the meetings of covered members are imported with an app token instead; the organiser rule stays. |
| A recording (or transcript) exists | Someone presses record in Teams, or Bee Flow switches on Teams' **Record automatically** for the meeting (see below). Unrecorded meetings are skipped quietly after 48 hours. |
| Admin consent | `OnlineMeetingRecording.Read.All` and `OnlineMeetingTranscript.Read.All` need admin consent in Entra ID. Add them to the app registration and grant consent, or use the [admin consent link](./teams-meeting-notes.md#3-grant-admin-consent). |
| Bee Flow licence | The `meeting_notes` licence feature. |

**Transcript API access.** Microsoft switches Graph access to meeting transcripts **off by default** per tenant (Teams admin center → Meetings → Meeting settings → *Transcript API access*, or `Set-CsTeamsMeetingConfiguration -EnableGraphTranscriptAccess $true`). Speaker attribution in transcripts is off by default too (*Include speaker attribution*, `-EnableAttributedTranscripts $true`), and Bee Flow reads the speaker-attributed transcript. Recordings are not behind either switch, which is why Bee Flow uses the recording first and the transcript only as a fallback. With a switch off, meetings without a recording simply produce no note.

### Re-authorizing

Connections made before this feature have only the old `OnlineMeetings.Read` scope. Affected users see a reconnect banner in the Upcoming tab and in **Settings → Preferences**; **Reconnect Microsoft 365** runs the consent again and keeps the existing Outlook and OneDrive access.

### Upcoming tab & automatic recording

- Each Teams meeting you organise has a **record / skip** toggle, per occurrence, or for the whole series.
- With **Also switch on Teams recording** enabled, turning a meeting on sets `recordAutomatically` on it (`OnlineMeetings.ReadWrite`). Teams shows everyone in the call that it is being recorded. Without it the row says **Record in Teams**.
- Auto-import (off by default) and the default language live in **Settings → Preferences**; org admins set them for everyone under **Admin → Organisation → Meeting Templates**.
- Manual import: **New transcription → Microsoft Teams** lists the meetings you organised in the last week.
- Invited colleagues in your own organisation get read access to the note. Bee Flow does not notify them.

### Statuses & errors

Every import error code and every result of the built-in tests is in the
[troubleshooting tables](./teams-meeting-notes.md#troubleshooting). A recording is refused as
`recording_too_large` at two limits: the video download (`TEAMS_MAX_RECORDING_BYTES`, default
6 GiB) and the extracted audio (500 MB).

### Before you roll it out

Recording meetings is processing of personal data: set a lawful basis, tell participants, and consider a DPIA. In the Netherlands the works council (OR) has consent rights over systems that can monitor employees (art. 27 lid 1 k/l WOR).

## Refresh tokens

Microsoft refresh tokens have a 90-day inactive lifetime. The server auto-refreshes on 401; if the user is inactive >90 days they'll need to reconnect.

## Privacy

Same Privacy Shield mechanism as Google. With Strict mode, recipient names, addresses and phone numbers tokenise.

## Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| `AADSTS50076` | MFA required, no token | Sign in again and complete multi-factor authentication. |
| `403 Forbidden` | Missing Graph scope | Add the permission to the app registration, grant admin consent, reconnect. |
| `AADSTS53003` (Conditional Access) | An organisation policy blocked the sign-in, for example from a non-managed device | Ask the Entra administrator to check that Conditional Access policy. |
| `Token expired and refresh failed` | 90-day idle limit | User reconnects. |

The AADSTS codes the app registration test and the Teams tests recognise, with who fixes each, are
in the [troubleshooting tables](./teams-meeting-notes.md#app-registration-and-microsoft-sign-in).

## Restricting sign-in to one tenant

Fill in your **Directory (tenant) ID** under Admin → Security → SSO → Microsoft instead of `common`
to restrict the OAuth flow to that tenant. Bee Flow talks to the global Microsoft endpoints
(`login.microsoftonline.com`, `graph.microsoft.com`).
