# Fact sheet — Forms (Studio → Forms), audience: builder

Status: **the feature exists and is substantial** (not a stub). Roughly 3.3k lines of frontend in
`agent-hub/src/components/admin/Studio/Forms/` + `agent-hub/src/pages/PublicFormPage.jsx` +
`agent-hub/src/components/forms/PublicFormRenderer.jsx`, and ~2.7k lines of backend in
`server/routes/automation/formPublic.js`, `server/routes/automation/crud.js`,
`server/routes/automation/formsAi.js`, `server/automation/formTriggerContract.js`,
`server/automation/formAudience.js`, `server/automation/formAnswers/*`,
`server/stores/automationStore/forms.js`.

**One correction lesson authors must not get wrong: a Bee Flow form is NOT public today.**
`PUBLIC_FORMS_ENABLED = false` in `server/routes/automation/formPublic.js` (line ~65) puts
`requireAuth` in front of the whole form surface. `/f/<token>` only opens for a **signed-in member of
the organisation that owns the form**, and the browser is redirected to `/app/forms/<token>`
(`agent-hub/src/App.jsx` ~line 106-115). Every anonymous defence (CSRF, honeypot, rate limits,
nonce dedup) is still in the code and still runs, because the flag is meant to be reversible — but
teaching "send this link to a customer" would be wrong.

---

## 1. What the feature is for

A **form** is the front door of a **automation (automation)**. Someone fills a page in; that submission
starts the automation. Optionally every submission is also written as a row into an **answers table**
(a datatable of `managed_kind = 'form_answers'`), which gives the owner a dashboard without building
anything.

The key architectural fact (documented verbatim in `FormsStudio.jsx` and `studioApps.jsx`):

> **A form is not an object of its own in this product.**
> - What the visitor fills in is declared on an automation's **trigger**: `definition.trigger.kind === 'form'`, `definition.trigger.form`.
> - Pages after page one are **`form_page` steps** in the same automation.
> - The public **address** is a row in the `automation_form_pages` table, minted by the server on every save (`ensureFormPages` in `server/routes/automation/crud.js`).

So: three places, one automation. "New form" is really "new automation with a form trigger".

---

## 2. Where it lives (menus and routes — real strings)

| Surface | Real label | Path | File |
|---|---|---|---|
| Studio rail row (category "build") | **Forms** (`sidebar.forms`), description **"Published forms, and what they start"** (`studio.tab.forms_desc`) | `/app/studio/forms` | `agent-hub/src/components/admin/Studio/studioApps.jsx` (descriptor `id: 'forms'`) |
| The builder's directory | header **Forms** + count "**{count} forms**" | `/app/studio/forms` | `Forms/FormsStudio.jsx` |
| One form (builder) | tabs **Questions · Share · Answers · Settings** | `/app/studio/forms/<automationId>[/<tab>]` | `Forms/FormPage.jsx` |
| Sidebar row (consumer) | **Forms**, flyout **All forms** / "Every form published in your organisation" + at most **5** recent forms | `/app/forms` | `agent-hub/src/components/shell/Sidebar.jsx`, `pages/forms/FormsHomePage.jsx` |
| One form, filled in | the rendered form itself | `/app/forms/<token>` (and `/f/<token>` → redirect) | `pages/PublicFormPage.jsx` + `components/forms/PublicFormRenderer.jsx` |
| Universal "New" menu | **Form** (`studio.new.form`) | → `studio/forms/new` | `Studio/NewMenu.jsx` |

**The URL segment is the AUTOMATION id, never the token.** `/app/studio/forms/<automationId>` — the
page token is a credential (192 bits, `crypto.randomBytes(24).toString('hex')` = 48 hex chars) and
deliberately never travels in a route, in history, in Studio search, in recents, in an export or in
a Blueprint.

---

## 3. Every screen, with its real UI copy

### 3.1 Studio → Forms (directory) — `FormsStudio.jsx`

- Heading: **Forms**, with the count chip "**{count} form / {count} forms**".
- Intro paragraph: *"A form is the front of an automation: whoever fills it in starts it. A published form has an address anyone in your organisation can open once signed in, so it belongs to the organisation rather than to one person."*
- Buttons: refresh icon **"Refresh the list"**, primary **"New form"**.
- Each row shows: the title (or **"Untitled form"**), a status pill, optional chips, description, meta line, and actions.
- Status pill (three states, never two):
  - **Live** — hint *"Colleagues in your organisation can fill this in after signing in."*
  - **Not live** — hint *"The automation behind it is paused or still a draft, so the link answers “not available”."*
  - **Status unknown** — hint *"This row did not say whether the form is live. Open the automation to check."*
- Chips: **"collects answers"**; audience chip (owner only) = **"Everyone in the organisation"** / **"Shared with {count} people and groups"** / **"Only you — not shared yet"**.
- Meta: "**{count} submissions**" · "**last {when}**" (absent, never "0", when the row carries no number).
- Row actions: **"Copy the link"** (→ **"Link copied"**, failure **"Could not copy the link — your browser refused clipboard access."**), **"Answers · {count} responses"**, **"Open the automation"**, or the read-only line **"Built by a colleague — only they can open the automation behind it"**.
- Empty state: title **"No forms yet"**, body *"A form is a page the colleagues you share it with can fill in. Create one and it appears here."*
- Load error banner: **"Could not load the forms — this is not an empty list."** + **"Try again"**. (A failed read is deliberately a different screen from an empty list; the count disappears rather than showing 0.)

### 3.2 "New form" dialog — `NewFormDialog.jsx`

- Title **New form**.
- Field **Name** (placeholder `Customer feedback`).
- Fieldset legend **"What happens with the answers?"** with two cards:
  - **"Collect answers in a table"** + badge **Recommended** — *"A table is created with one column per question and kept in step with the form. Every answer appears there the moment someone submits, and whoever the table is shared with sees them on a dashboard."*
  - **"Form that starts an automation"** — *"Every submission starts the steps you build in the automation builder — send an e-mail, file a ticket, ask an agent. No table unless you add one."*
- Only in "collect" mode: **"Describe it (optional)"**, textarea `maxLength={12000}`, placeholder *"What should the form ask? A sentence is enough — or paste the checklist, e-mail or policy it should be based on."*, hint *"AI drafts the questions from this on the next screen. You review them before anything is saved."*
- Buttons **Cancel** / **Create form**. Failure: **"Could not create the form."**
- Nothing is posted until "Create form". The brief is **not** sent with the create — the form is made
  first, the brief is parked under `form:<id>` (`studioAi/handoff.parkSeed`) and the Questions tab
  runs it once on arrival.
- Landing: `collect` → `/app/studio/forms/<id>/questions`; `automation` → `/app/studio/automations/<id>` (the builder).

### 3.3 Form page header — `FormPage.jsx`

- Back link **"All forms"**, renameable title, status chip (Live / Not live / Status unknown).
- Primary button **"Open the form"** (copies the absolute link), an external-link icon **"Open in a new tab"**, and **"Open the automation"** (owner only).
- For a non-owner: chip **"shared with you"**, tooltip *"Shared with this account through its answers table — the questions and settings belong to the form's owner."*
- Tabs: owner sees `questions, share, answers, settings`; a colleague with only the answers table sees `answers` alone.
- Leaving an edited Questions tab asks: **"Unsaved changes"** / *"The questions were changed and not saved. Leave and lose them?"* / **Leave** / **Keep editing**. `beforeunload` is wired too.

### 3.4 Questions tab — `form/QuestionsTab.jsx` + `AiDraftPanel.jsx` + `FormBuilderFields.jsx`

**"Build it with AI" card** (top):
- Title **"Build it with AI"**.
- Intro (blank form): *"Describe the form, or paste what it should be based on — an intake checklist, an e-mail, a policy. The questions are drafted below for you to review; nothing is saved until you save."*
- Intro (existing questions): *"Say what should change. The questions you keep stay as they are — and so do their answers."*
- Segmented control **"What the AI does"**: **"Change the current questions"** / **"Start over from a description"** (hidden while the form is still blank).
- Textarea `maxLength={12000}`; Ctrl/Cmd+Enter runs it. Placeholders: *"e.g. A vacation request: name, department, first and last day, a reason, and whether a colleague covers…"* / *"e.g. add a phone number, make the address optional, shorter labels"*.
- Buttons **"Draft the questions"** / **"Change the questions"** → **"Drafting…"**; then **"{count} questions drafted — review them below, then Save."** and an **Undo**.
- Errors: **"No AI model is set up for this workspace yet."**, **"The AI did not return a usable form. Try again, or describe it more concretely."**, **"Type or paste something first."**, **"Too many drafts in a minute — wait a moment and try again."**, **"Could not draft the questions."**

**The question editor** (`FormBuilderFields`, lazy-loaded, shared with the automation builder):
- **Form title**, **Intro text** ("Shown under the title. Optional."), section **Questions**, **"Add a question"**, **Button text** (placeholder `Submit`), **Thank-you message** ("Replaces the form after a successful submission."), section **Styling**, and **"Preview the form" / "Hide preview"**.
- Empty state inside the editor: *"No questions yet — nobody can submit this form."*
- Per question: `Question {n} label` ("What do you want to ask?"), a type dropdown, **Required** checkbox, `Question {n} placeholder`, **Move question up/down**, remove.
- Field types (exact labels): **Short text, Long text, Email, Number, Date, Dropdown, Checkbox, File upload, Download button, Open in Notebooks**.
  Dropdown adds **"Choices (one per line)"**; File upload adds **"Accepted types"** (`application/pdf,image/*`) and **"Max MB"** (min 1, max 25, default 10).
- Theme presets: **Clean, Corporate, Friendly, Night, Match visitor**; knobs **Corners, Spacing, Text size, Appearance**; 12 accent colour swatches + a custom colour.

**Notes under the editor:**
- If the automation has later pages: *"{count} more pages — edit them in the automation"* + **"Open the automation"**.
- If collecting: *"Every question here is a column in the answers table. Renaming a question renames its column; removing one keeps the column, marked “no longer on the form”."*
- Sticky save bar: **Discard changes** / **Save** → toast **"Saved."**; error **"Could not save the form."**

### 3.5 Share tab — `form/ShareTab.jsx`, `PublicLinkCard.jsx`, `FormAudienceCard.jsx`

Card 1 — **"Link to the form"**
- Blurb (org audience): *"Colleagues in your organisation can open this link after signing in. It only works while the form is live."*
- Blurb (restricted): *"Only the people and groups listed under “Who can fill it in” can open this link, after signing in. It only works while the form is live."*
- The address in a `<code>` block, **Copy the link**, **Open in a new tab**, **New link**.
- **New link** confirm: **"Create a new link?"** / *"The current link stops working immediately — anyone who already has it will see “not available”."* / **Create a new link** / **Cancel**.
- If no token yet: *"The link is being created — save the form once and it appears here."*

Card 2 — **"Who can fill it in"** (the form's **audience**)
- Two radio rows:
  - **"Only the people and groups you choose"** — *"Colleagues you list below, and the members of the groups you list. Nobody else in the organisation — and never anyone outside it."*
  - **"Everyone in the organisation"** — *"Every signed-in colleague with the link. Never anyone outside the organisation."*
- Empty list: *"Nobody yet — only you can open the form. Add the people or groups it is for."*
- **"Add a person or group"** → "A person or a group", "Pick someone…" / "Pick a group…", **Add**; remove with ×.
- Widening asks first: **"Open the form to the whole organisation?"** / *"Every signed-in colleague with the link can then fill it in. The people and groups listed stay listed, for when you narrow it again."* / **Open to everyone** / **Keep the list**.
- Failure: **"Could not change who can fill in the form."**

Card 3 — **"Who can see the answers"**
- *"The answers live in a table. Sharing the table is what shares the dashboard: whoever can read the table can open Answers here and the Dashboard tab on the table."*
- Reuses the datatable's own sharing component; **"Open the table"**.
- No table: *"This form does not collect answers in a table. Switch it on under Settings to share a dashboard."*

### 3.6 Answers tab — `answers/AnswersDashboard.jsx` (+ `RangeBar`, `QuestionCard`, `QuestionBreakdowns`, `ResponseDrawer`)

- Period bar: **Period** with **Today / 7 days / 30 days / 90 days / All / Custom** (+ **From** / **To**); default preset is **30d**. "Updated {when}".
- Four stat tiles: **Responses in this period**, **All time**, **Today**, and either **Last response** (single-page form) or **Completed all pages** with the `completed / inRange` hint (multi-page form).
- **"Responses over time"** bar chart, meta **per day / per week / per month**; refresh button.
- One card per question with the breakdown: **Average / Median / Lowest / Highest** for numbers, **Yes / No** for checkboxes, option bars for dropdowns, **"Most recent answers"** for text, **"{count} files"** + "Open the rows" for file questions, "{n} answered", "{n} skipped", **"See all answers"**. Empty: *"No answers in this period."*
- Retired questions collapse into **"No longer on the form ({n})"**, hint *"Questions removed from the form. Their answers are still in the table."*
- **"Recent responses"** list — time · who (or **Anonymous**) · a preview of the first three answers; clicking opens the **Response** drawer (**"Submitted {when}"**, "by {name}", **"Run {id}"**, **"Open in the table"**, **"Open the run"**, **"Not answered"**).
- **"All responses"** card with **"Export (CSV)"** and **"Open the table"** and the full row browser; a question focus shows *"Showing the responses that answered “{label}”."* + **"Show every response"**.
- Empty: **"No responses yet"** / *"Share the link — the first answer shows up here the moment it is submitted."* + **"Copy the link"**.
- Errors: **"Could not load the answers."** + **Try again**; export failure **"Could not export the responses."**
- No table at all: **"No answers table"** / *"This form starts an automation and does not collect answers in a table."*
- The dashboard **re-fetches every 30 s** while the tab is visible (`useAnswersSummary`, `REFRESH_MS = 30_000`), and again on `visibilitychange`.

### 3.7 Settings tab — `form/SettingsTab.jsx`

- Card **Live**: toggle **"Form is live"**; on → *"Colleagues in your organisation can fill this in after signing in."*, off → *"Switched off: the link answers “not available” and nothing is collected."*; failure **"Could not switch the form on."**
- Card **"Collect answers in a table"**: toggle with the same label; on → *"On — every submission becomes a row in the answers table."*, off → *"Switch on to create a table with one column per question. Earlier submissions are not imported; collecting starts with the next one."*
  - Turning it OFF confirms: **"Stop collecting?"** / *"New submissions no longer land in the table. The table, its rows and its sharing stay as they are."* / **Stop collecting** / **Cancel**.
  - If the table never got made: *"The table is not there yet — save the form once more, or try again."* + **Try again** (calls the provisioning route).
  - If a write failed: **"The last submission could not be written to the table: {message}"**.
- Card **"How long answers are kept"**: *"Answers stay in the table until a retention window is set on it."* + **"Open the table's retention settings"** (→ `studio/datatables/<id>/retention`).
- **Danger zone**: **"Delete this form"**, name confirmation required, notice *"Deleting the form deletes the automation behind it. The answers table is not deleted — remove it under Datatables if the answers are no longer needed."*

### 3.8 The form itself — `/app/forms/<token>` (`PublicFormPage.jsx`)

- Phases: `loading → form → working → form (page N) → done | error | expired`.
- Polls the session: starts at **700 ms**, +200 ms per tick up to **2000 ms**, gives up after **5 minutes** and offers a manual retry.
- The session id is mirrored into `?s=…` so a reload resumes the journey instead of restarting at page one.
- It stamps `data-theme` on `<html>` itself (`:root` in `index.css` is the dark palette), so a "light" form renders light.
- An unknown, paused or renamed form is one indistinguishable **"not found"**.

### 3.9 /app/forms (consumer directory) — `pages/forms/FormsHomePage.jsx`

Heading **Forms**; a grid of tiles (title + description); a tile whose automation is off shows
**"Not live — the automation is paused or still a draft"**. Empty: **"No forms yet"** / *"A form is a page the colleagues it is shared with can fill in. Build one in Studio and it will appear here."* Error: the message + **Retry**.
Only rows where `canOpen !== false` are shown — i.e. the forms this person may actually fill in.

---

## 4. Concepts a learner must understand

- **Form** — a page of questions declared on an automation's trigger (`trigger.kind: 'form'`). Not a standalone document; it belongs to an automation.
- **Automation (automation)** — the steps that run when the form is submitted. A "collect only" form has a trigger and no steps; that is legitimate.
- **Form page (the token row)** — the row in `automation_form_pages` whose `id` **is** the URL token. 48 hex characters / 192 bits, the whole credential, no second factor. Rotating = new row, old link 404s instantly.
- **Live** — `isActive && !isDraft` on the automation. A newly created automation is a **draft**; until it is switched on the link answers "not available". `live` is three-valued in the UI because an absent flag is not a claim.
- **Audience** — who may *fill the form in*: `org` (every signed-in member of the owning organisation) or `restricted` (the owner + listed users + members of listed groups). Never anyone outside the organisation, whatever is chosen. **A new form page is created `restricted` with nobody on it** (`createFormPage` default) — only the owner can open it until someone is added.
- **Answers table** — a datatable with `managed_kind = 'form_answers'`, one row per submission. Two fixed columns `run_id` ("Run") and `completed_at` ("Completed") plus one per input question. Columns are derived from the definition on every save; `source.columnMap` is the map.
- **Retired column** — a question removed from the form keeps its column, flagged `retired`. Re-adding the same name+type un-retires it. Retyping a question makes a *new* column (the id hashes page-step-id + name + type code); the old one is retired, never dropped. Only the table owner can delete a retired column by hand.
- **Grade** — the datatable access ladder (`owner` / `editor` / `viewer`). Sharing the answers table is what shares the Answers dashboard; a colleague with a grade sees the Form page's Answers tab and nothing else.
- **`mine`** — whether *this* caller owns the automation behind the form. The list is org-wide, but `/api/automation/:id` is still per-user, so only the owner can open the automation, edit questions, change the audience or delete.
- **Multi-page journey** — an automation may pause at a `form_page` step; the visitor stays on the same URL and their browser polls a **session** (192-bit session id, TTL **8 hours**) until the next page or the closing page appears. One journey = one run chain; the answers row is the same row all the way through.
- **Display field** — `download` and `notebook` fields give the visitor a file a `generate_document` step produced. They collect nothing, are never required, and **cannot go on page one** (there is no run yet to have made the file).
- **Collect** — `trigger.form.collect === true`. That single boolean decides whether the answers table exists and follows the form.

---

## 5. End-to-end workflows (click by click)

### W1 — A collecting form, drafted by AI, in one sitting
1. Sidebar → **Studio** → rail → **Forms**.
2. Click **New form**.
3. Type a **Name** (e.g. "Leveranciersintake").
4. Leave **"Collect answers in a table"** selected (it is the Recommended default).
5. In **"Describe it (optional)"** paste the intake checklist or type a sentence.
6. Click **Create form** → you land on `/app/studio/forms/<id>/questions` and the AI draft runs once by itself.
7. Read **"{n} questions drafted — review them below, then Save."** Adjust labels/types in the editor (or click **Undo** to get the previous questions back).
8. Click **Save** → toast **"Saved."** The answers table is created/updated on that same save.
9. Go to the **Settings** tab and switch **"Form is live"** on.
10. Go to **Share** → **"Who can fill it in"** → add the people or groups (a new form is shared with **nobody**), then **Copy the link** and send it to those colleagues.

### W2 — A form that starts an automation (no table)
1. Studio → **Forms** → **New form**.
2. Name it, choose **"Form that starts an automation"**, click **Create form**.
3. You land in the **automation builder** (`/app/studio/automations/<id>`), not the Form page.
4. Open the trigger node and edit the form there (same editor: title, Questions, Add a question, Button text, Thank-you message, Styling, Preview the form).
5. Add the steps that should run — `notification` (e-mail), an approval, an `ai_step`, a datatable write, an integration action.
6. Activate the automation in the builder (or via the Form page's **Settings → Form is live**).
7. Back in Studio → **Forms** the row now shows **Live**; use **Copy the link**.

### W3 — Watching the answers and exporting them
1. Studio → **Forms** → click **Answers · {n} responses** on the row (or open the form and pick the **Answers** tab).
2. Set **Period** (default **30 days**; presets Today / 7 days / 30 days / 90 days / All / Custom).
3. Read the four tiles and **"Responses over time"**.
4. Scroll the per-question cards; click **"See all answers"** on one to filter the **All responses** table to the people who answered it.
5. Click a row under **"Recent responses"** to open the **Response** drawer; from there **"Open in the table"** or **"Open the run"**.
6. Click **"Export (CSV)"** to download every response.

### W4 — Sharing the results with a colleague who must not edit the form
1. Open the form → **Share** tab.
2. Under **"Who can see the answers"**, click **"Open the table"** or use the sharing control in place to grant the colleague a grade on the answers table (viewer is enough).
3. The colleague now sees the form in Studio → Forms and can open it — but the Form page shows **only the Answers tab**, the chip **"shared with you"**, and the line **"Built by a colleague — only they can open the automation behind it"** on the directory row.

### W5 — Rotating a leaked link
1. Open the form → **Share** tab → card **"Link to the form"**.
2. Click **New link**.
3. Confirm **"Create a new link?"** → **Create a new link**.
4. The old address answers "not available" from that moment; the audience is carried over to the new row.
5. Re-send the new address to the people who need it.

### W6 — Turning collection off / retiring the form
1. Open the form → **Settings**.
2. Toggle **"Collect answers in a table"** off → confirm **Stop collecting** (the table, its rows and its sharing stay).
3. To take it off the air, toggle **"Form is live"** off (link answers "not available"; nothing is collected).
4. To remove it entirely: **Danger zone → "Delete this form"**, type the name, confirm. The automation goes; the **answers table stays** — delete that separately under Studio → Datatables if the answers are no longer needed.

---

## 6. Defaults and limits (the numbers)

**Form declaration** (`server/automation/formTriggerContract.js`)
- `MAX_FIELDS` = **40** questions per page.
- `MAX_LABEL_LEN` = **120** (title, field label, submit label, option label).
- `MAX_TEXT_LEN` = **2000** (description, success message, as authored).
- `MAX_RENDERED_DESCRIPTION_LEN` = **20000** (a closing page's interpolated text).
- `MAX_PLACEHOLDER_LEN` = **120**; `MAX_OPTIONS` = **50**; `MAX_OPTION_LEN` = **120**.
- `MAX_TEXTAREA_LEN` = **20000** for a long-text answer.
- Uploads: `DEFAULT_UPLOAD_MB` = **10**, `MAX_UPLOAD_MB` = **25** (an author may lower, never raise).
- Field name grammar: a letter then letters/digits/underscores, max 60 chars, may not start with `_`; names must be unique per page (that is what `trigger.output.<name>` binds to).
- Defaults of a brand-new form (`defaultFormDeclaration`): title **"Get in touch"**, submit **"Submit"**, success **"Thanks — we got your answer."**, three fields `name` (Your name, required), `email` (Your email, required), `message` (How can we help?), theme preset **Clean** (`#0F766E`).

**Public/visitor surface** (`server/routes/automation/formPublic.js`)
- `PUBLIC_FORMS_ENABLED` = **false** → `requireAuth` on the whole router.
- Rate limits per minute: **60** per IP (`AUTOMATION_FORM_RPM_PER_IP`), **120** per token (`..._PER_TOKEN`), **12** uploads (`AUTOMATION_FORM_UPLOAD_RPM`), **300** session polls (`AUTOMATION_FORM_POLL_RPM`).
- `MAX_SUBMISSION_BYTES` = **256 KB** (files go through the separate upload call).
- `MIN_FORM_AGE_MS` = **2000 ms** — a faster post is silently accepted and does nothing.
- Honeypot field name: `website_url` — filled ⇒ silent 200.
- Upload quota per form per rolling hour: **40 files** / **200 MB**; unclaimed uploads are reaped after **6 hours** (`UPLOAD_TTL_MS`).
- Token shape: `/^[a-f0-9]{24,64}$/`, minted as 24 random bytes = 48 hex chars.
- Session id: same shape; session TTL **8 hours** (`SESSION_TTL_MS`).
- Per-automation FIFO queue depth **25**; a fuller queue answers 503 *"This form is busy right now — please try again in a moment."*
- A submission answers **202** `{ accepted: true, sessionId }`.

**AI drafting** (`server/routes/automation/formsAi.js`)
- Rate limit **10 calls per minute per user**; `MAX_TOKENS` = **4000**; temperature **0.3**; model = the workspace's **fast tier** (`resolveModelForTier('tier:fast')`).
- Brief/note are truncated to `MAX_BRIEF_CHARS` / `MAX_NOTE_CHARS` (`server/automation/formDraft.js`); the client's textareas cap at **12000** characters; at most **60** current fields travel in revise mode.
- **Nothing is stored** — the draft lands in the unsaved editor. One usage row is logged (`agent_name: 'form-ai'`, `source: 'form_ai_draft'`).

**Answers table** (`server/automation/formAnswers/*`, `core/dataEngine`)
- Fixed columns: `run_id` ("Run", text) and `completed_at` ("Completed", datetime).
- Table name: `Answers — <form title>`; description warns *"Answers people gave on a form, one row per submission… treat it as personal data."*
- `subjectColumn` = the first non-retired **email** question (the GDPR data-subject column).
- Retention: **off by default** (`retentionDays: null`), retention field `created_at`.
- Datatable quotas: **50** tables per scope, **100 000** rows per table, **500 000** rows per scope. Exceeding them is a 409 `quota_exceeded`.
- Dashboard: recent list and question previews are capped server-side; the dashboard refreshes every **30 s**.

**Validation stages**
- A newly created automation is a **draft** (`isDraft` defaults true) and validated at `stage: 'draft'`, so a half-built form saves.
- `form.incomplete` (no fields) is a **completeness** code: a warning at draft stage tagged `blockedAt: 'activate'`, and a blocking error on activation. **A form with no questions cannot go live.**

---

## 7. What happens on failure

| Failure | What actually happens |
|---|---|
| Token unknown / automation paused / draft / trigger no longer a form / caller not admitted | one indistinguishable **404 "Not found"** — probing cannot tell them apart |
| Caller outside the audience | also 404 (not 403), by design |
| CSRF missing or stale | 403 *"This form expired — reload the page and try again."* |
| Honeypot filled or submitted < 2 s after load | **200 `{accepted:true}`**, nothing runs |
| Duplicate nonce (double-click, refresh-resubmit) | 200 `{accepted:true, duplicate:true}` |
| A field fails coercion | 400 *"Some answers need attention"* with a per-field `fields[]` list |
| Body > 256 KB | 413 *"That submission is too large"* |
| File bigger than the field's `maxSizeMb` | 413 *"That file is larger than {n} MB"* |
| File fails the malware scan | 422 *"That file failed a malware scan"* — the bytes are deleted, no ledger row |
| Form upload quota exceeded | 429 *"This form has received too many files recently…"* |
| Storage down | 503 *"File storage is not available"* |
| Queue full (25 waiting) | 503 *"This form is busy right now — please try again in a moment."* |
| The answers table refuses (quota, deleted, lost grade) | **the submission still succeeds and the run still starts**; the reason is written to `source.lastWriteError` and shown on Settings as *"The last submission could not be written to the table: {message}"* |
| Table provisioning failed on save | the save succeeds; `answers.error` rides back; Settings shows *"The table is not there yet — save the form once more, or try again."* with a **Try again** button → `POST /forms/:id/answers-table` |
| Provisioning on a form that does not collect | 409 `collect_disabled` |
| Automation run errors mid-journey | the visitor's poll returns an error phase; for a collecting form the row is still marked completed (`success` **or** `error` both finish the journey) |
| Run slower than 5 minutes | the page stops polling and offers a manual retry |
| `GET /api/automation/forms` returns a non-2xx or a body that is not `{ forms: [...] }` | error banner, the previous list is kept, the count disappears — never "No forms yet" |
| AI draft fails | 502 `ai_unusable` / 503 `no_model` / 429 — the form is untouched, the box keeps its text |

---

## 8. Permission and licence gates

**Server (the whole automation API, forms included)** — `server/index.js:716`:
```
app.use('/api/automation', requireModule('automation'), requireLicenseFeature('automations'), require('./routes/automation'));
```
then inside `server/routes/automation.js`: `requireAuth` → `requireBetaFeature('automations')` → `requireActiveOrgForMutations()`.
`server/routes/automation/formPublic.js` is mounted **before** `requireAuth` (it is the "public" surface) but installs its own `router.use(requireAuth)` while `PUBLIC_FORMS_ENABLED === false`.

**The forms routes carry no extra licence gate of their own** — one entitlement, one lock. Note it is
`requireBetaFeature('automations')` (admins toggle it per organisation in admin → Security → Beta; super admins always pass), **not** a per-route permission.

**Frontend gate** (`studioApps.jsx`, Forms descriptor):
```js
gate: ({ hasLicenseFeature, canUse }) => hasLicenseFeature('automations') && canUse('automations'),
gateCapability: 'automations',
lockOn: 'disable',
```
The same pair gates the sidebar's consumer Forms row (`useStudioSectionData.js`: `canSeeForms = hasLicenseFeature('automations') && makeCanUse(user)('automations')`).

**Row-level authority (not a role, an ownership/grant rule):**
- `GET /api/automation/forms` and `GET /api/automation/forms/:automationId` are **organisation-scoped** — everyone in the org sees the directory.
- `definition` travels **only to the owner** (`mine === true`).
- `PUT /forms/:automationId/audience`, `POST /forms/:automationId/answers-table`, `POST /:id/form/:token/rotate`, `PUT /api/automation/:id`, `POST /:id/activate|deactivate`, `DELETE /api/automation/:id` — **owner only** (403 Forbidden otherwise).
- The Answers dashboard is gated by the **datatable grade ladder** (`requireDatatableGrade('viewer')`), i.e. by sharing the answers table.
- `server/config/orgRoles.json` has `manage_automations` in the admin permission set, but the forms routes check **ownership**, not that permission.

---

## 9. How Forms connects to the rest of the product

- **Automations / Automations** — the form *is* an automation's trigger. "Open the automation" goes to `/app/studio/automations/<id>`. Multi-page forms are `form_page` steps; the closing page is a `form_page` with `mode: 'ending'`.
- **Datatables** — the answers table is an ordinary datatable with `managedKind: 'form_answers'`: sharing, retention, row browser, CSV export, the Dashboard tab and the "used by" index all come from there. Deleting the form does not delete the table.
- **Notebooks** — the `notebook` display field and the closing page's "Save to Notebook" button.
- **generate_document** — feeds `download` / `notebook` fields on later pages via `{{steps.<id>.output.fileId}}`.
- **Approvals** — an automation can pause for an approval mid-journey; the visitor's session follows the newest run in the chain, so an owner approving from the run history continues the journey correctly.
- **Studio counts / sidebar flyout** — `GET /api/studio/counts` returns a `forms` count built with exactly the same de-duplication as the directory; the sidebar flyout lists at most 5 recent forms.
- **LLM stack** — "Build it with AI" uses the workspace's fast-tier model via `core/llm/llmClient.chatForcedTool` and logs usage.
- **Uploads / guard** — file answers go through `middleware/uploadGuard` + a malware scan, and their text is extracted (`describeClaimedUpload`) so an `ai_step` can read `trigger.output.<field>.text`.
- **Compliance** — the answers table carries `subjectColumn`, `lawfulBasis` and retention; CSV export is stamped by `compliance/dataPortability/stampExport`.

---

## 10. Common mistakes

1. **"Send the link to a customer."** Forms are signed-in, organisation-only today. `/f/<token>` redirects to `/app/forms/<token>` and an outsider gets login, then 404.
2. **Creating the form and stopping.** A brand-new automation is a **draft**: the row says **Not live** and the link answers "not available". You must switch **Settings → Form is live** on (or activate the automation).
3. **Forgetting the audience.** A new form page is `restricted` **with nobody on it** — even a colleague with the link gets 404 until you add them (or switch to "Everyone in the organisation"). The directory chip says **"Only you — not shared yet"**.
4. **Expecting "collect answers" to backfill.** Switching collection on starts with the **next** submission: *"Earlier submissions are not imported."*
5. **Renaming vs. removing a question.** Renaming a *label* renames the column (the field `name` is the identity). Removing a question **retires** its column; changing its **type** creates a new column and retires the old one. Nothing is ever dropped automatically.
6. **Deleting the form to delete the answers.** Deleting the form deletes the automation only; the answers table survives under Datatables.
7. **Sharing the form instead of the answers.** "Who can fill it in" (audience) and "Who can see the answers" (the table's grants) are two different controls. A colleague with only a table grade sees the Answers tab and nothing else.
8. **Putting a Download button on page one.** Refused (`field_download_on_trigger`): the document does not exist until a step has made it — it belongs on a later Form page step.
9. **Assuming a failed table write loses the submission.** It does not; the run still starts and the reason appears on Settings.
10. **Treating the URL token as an id.** It is a credential. It never goes in a route, an export, a Blueprint or a ticket; use the automation id (`/app/studio/forms/<automationId>`).
11. **Reading "0 forms" from a failed load.** The directory deliberately hides the count when the read failed — *"Could not load the forms — this is not an empty list."*
12. **Saving the AI draft blind.** The draft only lands in the unsaved editor; it is **Undo** / **Discard changes** until you press **Save**. On a collecting form an unreviewed save can retire columns.
13. **>40 questions on one page.** Split it over `form_page` steps instead (`fields_too_many`).

---

## 11. Three scenarios for "Van Dijk Groep" (Dutch SME)

### S1 — Procurement: *Leveranciersintake* (supplier onboarding)
Purchasing wants every new supplier to hand over the same details before a first order.
- Studio → Forms → **New form**, name "Leveranciersintake", keep **Collect answers in a table**, brief: *"Bedrijfsnaam, KvK-nummer, BTW-nummer, contactpersoon, e-mail, telefoon, IBAN, betalingstermijn in dagen, upload van het KvK-uittreksel, en of ze ISO 9001 hebben."*
- **Create form** → the AI draft fills in ~10 questions (text, email, number, file upload, checkbox) → review labels in Dutch → **Save**.
- Settings → **Form is live**; Share → audience **restricted**, add the group *Inkoop* and the two account managers; **Copy the link** into the supplier-onboarding e-mail template (colleagues paste supplier data on the supplier's behalf, since the form is internal today).
- Answers → the table gives Inkoop a live list; export CSV into the ERP. Set a retention window on the table (Settings → *"Open the table's retention settings"*) because KvK uittreksels are personal-data-adjacent.

### S2 — HR: *Verlofaanvraag* (leave request) with an approval
- **New form**, name "Verlofaanvraag", choose **Form that starts an automation** (the point is the approval, not a spreadsheet) — or choose collect and add the steps later.
- Questions: naam (short text), afdeling (dropdown: Kantoor / Werkplaats / Buitendienst), eerste dag (date), laatste dag (date), reden (long text, optional), vervanger geregeld (checkbox).
- In the builder add an **approval** step assigned to the team lead, then a `notification` e-mail to the applicant, then a datatable write into a leave register.
- Share → audience **"Everyone in the organisation"**; pin the link in the intranet.
- Multi-page variant: a second `form_page` step that only appears for long absences, and a closing page with a **Download button** bound to the `generate_document` step that produces the signed leave confirmation.

### S3 — Sales: *Offerteaanvraag* qualification from the website
- **New form**, "Offerteaanvraag", **Collect answers in a table**, brief pasted from the current qualification checklist.
- Theme preset **Corporate** with the Van Dijk accent colour; Button text "Aanvraag versturen"; Thank-you message "Bedankt — we nemen binnen één werkdag contact op."
- Because forms are internal-only today, the receptionist and the inside-sales team fill it in during the intake call; audience = group *Sales*.
- Add an `ai_step` in the automation that scores the lead and writes the score back, and an integration action that files the lead.
- Answers dashboard: Period **30 days**, watch **Responses in this period** and the dropdown breakdown per productgroep; **Export (CSV)** every Monday for the sales meeting; open a single **Response** drawer to jump to the run that scored it.

---

## 12. List/read API endpoints a "did the learner do it" check can call

All of these are under `app.use('/api/automation', requireModule('automation'), requireLicenseFeature('automations'), …)` or `app.use('/api/datatables', requireModule('automation'), requireAuthedUser, requireLicenseFeature('automations'), …)`, and all require a **session cookie** (plus the `automations` beta feature for the automation ones). Verified in `server/routes/automation/crud.js`, `server/routes/datatables.js`, `server/routes/studio/counts.js`.

| Method + path | Auth / scope | What a row contains |
|---|---|---|
| `GET /api/automation/forms` | session; **org-scoped** (every form in the caller's organisation) | `{ forms: [ { id (the URL token), url ("/f/<token>"), automationId, triggerStepId, title, description, live, submissions, lastSeenAt, createdAt, mine (owner flag), canOpen, audience: { mode, groups?, users? }, answers: { collecting, datatableId, grade, rowCount, linked, lastWriteError } } ] }` — **owner field = `mine`** (true only for the automation's owner); `audience.groups/users` only for the owner |
| `GET /api/automation/forms/:automationId` | session; org-scoped, 404 outside it | `{ form: { …all of the above, plus isActive, isDraft, questions: { title, description, submitLabel, successMessage, collect, fields[], theme }, pages: [{ stepId, label, mode, fields[] }], and — owner only — definition, automationTitle } }` |
| `GET /api/automation` | session; **per-user** (the caller's own automations) | `{ automations: [ { id, title, description, definition, isActive, isDraft, triggerType, userId, organizationId, … } ] }` — optional `?triggerProvider=&triggerEvent=` filter |
| `GET /api/automation/:id` | session; **owner only** | the single automation (definition included) — use it to assert `definition.trigger.kind === 'form'` and `trigger.form.collect` |
| `GET /api/automation/:id/forms` | session; owner | that one automation's form-page rows (`listFormPages`) |
| `GET /api/studio/counts` | session (`requireAuthedUser`) | `{ counts: { forms, automations, runs, datatables, apps, … } }` — the `forms` count uses the same de-dup as the directory and is gated on module+licence |
| `GET /api/datatables` | session; the caller's scopes, filtered by grade | `{ datatables: [ { id, name, key, description, rowCount, managedKind ('form_answers' for an answers table), source (public projection, incl. automationId), retentionDays, subjectColumn, **ownerUserId**, scopeKind, grade, usageCount, updatedAt } ], scope }` |
| `GET /api/datatables/:id` | session; `requireDatatableGrade('viewer')` | `{ datatable: { …same shape, with `grade` for this caller } }` |
| `GET /api/datatables/:id/answers/summary?from=&to=` | session; `requireDatatableGrade('viewer')` + must be a managed (answers) table | `{ table: { id, name, rowCount, retentionDays }, range: { from, to, bucket }, totals: { all, inRange, last7d, today, completed, open, lastAt }, timeline: [ { bucket, n } ], questions: [ { fieldId, key, label, retired, pageStepId, … } ], recent: [ { rowId, submittedAt, completedAt, runId, by: { id, name }, preview } ], form: { automationId, title, live, url, linked, mine } }` — `recent[].by.id` and `form.mine` are the owner-ish fields |
| `GET /api/datatables/:id/rows` | session; `requireDatatableGrade('viewer')` | the raw answer rows (each carries `run_id`, `completed_at`, `created_at`, `created_by` = the submitter) |
| `GET /api/datatables/:id/rows.csv` | session; `requireDatatableGrade('viewer')` | CSV export (stamped by the data-portability middleware) |
| `GET /api/datatables/:id/grants` | session; `requireDatatableGrade('viewer')` | who the answers table is shared with — the check for "did they share the results" |

Write endpoints, for completeness (not for verification): `POST /api/automation` (create), `PUT /api/automation/:id` (save the questions — the Form page saves the whole definition through this), `POST /api/automation/:id/activate` / `/deactivate` (the Live toggle), `DELETE /api/automation/:id`, `PUT /api/automation/forms/:automationId/audience`, `POST /api/automation/forms/:automationId/answers-table`, `POST /api/automation/forms/ai/draft`, `POST /api/automation/:id/form/:token/rotate`, `DELETE /api/automation/:id/form/:token`.

Visitor-side (signed-in today, token-keyed): `GET /api/automation/form/:token`, `POST /api/automation/form/:token/upload`, `POST /api/automation/form/:token`, `GET|POST /api/automation/form/:token/s/:sid`, `GET /api/automation/form/:token/s/:sid/file/:fileId`, `POST /api/automation/form/:token/s/:sid/notebook`.

---

## 13. Key source files

- `agent-hub/src/components/admin/Studio/Forms/FormsStudio.jsx` — the directory (and the `formLiveness` / `publicFormPath` / `canOpenForm` helpers)
- `agent-hub/src/components/admin/Studio/Forms/FormPage.jsx` — tabs and header
- `agent-hub/src/components/admin/Studio/Forms/NewFormDialog.jsx` — the create dialog
- `agent-hub/src/components/admin/Studio/Forms/form/{QuestionsTab,ShareTab,SettingsTab,PublicLinkCard,FormAudienceCard,AiDraftPanel,useFormDetail}.{jsx,js}`
- `agent-hub/src/components/admin/Studio/Forms/answers/{AnswersDashboard,QuestionCard,QuestionBreakdowns,ResponseDrawer,RangeBar,useAnswersSummary,answersRange}.{jsx,js}`
- `agent-hub/src/components/automation/Builder/flow/settings/FormBuilderFields.jsx` — the shared question editor (field types, theme presets, `defaultFormDeclaration`)
- `agent-hub/src/pages/PublicFormPage.jsx`, `agent-hub/src/components/forms/PublicFormRenderer.jsx`, `agent-hub/src/pages/forms/FormsHomePage.jsx`
- `agent-hub/src/hooks/useAutomationApi.js` — `listOrgForms`, `getForm`, `setFormAudience`, `provisionAnswersTable`, `draftForm`, `rotateFormPage`
- `server/routes/automation/crud.js` — `GET /forms`, `GET /forms/:automationId`, `PUT /forms/:id/audience`, `POST /forms/:id/answers-table`, `ensureFormPages`, `ensureAnswersTable`
- `server/routes/automation/formPublic.js` — the visitor surface and every limit
- `server/routes/automation/formsAi.js` + `server/automation/formDraft.js` — "Build it with AI"
- `server/automation/formTriggerContract.js`, `server/automation/formAudience.js`, `server/automation/formAnswers/{derive,provision,write,summary}.js`
- `server/stores/automationStore/forms.js` — the token row, audience defaults, sessions, upload ledger
- `server/routes/datatables.js` (~line 2100) — `GET /:id/answers/summary`, `POST /:id/aggregate`, retired-column delete, "release"
- Tests worth reading: `server/routes/automation/crud.forms.test.js`, `formPublic.test.js`, `formsAi.test.js`, `formAnswers.integration.test.js`, `agent-hub/src/components/admin/Studio/Forms/*.test.jsx`
