# Fact sheet — Meeting Notes (audience: everyday users)

Status: **the feature exists and is fully built** (frontend `agent-hub/src/pages/meeting-notes/`,
backend `server/routes/transcriptions/*`, `server/core/meetingNotes/*`). Verified against the code on
branch `claude/builder-redesign-fase-1-6sun0h`, 2026-09-14.

---

## 1. What it is for

Meeting Notes turns a **conversation** into a **document you can work from**. You record a meeting
(microphone, an uploaded file, a Nextcloud Talk call recording, or a Google Meet recording); Bee Flow
transcribes it, labels who said what, writes a summary in a style you choose, and pulls out
**action items, decisions and open questions**. Those pieces can then be filed onward — into a
knowledge base, a datatable, or an automation — and a note can be shared with the organisation or with
specific groups.

Two important product facts:

- The note is **owned by the person who created it**. Everyone else sees it only if the owner
  publishes it. Editing (rename, speakers, regenerate summary, delete, share) is **owner-only**.
- Bee Flow is a privacy product: the meeting **audio** never becomes a public URL (playback goes
  through an access-checked endpoint), the raw audio path is stripped from every API payload, and the
  automation event a finished note fires carries **only the note id, tags, orgId and a `reprocessed`
  flag** — never the summary or the attendees.

---

## 2. Where it lives (navigation)

- Sidebar / Studio tab label: **"Meeting Notes"** (`studio.tab.meeting_notes`), subtitle
  **"Transcripts, speakers and actions"** (`studio.tab.meeting_notes_desc`), mic icon.
- Canonical URL: **`/app/studio/meeting-notes`**, one note at `/app/studio/meeting-notes/<id>`.
  `/app/meeting-notes` still works and redirects into Studio (`authedApp/appRoutes.js`).
- "New" menu item in Studio: **"Record or upload a meeting"** (`studio.new.meeting`) → navigates to
  `studio/meeting-notes/new`, which opens the capture modal.
- Keyboard: **Ctrl/Cmd + Shift + M** opens the scoped **meeting command palette**
  (`components/global/MeetingCommandPalette.jsx`) — three capture actions plus the five most recent
  meetings.

---

## 3. Screens, with real labels

### 3.1 Meeting Notes page — the shell
`pages/meeting-notes/MeetingNotesPage.jsx`. A 300 px left rail + detail pane (on a phone the rail *is*
the page and a selected note covers it).

- Rail head: **"Meeting notes"** + a plain number = how many notes are loaded, and a primary button
  **"Record"** (mic icon).
- Segmented control, always visible: **"Library"** | **"Upcoming"** (the Upcoming segment carries a
  count badge).
- Soft banner after a transparent engine switch: *"Your recording was too long for the on-device
  model — transcribed via {provider} instead."* with a **"Dismiss"** link; auto-hides after 10 s.

### 3.2 Library rail (`library/MeetingLibrary.jsx`, `library/LibraryFilters.jsx`, `library/MeetingRow.jsx`)
- Search field placeholder: **"Search title, tag or text…"** (searches title, file name, tags and the
  transcript snippet the list row carries).
- Sort button (⇅) menu: **"Newest first" / "Oldest first" / "Longest first" / "Title (A → Z)"**.
- Filter chips: **"All"**, **"Mine"**, **"Shared"**, then **tag chips with counts**
  (e.g. `sales 4`). At most **5 tag chips** show; the rest fold behind **"+{n} tags"**, and
  **"Fewer tags"** folds them back. A selected tag is always kept visible.
- Multi-select: **"AI report"** button → select mode, counter
  *"{selected}/{max} selected — click meetings to select"*, then **"Ask AI"**; the ✕ is
  **"Cancel selection"**. A note that is still transcribing or failed is greyed with the tooltip
  **"This meeting is not ready yet"**.
- One row = tile + title + meta line: `date · duration · status phrase`. The status phrase is
  **"transcribing…"**, the failure reason, **"{count} actions open"**, or **"all done"**.
  A source chip (**Talk** / **Meet** / **Nextcloud**) appears for imported notes; a share icon
  appears with tooltip **"Shared with your organisation"** or **"Shared with {count} groups"**.
- Empty state: title **"No meetings yet"**, body *"Record live, upload a file, or connect Nextcloud
  Talk or Google Meet to import your call recordings automatically."*, button **"Record"**.
- Failed list load (not empty!): **"Couldn't load your meetings"** + **"Try again"**.
- Filters match nothing: **"No meetings match your filters."**

### 3.3 Upcoming rail (`library/UpcomingMeetings.jsx`)
Calendar meetings in the next **48 hours** that have a Talk room or a Meet link, each with a
record/import toggle.
- Intro: *"Your upcoming meetings — toggle which ones to auto-record."*, plus **"Refresh"**.
- Status chips: **"Recording"**, **"Will record"**, **"Note created"** (clickable → opens the note),
  **"Decides at start"** (tooltip: *"Bee Flow counts who is in the call when it starts; the calendar
  invite does not say."*), **"Not a moderator"**, **"Organizer only"**, **"Record in Meet"**,
  **"Upcoming"**.
- Banners: *"The Nextcloud Talk recording backend isn't configured, so auto-record is unavailable.
  You can still import finished recordings."*; *"Connect Google Workspace to see your Meet meetings
  here — Settings → Integrations"*; *"Your Google connection doesn't include Meet permissions yet —
  reconnect to enable auto-import."* with **"Reconnect"**.
- Empty: **"No upcoming meetings"** / *"Meetings in your calendar with a Nextcloud Talk conversation
  or a Google Meet link show up here."*
- Deliberate omission: **no Microsoft Teams row** — there is no Teams meeting source or recording
  source in this codebase.

### 3.4 Capture modal (`capture/CaptureModal.jsx`)
Title **"New transcription"**, description *"Record or upload audio to a meeting."*
Four tiles (Talk and Meet tiles only appear when that integration is connected):
1. **"Record audio"** — *"Capture live from your microphone."*
2. **"Upload a file"** — *"Drop a .mp3, .wav, .m4a or .mp4."*
3. **"Nextcloud Talk"** — *"Transcribe a Talk call recording."*
4. **"Google Meet"** — *"Import a recorded Meet call."*

Shared settings block on every panel (`capture/CaptureControls.tsx`):
- **"Who's in the meeting? (improves speaker names)"**, placeholder `Tom, Gerard, René…`
- **"Number of speakers (optional — Auto detects)"** — blank = Auto, 1–50.
- Disclosure row: **"Advanced — 🇳🇱 Dutch"** (shows the active language, and `, glossary set`),
  containing **"Language"** (14 options, Dutch first) and **"Glossary (optional)"**
  placeholder `AFAS, Bflow, N8N…`.
- There is **no engine picker** for end users — the server-configured engine is used.

Record panel: big mic button; states **"Tap the mic to start"**, **"Recording in progress"**,
**"Paused"**, **"Processing audio…"**, **"Transcribing your meeting…"**; buttons **"Pause"** /
**"Resume"** / **"Discard"**. Mic denied: *"Microphone access denied. Please allow access in your
browser settings."* Closing while recording asks **"Close while recording?"** with the confirm button
**"Keep recording"**.

Upload panel: dropzone **"Drop an audio file here, or click to browse"**, hint
**"Supports .mp3, .wav, .m4a, .webm, .mp4 — up to ~2 hours"**. Errors: **"Upload failed"** with
**"Retry"** / **"Dismiss"**, or the special **"Recording too long for on-device transcription"** with
**"Switch engine & retry"**.

Talk import: *"Pick a call recording — Bee Flow transcribes it with your configured engine."*,
rows grouped per conversation with `Video|Audio · size · date` and a **"Transcribe"** button;
empty: **"No Talk recordings found"**.

Meet import: *"Pick a recorded Meet call…"*, **"Transcribe"** / **"Processing…"** /
**"No recording"** / **"Note created"**; if the Google connection predates Meet support:
**"Google Meet needs additional access"** + **"Re-authorize Google"**.

### 3.5 Meeting detail (`detail/MeetingDetail.jsx`, `detail/MeetingHeader.jsx`)
Empty pane: **"Select a meeting"** / *"Pick a meeting from the library to see its summary, action
items and full transcript — or start a new one below."* with **"Record"** and **"Upload"**.

Header (48 px): kind tile, **title (click to rename — owner only)**, meta
`date · duration · "1 speaker"/"{n} speakers" · NL · [source chip]`, tab strip
**Summary · Transcript · Insights · Used by {n}**, the visibility capsule, the **"Ask AI"** toggle,
and the ⋯ **"More actions"** menu:
**"Copy transcript"**, **"Edit speakers"**, **"Export as Markdown"**, **"Export as Text"**,
**"Re-transcribe"** (disabled when *"The audio for this meeting is no longer available"*),
**"Delete"**.

While processing: **"Transcribing…"** — *"This runs in the background — you can close this and come
back. Long recordings with speaker labels can take a while on the local diarizer; the note updates
automatically when it's ready."* (the detail polls every **4 s**).
On failure: **"Transcription failed"**, plus either *"The recording is saved, so you can retry it."*
and **"Retry transcription"**, or *"The audio is no longer available, so this note cannot be
retried."*

**Summary tab** — three insight chips (**"Balance" / "Interactivity" / "Silence"**), then
**"Summary"** with a **"Regenerate"** split button whose menu is sectioned
**"Built-in" / "My templates" / "Organization"** and ends in **"New template…"**; a template stamp
reads **"Template: {name} (v{version})"**. No summary yet → **"No summary yet."**
Below: **"Action items"** (empty: *"No action items detected."*), each with a checkbox
(**"Mark done"/"Mark not done"**), inline edit (**"Click to edit"**), an **Owner**/**Due date** chip,
a **"kept"** badge when a regeneration no longer found an action that had been edited or ticked, and
a destination chip; plus **"Decisions"** and **"Questions"** (`open` / `answered`).
Under the tag row sits **"What happens to this meeting"** (empty: *"Nothing picks this meeting up
yet."*).

**Transcript tab** — search field **"Search transcript…"** (no hits: *"No matching segments."*),
speaker-coloured turns, timestamps that seek the player, and per-line menu **"What is this line?"**:
**"Action"**, **"Decision"**, **"To a knowledge base"**, **"Row in a table"**, **"Copy quote"**
(already-classified lines read **"Already an action" / "Already a decision"**). Beside it,
**"Pulled from this transcript"** with **Action items / Decisions / Open questions** counters,
**"Filed as knowledge"** (empty: *"No line from this transcript has been filed yet."*) and
**"Speakers"**, including the speaker-gap hint *"One speaker was not recognised — was {name} in this
meeting?"* with **"Check the speakers"**.

**Insights tab** — sub-tabs **"Overview" / "People" / "Flow" / "Topics" / "Follow-up"**; when the org
switched per-person stats off: *"Per-person statistics are disabled by your organization."*
Not enough data: *"Not enough data for insights on this meeting."*

**Used by tab** — what depends on this note (knowledge bases, automations, notebooks); empty:
*"Nothing uses this meeting yet."*

**Tag row** — chips with **"Remove tag {tag}"**, plus **"Add tag"** (placeholder **"Add tag…"**).

**Danger zone** — **"Delete this meeting"** → *"Delete "{name}" for good?"*; it first shows who uses
the note, and when something could not be checked it says *"Some of what could use this meeting could
not be checked ({kinds}), so this list may be incomplete."* and makes you **type the meeting title**.

### 3.6 Speaker editor (`detail/SpeakerEditor.jsx`, owner only)
Modal **"Edit speakers"** — *"Rename a speaker, or merge two speakers into one. Changes apply to the
transcript, speaker list and exports."* Contains **"Auto-detect names"** (*"Let AI map the speakers to
real names using the transcript. Add who was in the meeting to make it reliable."*), an attendee input
`Gerard, Tom, René… (optional)` and a **"Detect"** button; per row an editable name, the speaking
time, **"Merge with…"** and **"Undo"**; footer **"Cancel"** / **"Save changes"**. Afterwards the
detail offers *"Speakers updated. Regenerate the summary with the new names?"* → **"Regenerate"**.

### 3.7 Summary templates (`detail/TemplateEditor.jsx`, `detail/TemplateManager.jsx`)
Modal **"New summary template"** / **"Edit template"** — *"Write the instructions the AI follows when
it generates this summary style."* Fields: **"Name"** (`e.g. Board summary, Klant-review NL`),
**"Start from a built-in (optional)"** (**"Blank"** + the five built-ins), **"Prompt"**
(*"Describe the summary you want — sections, tone, what to focus on…"*), **"Visible to"**
(**"Just me" / "Whole organization" / "Specific group"** — *"Scope can't be changed after
creation."*), **"Group"**, and **"Use as the default for new meetings"**.
Buttons **"Save template"**, **"Cancel"**, **"Delete"**.

### 3.8 Settings screens
- **Settings → Preferences → "Nextcloud Talk Meeting Notes"** (self-hides without the licence or a
  Nextcloud connection): **"Auto-record my Talk meetings"**, **"Which calls"**
  (*Calendar meetings / Any call I moderate*), **"Recording quality"** (*Audio-only / Video*),
  **"Auto-transcribe my Talk recordings"**, **"Post summary back into Talk"**,
  **"Recordings folder"** (default `/Talk/Recording`), **"Default language"**, **"Save"**.
- **Settings → Preferences → "Voice profile"**: *"Record your voice once and your name is put on your
  own turns automatically in meetings recorded by anyone in your organisation. Only you can record
  your voice profile."* Rows **"Your voice profile is active" / "No voice profile yet"**,
  coverage line *"{enrolled} of {members} colleagues have a voice profile…"*, buttons
  **"Record voice profile"** / **"Record again"** / **"Delete"**. Enroll modal
  **"Record your voice profile"** with a consent checkbox *"I agree that a voice profile of my voice
  is created and stored."*
- **Settings → Organisation → "Talk Meeting Notes"** (org admin): the same toggles at org scope, which
  **override each member's personal setting**, plus **"Per-person meeting insights"**
  (*"Off = members see only meeting-level metrics."*).
- **Admin → Integrations → Transcription** (super admin): **"Active Provider"** — *"Choose which
  engine will be used when you transcribe audio in Meeting Notes."* Options: **Voxtral** (Mistral
  cloud), **Azure Speech**, **WhisperX** (self-hosted), **Scaleway** (EU Whisper large-v3 + local
  diarizer), **pyannoteAI** (best diarization + voice profiles), and the local CPU Whisper.

---

## 4. Concepts a learner must understand

| Term | Plain-language definition |
|---|---|
| **Meeting note** | One recording plus everything derived from it: transcript, speakers, summary, action items, decisions, questions, tags. Stored as one `transcriptions` row. |
| **Transcription engine (provider)** | The speech-to-text service that turns audio into text. An administrator picks one for the whole workspace: Voxtral, WhisperX, Scaleway, Azure, pyannoteAI, or the local CPU Whisper. Users do not choose per upload. |
| **Diarization** | Splitting the audio by *who* is speaking. It produces anonymous ids ("Speaker 1"), not names. |
| **Speaker naming** | The step that turns those ids into real names, from the attendee list you typed, names spoken in the conversation, and (with pyannoteAI) voice profiles. |
| **Voice profile (voiceprint)** | A ~25-second recording of your own voice, stored as an opaque numeric template. It lets Bee Flow put your name on your own turns automatically. It is biometric data (GDPR Art. 9), self-enrolled only, and never readable by an admin. |
| **Summary template** | The instructions the AI follows when writing the summary. Five built-ins plus your own, saved at *Just me*, *Whole organization* or *Specific group* scope; one can be the default for new meetings. |
| **Action item / decision / open question** | The three things the AI extracts from a transcript. Action items have an owner, a due date, a timestamp and a done-checkbox. |
| **Destination** | Where you send an action item so someone can work on it: start an automation, add a row to a datatable, or file it in a knowledge base. The note remembers only a *reference* to where it went. |
| **Tag** | A free-text label on a note. Tags drive the library filter chips, the "meetings with this tag" knowledge source, and automation trigger filters. Max 80 characters, max 50 per note. |
| **Publish / visibility** | Personal (owner only) → entire organisation → specific groups. Publishing makes the note readable, never editable, by others. |
| **Attendees** | Who was in the room, typed before capture. The single strongest input to correct speaker names. |
| **Series** | Notes recorded from the same Meet code or Talk room. The detail shows a "previously in this series" card. |
| **Used by** | The list of knowledge bases, automations and notebooks that consume this note. It guards deletion. |
| **Rule (`meeting.processed`)** | An automation that starts by itself when a meeting note is ready. Its payload is only the note id, tags, orgId and `reprocessed`. |

---

## 5. End-to-end workflows (exact clicks)

### A. Record a live meeting and clean it up
1. Open **Studio → Meeting Notes** (or press **Ctrl+Shift+M**).
2. Click **Record** (top right of the rail).
3. In **"New transcription"**, click the **"Record audio"** tile.
4. Type who is present in **"Who's in the meeting? (improves speaker names)"** — e.g. `Sandra, Ewald, Tom`.
5. Optionally set **"Number of speakers"**; open **"Advanced — 🇳🇱 Dutch"** to change the language or
   add a **Glossary**.
6. Click the big **microphone** button; the timer runs and the status reads **"Recording in progress"**.
   Use **Pause** / **Resume** if needed.
7. Click the button again (now a **stop** square). The status goes **"Processing audio…"** →
   **"Transcribing your meeting…"**, the modal closes and a new row appears in the rail with
   **"transcribing…"**.
8. When it finishes, the note opens on the **Summary** tab. Read the summary and the **Action items**.
9. If speakers are wrong: ⋯ → **"Edit speakers"**, rename or **"Merge with…"**, then **"Save changes"**.
10. Accept the banner **"Speakers updated. Regenerate the summary with the new names?"** →
    **"Regenerate"**.

### B. Give the summary the right shape (template)
1. Open a finished note → **Summary** tab.
2. Click the caret next to **"Regenerate"**.
3. Pick a built-in (**General meeting**, **Stand-up**, **Sales call**, **Interview**,
   **Retrospective**) — the summary is rewritten with that style and stamped **"Template: {name}"**.
4. For your own style: choose **"New template…"**.
5. Fill in **Name**, optionally **"Start from a built-in"**, write the **Prompt**, choose
   **"Visible to"** (*Just me* / *Whole organization* / *Specific group* — org and group need org
   admin), tick **"Use as the default for new meetings"** if wanted, click **"Save template"**.
6. Back on the note, open **Regenerate** again and pick your template under **"My templates"**.

### C. Share a meeting with colleagues
1. Open the note (you must be the owner).
2. Click the **visibility capsule** in the header.
3. Choose **Personal**, **Entire organisation**, or tick one or more **groups**.
4. The library row now shows the share icon; colleagues see the note in **Library → All/Shared**.
5. Note: they can read it, they cannot rename, re-transcribe, edit speakers or delete it.

### D. Turn an action item into work somewhere else
1. Open the note → **Summary** tab → **Action items**.
2. Click the destination control on an action → **"Where should this action go?"**.
3. Pick one of **"Start an automation"**, **"Row in a table"**, **"To a knowledge base"**.
4. For a table: pick the table, then map fields (**Action**, **Owner**, **Due date**, **Timestamp**,
   **Meeting**, **Meeting date**; columns you don't want get **"Leave empty"**) → **"Add the row"**.
5. The action now carries a chip, e.g. **"Row in table {label}"** or **"Start: {label}"**.
6. Failure reads **"Could not send this action: {message}"**; a partial failure reads *"That worked,
   but the note could not be updated. Refresh and try again."*

### E. Import a Nextcloud Talk or Google Meet recording
1. **Record** → the **"Nextcloud Talk"** or **"Google Meet"** tile (only visible when connected).
2. Set attendees / language as in workflow A.
3. Pick the recording from the list and click **"Transcribe"**.
4. To make this automatic instead: **Settings → Preferences → Nextcloud Talk Meeting Notes** →
   **"Auto-transcribe my Talk recordings"** (and, for Meet, the Google Meet settings), or open the
   **Upcoming** tab and toggle individual meetings.
5. Auto-imported notes get a **Talk** / **Meet** source chip in the library.

### F. Ask questions across several meetings
1. In the rail, click **"AI report"**.
2. Click the meetings you want (max **10**); the counter shows *"{selected}/10 selected"*.
3. Click **"Ask AI"**, type the question, send. A cited markdown report comes back.
   (For one meeting, use **"Ask AI"** in the note header instead — that chat is scoped to that
   transcript only.)

---

## 6. Defaults and limits (numbers)

| Thing | Value | Source |
|---|---|---|
| Upload size cap | **500 MB** (`"File too large. Maximum size is 500 MB."`) | `routes/transcriptions/upload.js` |
| Accepted extensions | `.mp3 .wav .m4a .ogg .webm .flac .mp4 .mpeg .aac` (or any `audio/*` mime) | same |
| UI hint on the dropzone | *"up to ~2 hours"* | `capture/UploadPanel.jsx` |
| Library page size | **50** per request, max **100**, `offset` for more | `routes/transcriptions/notes.js` |
| Tag chips shown before folding | **5** | `library/LibraryFilters.jsx` |
| Tag vocabulary returned | max **200** tags, sorted count desc | `routes/transcriptions/tags.js` |
| Tags per note | max **50**, each trimmed to **80** chars | `routes/transcriptions/noteActions.js` |
| AI report | max **10** notes, **400 000** chars of context, question ≤ **4000** chars | `routes/transcriptions/report.js` |
| Speaker-count hint | 1–**50**, blank = Auto | `routes/transcriptions/shared.js` |
| Summary generation | smart tier, **8192** max tokens, **9 min** LLM timeout | `core/meetingNotes/summaryHelpers.js` |
| Action-item extraction input cap | **500 000** chars | same |
| Local CPU Whisper cap | **600 s (10 min)** of audio, 10-min timeout | `core/voice/localWhisper.js` |
| Voxtral request timeout | **1 800 000 ms (30 min)** | `routes/transcriptions/shared.js` |
| Stuck "processing" reaper | flips to `failed` after **180 minutes** | `stores/transcriptionStore.js` |
| Detail polling while processing | every **4 s** | `hooks/useTranscription.js` |
| Voice profile clip | min **12 s**, target **25 s**, auto-stop at **28 s**; needs ≥ **6 s** of actual speech; enroll upload ≤ **15 MB**; max **8 enrollments/hour/user** | `core/voice/voiceprintClient.js`, `routes/voiceprints.js` |
| Voiceprints compared per job | max **50** | `core/voice/voiceprintClient.js` |
| Upcoming window | **48 hours** ahead | `routes/transcriptions/gmeet.js` |
| Meet auto-import look-back | default **24 h**, clamped 1–**168 h** | `core/meetingNotes/gmeetNotesSettings.js` |
| Background schedulers | Talk auto-record every **60 s**; Meet auto-import every **120 s** | `core/automationRunner/scheduler/ticks.js` |
| Recording bitrate in the browser | **32 kbps** Opus / **64 kbps** AAC | `hooks/useAudioRecorder.js` |
| Default language | **`nl`** everywhere (upload, Talk auto-transcribe, Meet auto-import) | multiple |
| Talk recordings folder default | **`/Talk/Recording`** | `core/meetingNotes/talkRecordingPaths.js` |
| Auto-record / auto-transcribe / auto-import defaults | **all off** | `talkNotesSettings.js`, `gmeetNotesSettings.js` |
| Per-person insights default | **on** (org can switch off) | `talkNotesSettings.js` |
| Summary template prompt cap | **20 000** chars; name **120** chars | `routes/summaryTemplates.js` |

---

## 7. What happens on failure

- **Upload rejected up front** (bad format / too big) → a 400 with the message, shown as
  **"Upload failed"** with **"Retry"**.
- **Anything after the 202** is written to the note, not to the HTTP response: the note flips to
  `status: 'failed'` and the reason is stored in `summary` as `Transcription failed: …`. The library
  row shows that reason in red; the detail shows **"Transcription failed"** and, when the audio is
  still available, **"Retry transcription"**.
- **Recording too long for the local model** → the server transparently falls back to a configured
  cloud engine and the page shows the soft notice *"Your recording was too long for the on-device
  model — transcribed via {provider} instead."* With no cloud engine configured the message is
  *"…No cloud provider is configured — ask an admin to enable Voxtral, WhisperX or Azure, or split the
  recording."*, and the upload panel offers **"Switch engine & retry"**.
- **Server restarted mid-run** → the note is reaped to `failed` after 3 hours, so the list stops
  spinning.
- **Audio gone** → the payload's `audio` block says `available/durable/recoverable`. Not present but
  a durable copy exists = an outage (recoverable); neither = permanent, and **Re-transcribe** is
  disabled with *"The audio for this meeting is no longer available"*. Object-storage outage on
  reprocess: *"Audio storage is temporarily unavailable. Try again in a minute — your recording is
  safe."*
- **Summary regenerated but artifacts failed** → *"The summary was rewritten, but working out the
  action items, decisions and questions failed — the existing ones were kept."*
- **Delete blocked** → the first DELETE answers **409 `in_use`** with the list of consumers; the UI
  shows them and only a confirmed second call (`?confirm=1`) proceeds. Kinds that could **not** be
  checked count as in use, which is why the dialog can demand you type the title.
- **List load fails** → **"Couldn't load your meetings"** + **"Try again"** (deliberately not the
  empty state).
- **Note not found / lost access** → **"Couldn't load this meeting"** / *"It may have been deleted, or
  you no longer have access to it."*
- **Gate failures**: outside the licence ceiling → HTTP 403 `feature_locked` with an upgrade CTA;
  inside the ceiling but not granted → 403 `feature_disabled` ("ask your admin"); entitlements
  temporarily unresolvable → **503 `entitlement_unavailable`** with `Retry-After: 1`.

---

## 8. Permission and licence gates

Mounts in `server/index.js` (lines 903–921):

```
/api/transcriptions      requireModule('meetingNotes') + requireCapability('meeting_notes')
/api/voiceprints         requireModule('meetingNotes') + requireCapability('meeting_notes')
/api/talk-notes-settings requireModule('meetingNotes') + requireLicenseFeature('meeting_notes')
/api/gmeet-notes-settings requireModule('meetingNotes') + requireLicenseFeature('meeting_notes')
/api/summary-templates   requireModule('meetingNotes') + requireLicenseFeature('meeting_notes')
```

- `meeting_notes` is an **Enterprise** licence feature (`server/license/tiers.js`) — explicitly **not**
  in the Community tier (`tierHasFeature('community','meeting_notes') === false`).
- It is also a **beta feature** (`core/entitlements/betaFeatures.js`: *"Meeting Notes — Audio
  transcription, meeting summaries, and action item extraction"*), so `requireCapability` needs
  **Enterprise licence AND the beta switched on for the org/user**. `license/featureMap.js` records it
  as *"Enterprise tier + beta opt-in"*.
- Frontend gate (`studioApps.jsx`): `hasLicenseFeature('meeting_notes') && canUse('meeting_notes')`;
  the tab is hidden/locked otherwise (`lockOn: 'disable'`).
- **There is no meeting-specific permission in `server/config/orgRoles.json`.** Authorisation inside
  the feature is:
  - `requireAuth` on every route;
  - **owner-only** for rename/edit/delete/reprocess/publish/regenerate/speakers
    (`transcription.isOwner`, i.e. `user_id === session user`);
  - **read ACL** = own rows ∪ legacy per-user shares ∪ published rows in your org filtered by your
    groups; super admins see everything;
  - `isOrgAdminForOrg` for org/group summary templates, the org Talk/Meet settings, and org voiceprint
    coverage/revocation.
- Voiceprints are deliberately narrower: **writes are self-only** (`POST/DELETE /me`, no user id
  anywhere in the route shape), there is **no admin read path** for a template, and enrollment audio
  is never persisted. The router also refuses everything unless **pyannoteAI** is the active engine.
- `voiceprintMatches` is stripped from the note payload for everyone except the owner
  (`routes/transcriptions/shared.js: withInsightsPolicy`), along with `audioPath` / `audioStorageKey`.

---

## 9. How it connects to other features

- **Knowledge bases** — a KB source of kind `meetingTag` collects every meeting carrying a tag
  ("after every meeting" mode). It stores the **summary, decisions and optionally questions/actions —
  never the transcript**, enumerates as the KB's owner, and needs `manage_knowledge` to create.
  Max **500** meetings per pass.
- **Automations / automations** — trigger provider `meeting-notes`, event **`meeting.processed`**
  ("Meeting note ready"), org-scoped, fired on ingest, reprocess and regenerate; filterable on `tags`
  and `reprocessed`. Action items can also *start* an automation as a destination.
- **Datatables** — an action item can be appended as a row with mapped columns.
- **Notebooks** and **Templates/Prompts pages** embed the shared **MeetingPicker** to use a meeting as
  context.
- **Nextcloud Talk** — import, auto-record (moderated calls), auto-transcribe, and
  **"Post summary back into Talk"**.
- **Google Workspace / Meet** — calendar scan for Upcoming, recording harvest from Drive, optional
  pre-configuration of Meet's own auto-recording (needs the `meetings.space.settings` scope).
- **Compliance / data portability** — `GET /:id/export` is stamped as a `meeting_notes` export, and
  meeting notes are an export kind in the DSR registry.
- **Dashboard / global UI** — "Recent meetings" card, the Ctrl+Shift+M palette, Studio recents flyout.
- **App Studio** — a `Meeting dossier` app template exists (`server/appStudio/templates/appMeetingDossier.js`).
- **Mobile (Expo)** — `mobile/src/features/recording/` records and uploads against the same
  `/api/transcriptions` endpoints, with an offline outbox.

---

## 10. Common mistakes

1. **Expecting names without giving names.** Leaving *"Who's in the meeting?"* empty is the single
   biggest cause of "Speaker 1 / Speaker 2" notes. Diarization only separates voices; naming needs a
   roster, a spoken introduction, or a voice profile.
2. **Assuming everyone can see a note.** Notes are personal by default. Colleagues see nothing until
   the owner uses the visibility capsule.
3. **Expecting a shared note to be editable.** A published note is read-only for everyone but the
   owner — rename, speakers, regenerate, reprocess and delete all answer 403.
4. **Thinking a tag chip covers the whole library.** The chips are counted over everything you may
   read (server-side), but the *filter* runs over the loaded page of 50 notes — scroll/paginate for
   older notes.
5. **Closing the tab and assuming the upload died.** Transcription is asynchronous: the note is
   created immediately in `processing` and finishes in the background.
6. **Choosing a wrong language and not noticing.** The language sits behind *"Advanced — …"* and
   defaults to Dutch; an English meeting transcribed as Dutch is a classic.
7. **Deleting a meeting that a knowledge base or automation feeds on.** The 409 guard exists for this; do
   not blindly type the title to get past it.
8. **Expecting voice profiles to exist on any engine.** They only appear when an admin selected
   **pyannoteAI**; on Voxtral/WhisperX/Azure the whole section renders nothing.
9. **Expecting a Teams row in Upcoming.** Only Nextcloud Talk and Google Meet are wired; Teams has no
   meeting-notes source.
10. **Reading a `failed` note's summary as a summary.** A failed note stores its failure reason in the
    summary field; the list surfaces it as `failureReason`, so trust the red status line.
11. **Assuming the automation payload carries the content.** `meeting.processed` gives an id and tags
    only — an automation must fetch the note itself (and only if entitled).
12. **Regenerating and expecting your edits to vanish.** Action items you ticked or edited are kept
    and marked **"kept"** rather than being deleted by a regeneration.

---

## 11. Three scenarios for "Van Dijk Groep" (Dutch SME)

### Procurement — the supplier price review
Bart (inkoop) records the quarterly review with a steel supplier via **Record → Record audio**,
attendees `Bart, Ingrid, leverancier Peeters`, glossary `staalprijs, kwartaalstaffel, Van Dijk Groep`.
Afterwards he renames the speakers, regenerates the summary with the org template **"Leveranciers­review"**,
tags the note `inkoop` and `leverancier-peeters`, and sends the action *"Nieuwe staffelprijzen opvragen
vóór 1 oktober"* to the datatable **Inkoopacties** with Owner and Due date mapped. The `inkoop` tag
also feeds the knowledge base **Inkoop & contracten**, so "wat hebben we met Peeters afgesproken over
de staffel?" is answerable next quarter without opening the note.

### HR — the hiring interview
Mireille (HR) interviews a candidate over Google Meet, with the meeting toggled on in **Upcoming**.
The recording is imported automatically; she regenerates the summary with the built-in **Interview**
template, which yields *Strengths / Concerns / Key Responses / Fit Assessment*. Because interview
notes are sensitive she leaves visibility **Personal** and only shares to the group **Hiring team**.
Per-person insights are switched **off** org-wide by the works council agreement, so the Insights tab
shows meeting-level metrics only. She does **not** create a rule that pushes the summary outward:
outgoing destinations only ever receive a reference.

### Sales — the weekly pipeline call
The sales team records their Tuesday Talk call with **"Auto-transcribe my Talk recordings"** on and
**"Post summary back into Talk"** enabled, so the summary lands in the conversation. Every note is
tagged `sales`. An automation with the trigger **"Meeting note ready"** filtered on `tags: ["sales"]` files
the note into the **Sales** knowledge base and notifies the account managers. At month end, Sandra
selects the four most recent sales notes with **"AI report"** (max 10) and asks *"Welke bezwaren
noemden klanten deze maand het vaakst?"* — the report cites the meetings it used.

---

## 12. List/read API endpoints a "did the learner do it?" check can call

All of these are session-authenticated (`requireAuth`, cookie session) and sit behind
`requireModule('meetingNotes')` + the `meeting_notes` capability/licence gate described in §8.
Base: `/api/transcriptions` unless noted.

| Method + path | Auth | What a row/response contains |
|---|---|---|
| `GET /api/transcriptions?limit=&offset=` | requireAuth + capability | `{ transcriptions: [...] }`. Each row: `id`, `title`, `fileName`, `language`, `durationSeconds`, `speakerCount`, `segmentCount`, `status` (`processing`/`completed`/`failed`), `provider`, `source` (`upload`/`talk`/`talk-auto`/`gmeet`/`nextcloud`), `talkRoomToken`, `meetMeetingCode`, `isPublished`, `sharedGroups`, `tags[]`, `organizationId`, `createdAt`, `updatedAt`, `transcriptSnippet` (2000 chars), `summarySnippet` (400 chars), `actionsTotal`, `actionsOpen`, `failureReason`, **`isOwner`**, **`ownerId`**. Default limit 50, max 100. |
| `GET /api/transcriptions/:id` | requireAuth + capability + read ACL | The full note: everything above plus `fullText`, `transcript`, `summary`, `segments[]`, `speakers[]` (`id`, `speakingSeconds`, `source`), `actionItems[]` (`text`, `assignee`, `due`, `timestamp`, `done`, `destination`), `decisions[]`, `questions[]`, `chapters[]`, `attendees[]`, `sharedWith[]`, `summaryTemplateId`, `summaryTemplateVersion`, `numSpeakers`, `sourceUri`, `readAt`, `audio` (`available`,`durable`,`localOnly`,`storageConfigured`,`recoverable`,`capture`), `perPersonInsights`, `isOwner`, `ownerId`. `voiceprintMatches` only for the owner; `audioPath`/`audioStorageKey` never. 404 if not readable. |
| `GET /api/transcriptions/tags` | requireAuth + capability | `[{ tag, count }]`, count = number of **notes** with that tag within the caller's read ACL, count DESC then tag ASC, max 200 rows. |
| `GET /api/transcriptions/:id/usage` | requireAuth + capability + read ACL | `{ usage: [{ kind: 'kb'|'automation'|'notebook', id, title, role, ownerId?, href? }], unchecked: [kinds] }`. Foreign rows are name-redacted. |
| `GET /api/transcriptions/:id/series-previous` | requireAuth + capability + read ACL (twice) | `{ previous: { id, title, createdAt, summary (≤1200 chars), … } | null }`. |
| `GET /api/transcriptions/:id/export?format=md|txt` | requireAuth + capability + read ACL | Markdown or plain text file (title, date, duration, speakers, summary, action items, transcript). Stamped as a `meeting_notes` data-portability export. |
| `GET /api/transcriptions/:id/audio` | requireAuth + capability + read ACL | The recording itself with byte-range support (`?download=1` forces attachment). |
| `GET /api/transcriptions/nextcloud-talk-recordings[?folder=]` | requireAuth + capability + Nextcloud connection | Talk recordings grouped per conversation: `token`, `name`, recordings with `path`, `kind` (`audio`/`video`), `size`, `lastModified`. |
| `GET /api/transcriptions/nextcloud-audio-files?folder=/Recordings` | same | Audio files in a Nextcloud folder. |
| `GET /api/transcriptions/talk-meetings` | requireAuth + capability | Upcoming Talk meetings with `token`, title, start/end, attendees, `excluded`, `recordReason`, `recordDecided`, tags, `recordedNoteId`, `status`. |
| `GET /api/transcriptions/gmeet-meetings` | requireAuth + capability + Google connection | `{ connection: { googleConnected, meetScopesGranted, hasSettingsScope, needsReauth }, autoImport, autoRecordConfig, count, meetings: [{ eventId, meetingCode, title, start, end, attendees, excluded, tags, recordReason, organizerSelf, recordingControlledByHost, importedNoteId, status }] }`. 48-hour window. |
| `GET /api/transcriptions/gmeet-recordings` | same | Harvestable Meet recordings. |
| `GET /api/transcriptions/gmeet-imports` | same | The background import jobs and their state. |
| `GET /api/summary-templates` | requireAuth + licence | `{ builtins: [{id,name,nameKey,prompt}], custom: [{id, scope, name, prompt, userId, organizationId, groupId, isDefault, version}], defaultTemplateId, canManageOrg, primaryOrgId }`. Built-in ids: `general`, `standup`, `sales`, `interview`, `retrospective`. |
| `GET /api/summary-templates/org` | requireAuth + licence + **org admin** | `{ orgId, templates, groups }`. |
| `GET /api/voiceprints/availability` | requireAuth + capability | `{ available, reason, provider, enrolled, voiceprint, coverage: { enrolled, members }, limits: { minSeconds: 12, targetSeconds: 25, maxSeconds: 28 }, consentVersion }`. |
| `GET /api/voiceprints/me` | requireAuth + capability | The caller's own voiceprint metadata (never the template). |
| `GET /api/voiceprints/org/:orgId/coverage` | requireAuth + capability + org membership/admin | Enrolment counts for the org. |
| `GET /api/talk-notes-settings/user/me` | requireAuth + licence | `{ autoTranscribe, postSummaryBack, recordingFolder, language, autoRecord, autoRecordScope, recordingMode, nextcloudConnected, recordingEnabled }`. |
| `GET /api/gmeet-notes-settings/user/me` | requireAuth + licence | `{ autoImport, autoRecordConfig, importScope, language, lookbackHours, connection: {...} }`. |
| `GET /api/talk-notes-settings/:orgId` / `GET /api/gmeet-notes-settings/:orgId` | requireAuth + licence + org member (PUT needs org admin) | Org-scoped settings, incl. `insightsPerPersonStats`. |

**Best verification checks for a lesson:**
`GET /api/transcriptions` — a new row with `status: 'completed'`, `ownerId === learner`, a non-empty
`summarySnippet`, and `actionsTotal > 0` proves "recorded and processed a meeting".
`GET /api/transcriptions/tags` proves "tagged it". `GET /api/transcriptions/:id` with
`isPublished: true` proves "shared it"; with `summaryTemplateId` set proves "used a template".
`GET /api/summary-templates` with a matching row in `custom` proves "created a template".

Write endpoints (for context, not for verification): `POST /` (multipart `audio`, 202),
`POST /from-nextcloud`, `POST /from-gmeet`, `PATCH /:id`, `PATCH /:id/publish`,
`PATCH /:id/speakers`, `POST /:id/reidentify-speakers`, `POST /:id/regenerate-summary`,
`POST /:id/reprocess`, `POST /report`, `DELETE /:id[?confirm=1]`, `DELETE /:id/filed-lines`,
`PATCH /talk-meetings/:token`, `PATCH /gmeet-meetings/:eventId`,
`POST|DELETE /api/voiceprints/me`, `POST|PATCH|DELETE /api/summary-templates`.

---

## 13. One thing that is built but not reachable

`agent-hub/src/pages/meeting-notes/library/RulesPanel.jsx` (a "Rules" panel that lists the automations
triggered by `meeting.processed`, with an AI "Suggest a rule" helper) is fully written and tested but
is **not imported by any screen** — the Meeting Notes page only renders **Library** and **Upcoming**.
Do not write lesson steps that tell a learner to open a "Rules" tab inside Meeting Notes; rules are
created in the Automations builder with the trigger **"Meeting note ready"**.
