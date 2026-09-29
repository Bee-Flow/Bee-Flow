---
title: Google Workspace
---

# Google Workspace

Bee Flow connects to Google Workspace via OAuth 2.0. Each Workspace service is a separate integration ID with its own OAuth scopes.

## Setup

1. Create a Google Cloud project at [https://console.cloud.google.com](https://console.cloud.google.com).
2. Enable the APIs you want: Gmail, Calendar, Drive, Docs, Keep, People, Admin SDK, Google Meet REST API (for [Meeting Notes](#google-meet-meeting-notes)).
3. **APIs & Services → Credentials → Create OAuth client ID** — type Web Application.
4. Add the redirect URIs you need. They are different for the two flows and both must be registered if you use both:
   - Signing in with Google: `https://your-host/auth/callback/google`
   - Connecting Gmail / Calendar / Drive: `https://your-host/api/integrations/google/callback`
5. Set environment variables:
   ```bash
   OAUTH_GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   OAUTH_GOOGLE_CLIENT_SECRET=...
   ```
6. Restart the server. Users will see "Connect Google" buttons in **Settings → Account → Integrations**.

For org-wide Workspace deployments, register Bee Flow as an internal app in the Google Workspace admin console.

## Integrations & scopes

| Integration ID | Scope(s) | Tools |
|----------------|----------|-------|
| `gmail` | `gmail.readonly`, `gmail.compose`, `gmail.send` | `gmail_search`, `gmail_read`, `gmail_read_attachment`, `gmail_compose`, `gmail_send`, `gmail_reply` |
| `google-calendar` | `calendar` | `gcal_list`, `gcal_search`, `gcal_create_event`, `gcal_update_event`, `gcal_delete_event` |
| `google-drive` | `drive.readonly`, `drive.file` | `gdrive_list`, `gdrive_search`, `gdrive_read`, `gdrive_upload` |
| `google-docs` | `documents.readonly` | `gdocs_read`, `gdocs_create`, `gdocs_update` |
| `google-keep` | `keep` | `gkeep_list`, `gkeep_create`, `gkeep_search` |
| `google-contacts` | `contacts.readonly` | `gcontacts_list`, `gcontacts_search` |
| `google-groups` | (delegated admin) | `ggroups_list_members` |
| `google-meet` | `meetings.space.readonly`, `meetings.space.settings` | — (no agent tools; powers [Meeting Notes](#google-meet-meeting-notes)) |

The minimum-scope principle applies: Bee Flow asks only for what's needed by the integrations you enable.

## Per-tool detail

### Gmail

- **Reading** — `gmail_search` accepts the same query syntax as the Gmail UI (`from:alice subject:invoice newer_than:7d`).
- **Composing** — `gmail_compose` creates a draft. Sending requires `gmail.send` scope and an explicit `gmail_send` call. This split is intentional — agents can suggest replies without auto-sending.
- **Replies** — `gmail_reply` preserves `In-Reply-To` and `References` headers so threading works.

### Calendar

- All-day vs timed events handled correctly.
- Recurrence supported via RRULE.
- Conference link generation (Google Meet) on create when `conferenceData.createRequest` is set.

### Drive

- Read includes Google-native formats (Docs / Sheets / Slides) — they're exported to plain text / Markdown for the model.
- Upload sends the binary; `mimeType` auto-detected.
- Shared-with-me + My Drive both searchable.
- A spreadsheet in Drive (a native Google Sheet, or an uploaded xlsx/csv) can also become a live **datatable** — see [Spreadsheets as datatables](./spreadsheet-datatables.md).

### Docs

- Read returns the document content as plain text + structured headings.
- Update applies a list of edits (insert / replace / delete ranges).

### Keep

- Notes only (not "Reminders" — those are part of Google Tasks).

### Contacts

- Returns name, email, phone, organisation, photo URL.

### Groups

- Workspace admin-only — used by automations that need to enumerate group members.

## Google Meet meeting notes

:::warning[Pro tier feature]

Meeting Notes requires a Pro or higher licence key.

:::

Connect your Google account and your **recorded** Google Meet meetings become Meeting Notes automatically — transcript, summary and action items, produced by Bee Flow's own pipeline.

### How it works

No bot joins your calls. Bee Flow combines three Google APIs on your own OAuth connection:

1. **Calendar API** — finds upcoming and recently ended calendar events with a Meet link. They appear in **Meeting Notes → Upcoming** next to your Nextcloud Talk meetings.
2. **Meet REST API v2** — after the meeting ends, resolves the conference record and waits for Google to finish generating the recording (usually minutes; Google gives no SLA).
3. **Drive API** — downloads the recording file from the organizer's Drive.

The audio track is extracted (the video is discarded immediately), transcribed with your **WhisperX** service, speaker-labelled from the Meet participant roster, then summarised. Google's own transcript / Gemini notes are never used — the pipeline is the same one that handles Nextcloud Talk recordings, so language behaviour and summary quality match.

### Requirements

| Requirement | Detail |
|---|---|
| A recording exists | Bee Flow only imports meetings that were **recorded in Meet**. Recording is a Google Meet product feature: it works only when the **organizer has Google Workspace Business Standard or higher**. Free Gmail accounts can never produce recordings — there is nothing to import. |
| Recording was started | Someone must press record in the meeting, or the organizer pre-configures auto-recording (see below). Unrecorded meetings are skipped quietly. |
| Meet scopes granted | The Google connection must include the two Meet scopes (see below). |
| WhisperX reachable | `WHISPERX_URL` (or the URL in Admin → Integrations → Transcription) must point at your WhisperX service — see the self-hosting notes. |
| Bee Flow licence | Pro or higher (`meeting_notes` feature). |

### Organizer vs attendee

The recording file lands in the **organizer's Drive**. All participants can see *that* a recording exists, but usually **only the organizer's connected account can download it**:

- **You organized the meeting** — auto-import works end-to-end from your account. Attendees from your org who also connected Google get the finished note shared with them automatically.
- **You only attended** — the meeting shows **recording held by organizer** (`no_drive_access`). Ask the organizer to connect their Google account to Bee Flow, or have them share the file with you and import it manually.

This is a Google access-control property, not a Bee Flow limitation. For teams that live in Meet, make sure the people who *organize* the meetings connect their accounts.

### OAuth scopes & re-authorizing

Meeting Notes adds two scopes to the Google connection:

| Scope | Purpose |
|---|---|
| `meetings.space.readonly` | Read conference records, recording metadata and the participant roster. Google classifies this scope as *sensitive*. |
| `meetings.space.settings` | Pre-configure auto-recording on meetings you organize (`spaces.patch`). |

**Connections made before this feature shipped don't have these scopes yet.** Affected users see an "Update needed" badge in **Settings → Integrations** and a reconnect banner in the Upcoming tab. One click on **Re-authorize** runs an incremental consent — existing Gmail / Calendar / Drive grants are kept, only the Meet scopes are added. Users who sign in *with* Google (SSO) re-consent automatically at their next login.

### Upcoming tab & auto-recording

- Every calendar meeting with a Meet link shows in **Meeting Notes → Upcoming** with a per-meeting **record / skip toggle** — per occurrence, or for the whole series.
- With **auto-record configuration** enabled in settings, toggling a meeting on pre-sets Meet's auto-recording on the conference space — but **only for meetings you organize**: Google restricts this to the host, and it requires a Workspace edition with recording. Meetings organized by someone else show **Record in Meet** instead — someone still has to press record in the call; Bee Flow picks the recording up afterwards.
- Auto-import (off by default), import scope (only meetings you organize vs. any calendar meeting with a Meet link) and default transcription language live in **Settings → Preferences → Meeting notes**; org admins get the same controls org-wide under **Settings → Organisation**.
- Manual import always works: **New transcription → Google Meet** lists your recent recorded meetings.

### Statuses & errors

Stable codes shown in the Upcoming tab and import panel:

| Code | Meaning | Fix |
|---|---|---|
| `not_connected` | No Google connection | Connect in Settings → Integrations. |
| `needs_meet_scopes` | Connection predates the Meet scopes | Re-authorize (one click, incremental consent). |
| `needs_reauth` | Refresh token revoked / expired | Reconnect; pending imports resume automatically. |
| `no_recording` | Meeting ended but was never recorded | Expected and quiet — nothing to import. |
| `no_conference` | The event's Meet link was never joined | Nothing to import. |
| `no_drive_access` | Only the organizer's account can download this recording | Ask the organizer to connect, or share the file and import manually. |
| `recording_too_large` | Extracted audio exceeds the 500 MB cap | Import a shorter portion manually. |
| `unsupported_edition` | Auto-record pre-config rejected: the Workspace edition has no recording | Organizer needs Business Standard+. |
| `failed` | Transcription/summary failed after retries | Check server + WhisperX logs; re-import manually. |

### Self-hosting notes

- **Set the OAuth consent screen to *Internal*** (available on Google Workspace). An *External* consent screen left in *Testing* mode expires refresh tokens after **7 days** — every user would have to reconnect weekly, and background imports would park as `needs_reauth`. External + *In production* works but requires Google's app verification because `meetings.space.readonly` is a sensitive scope; for a self-hosted instance used by your own Workspace, Internal is the right choice and needs no verification.
- **Enable the Google Meet REST API** in your Google Cloud project, alongside Calendar and Drive.
- **Point `WHISPERX_URL` at your own WhisperX service** (or set the URL under Admin → Integrations → Transcription). There is deliberately no hosted fallback: if no WhisperX URL is configured, Meet imports fail rather than sending meeting audio anywhere else. See [Environment variables](../self-hosting/env.md).

### Privacy

- Meeting transcripts and summaries are stored **server-readable** in Postgres — the same as Nextcloud Talk notes, **not** zero-knowledge encrypted. Anyone with database access can read them; factor this into your retention policy.
- Audio is transcribed by your own WhisperX service; the extracted audio and transcript text never leave your infrastructure except for the LLM summarisation step, which follows your normal model-provider configuration and Privacy Shield settings.
- **Recording consent is handled by Google Meet itself** — Meet announces the recording to all participants and asks for consent in-call. Bee Flow never records anything; it only imports what Meet already produced.

## Auto-refresh

The Google Auth library auto-refreshes access tokens on 401. Refresh tokens are stored AES-encrypted in Postgres (using `BEEFLOW_ENCRYPTION_KEY`).

## Privacy

All bodies retrieved from Gmail / Drive / Docs flow through the Privacy Shield. With Strict mode, contact names, email addresses and phone numbers are tokenised.

## Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| `invalid_grant` on refresh | Token revoked / user changed password | User reconnects in Settings → Integrations. |
| `403 insufficient scope` | App requested fewer scopes than the tool needs | Add the scope and have the user reconnect. |
| `429 quota exceeded` | Per-day API quota | Raise quota in Google Cloud Console or throttle. |
| `Drive item too large` | Over the server's fixed 20 MB JSON body limit | Not tunable — skip the body and use metadata only, or split the file. |
