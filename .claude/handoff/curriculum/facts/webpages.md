# Fact sheet — Studio → Webpages (audience: builder)

Source of truth read for this sheet (all paths relative to the repo root):
`agent-hub/src/pages/WebpagesPage.jsx`, `agent-hub/src/pages/webpages/*`,
`agent-hub/src/components/shared/VisibilityCapsule.jsx`,
`agent-hub/src/components/agents/AgentWizard/pickers/ExternalShareSection.jsx`,
`server/routes/webpages.js`, `server/routes/webpagesGrants.js`, `server/routes/webpagesAudience.js`,
`server/routes/webpagesUsage.js`, `server/routes/webpagesPreview*.js`, `server/routes/webpageExport.js`,
`server/routes/publicViewer.js`, `server/routes/ai/webpageChat.js`, `server/stores/webpage/*`,
`server/core/webpages/bfElements.js`, `server/integrations/webpageFramework.js`,
`server/index.js`, `server/license/tiers.js`, `server/core/entitlements/*`.

> **Naming warning for lesson authors.** In this repo "CMS" is **not** Studio → Webpages.
> `server/routes/cms*.js` + `agent-hub/src/components/admin/product-website/` are the
> **product-website CMS** (the marketing site at beeflow.nl), mounted at `/api/cms`, admin-only
> (`requireAdmin`, analytics even `requireSuperAdmin`). Studio → Webpages is a different feature
> and is what this sheet documents. Do not teach them as one screen.

---

## 1. What the feature is for

A **Webpage** is an AI-built, self-contained little web app that lives inside Bee Flow. The builder
describes what they want in a chat; the AI writes the code; the page can read and write the org's
datatables, run the owner's automations, call the owner's connected apps, keep its own little SQLite
database, and talk to an agent. It can then be shown to colleagues inside Bee Flow (organisation /
groups) or put on a public address for people who have no Bee Flow account at all.

The beta-catalog description (`server/core/entitlements/betaFeatures.js:126`) is the product's own
one-liner: *"AI-built full-stack web apps. Vanilla (HTML/CSS/JS) or React + Material UI projects with
a real per-page database, a sandboxed acts-as-author backend (integrations + automations), live
preview, auto-versioning, KB-grounded AI chat, publishing/sharing, and ZIP download."*

Studio nav entry (`agent-hub/src/components/admin/Studio/studioApps.jsx:526-552`):
label **"Webpages"**, description **"Design and publish public webpages"**, group **Build**,
URL `/app/studio/webpages`, create action **"New → Webpage"** → `studio/webpages/new`.

---

## 2. Screens and their real labels

### 2.1 Overview — Studio → Webpages (`WebpagesList.jsx`)

* Header row: back arrow **"Back to Studio"**, title **"Webpages"**, a plain count of pages, a 220 px
  search box with placeholder **"Search…"**, and the primary button **"+ New webpage"**.
* **Build bar** (card at the top): sparkles icon, one text field with aria-label
  **"Describe the page you want"** and placeholder
  *"Describe the page — e.g. "a status page where customers enter their quote number and see the
  progress from table Quotes""*, a source chooser button **"Pick a source"**, and a submit button
  **"Build"** (**"Building…"** while in flight).
  – The chooser lists two sections: **"Tables"** and **"Automations"**; empty state
  **"No tables or automations to pick yet."**; failure **"Could not load your tables and automations."**
  – Picked sources appear as removable chips (remove label: *"Remove {name}"*).
  – **Accuracy note:** today `WebpagesPage.jsx` does **not** pass an `onBuild` handler to the list, so
  the Build button stays disabled and clicking **"+ New webpage"** opens the **"All options"**
  disclosure instead of focusing the brief. The server endpoint for describe-to-build
  (`POST /api/webpages` with `{name?, prompt, sources}`) is fully implemented. Teach the name-first
  path as the reliable one.
* **"All options"** disclosure → text field placeholder **"New webpage name…"**, button **"Create"**,
  hint **"Creates an empty page you can describe later in its chat."**
* **Cards** (grid of 3): 150 px rendered thumbnail (or the page emoji, default 🌐), a visibility badge
  top-right (**"Public"**, **"Personal"**, **"Entire organisation"**, or *"N groups" / "1 group"*),
  hover actions top-left **"Edit in IDE"**, **"Duplicate"**, **"Delete"**, then name (double-click to
  rename — tooltip **"Double-click to rename"**), relative time, tagline, and link pills for bound
  tables/automations (max 3 + "+N").
* Last cell is dashed: **"Start from an example"** with four clickable presets —
  **"Status page on a table"**, **"Intake form → automation"**, **"Dashboard on an automation run"**,
  **"Chat with an agent"** (they fill the build bar; they are prompt presets, not templates).
* Search with no hits: **"No matches"** / **"Try a different search."**
* Feature off: **"Webpages disabled"** — *"Webpages isn't enabled for your account. Ask an admin to
  enable Webpages for your organization, and verify your plan includes it."*

### 2.2 Editor header (`WebpageEditorHeader.jsx`) — one 48 px row

Back arrow **"Back to list"** · page name (inline rename, owner only) · save chip
(**"Saved 2m ago"** / **"Saving…"** / **"Save failed — retry"**) · tab strip · audience capsule ·
status pill · extras.

Tabs (`WEBPAGE_TABS`): **Preview**, **Data & links**, **Code**, **History**, **Used by**.
*Code and History are owner-only and are not rendered at all for a viewer.*
Extras: **"Add image"** (owner only) and **"Download ZIP"**.
Status pill: **Draft** + action **"Publish"** (title: *"Choose who can see this page"*) or
**Published** + action **"Republish"** (title: *"Freeze the current version for the people who can
already see this page"*). When a live public link exists, a **"Public"** marker is shown left of the
capsule (tooltip *"Anyone with the link can open this page"*).

Capsule (`VisibilityCapsule`): heading **"Publish to…"**, *"Choose who can see this."*, rows
**"Personal" / "Only you can access"**, **"Entire organisation" / "All members can access"**,
**"Or specific groups"**, plus the external-share section: **"External link"**, **"+ New link"**,
**"Who can access this link?"** → **"Anyone with the link"**, **"Password-protected"**,
**"Email-gated (one-time link)"**, **"Expires"** (1 day / 7 days / 30 days / 90 days / No expiry),
**"Create link"**, then **"Share link created."** + **"Copy"**.
Widening the audience asks first: **"Share more widely?"** / **"Share"** / **"Keep as is"**.

### 2.3 Preview tab (`WebpagePreview.jsx`)

Toolbar: **"Preview"**, **"Running shielded"** (tooltip *"The page runs in an isolated frame: it
cannot reach your session, your cookies, or the app around it."*), **"Preview width"** →
**"Desktop"** / **"Mobile"**, **"Reload"**, **"Open"** (new tab). Selecting text in the preview creates
a chip **"Selection from preview"** above the chat box.

### 2.4 Data & links tab (`WebpageDataTab.jsx`)

Segmented sub-nav (aria-label **"Data surfaces"**): **Overview** · **Actions** · **Who can see it** ·
**Sources** (with a count badge) · **Database**.

* **Overview** (`WebpageDataCards.jsx`, fed by `GET /:id/data-cards`): one card per bound table with
  **"Read only"** / **"Read and write"**, row count (*"{count} rows (approximate)"*), column chips with
  public ones marked *"column · Public"*, and a dashed **"Not used on this page"** when the code never
  names the table. Then one card per automation that feeds a bound table (**"Writes"**/**"Reads"**,
  *"Feeds {table} · last run {when}"* or *"never ran"*), a **"Knowledge sources"** card, and warning
  cards: *"{automation} writes straight into table {table}."* / *"Changes made there show up on this page
  without anyone editing it."* + **"Set up"**.
  Empty: **"No table is linked to this page yet."**; failure: **"Could not load what is linked to this
  page."** + **"Try again"**.
* **Actions** (`WebpageActionsPanel.jsx`, fed by `GET /:id/bindings`): **"Through Studio"** vs
  **"Does something in its own code"**, **"Forms and buttons"** (*"used {count}x on this page"*),
  **"Agent on this page"** (**"Signed-in readers only"** / *"No chat block on this page."*), and
  **"Turn it into an automation"** for an outgoing call found in the page's own code. Plus the grants panel
  **"Apps & data"** — *"What this page may call, running as you. Visitors never need their own
  accounts."*, sections **"Apps"** and automations, fields **"App"**, **"Action"**, **"Label (optional)"**,
  **"Pinned arguments (optional JSON)"** with hint *"Pinned values always win over what the page sends
  — pin anything a visitor must not choose (recipient, channel, sheet id)."*, button **"Add to page"**.
  Not-connected app: **"Connect it in Settings → Integrations"**.
* **Who can see it** (`WebpageAudiencePanel.jsx`, fed by `GET /:id/audience`): subtitle *"Who can see
  this page, and where it lives."*; the three internal rows plus a fourth card **"Public"** with
  **"Anyone with the address"** / **"Make public"** / **"Turn off"** / **"Change what goes out"**.
  Column gate dialog: **"What may leave this page?"**, confirm **"Make public"**, summary
  *"{n} columns go out."* / *"Nothing from your tables goes out."*
  Address card: **"Address"**, **"Live"** / **"Not serving"**, **"Copy"**,
  *"This page gets its address the first time you make it public."*, **"All options"** →
  **"Who may open the address"** (**"Anyone with the address"**, **"Anyone with the address and the
  password"**, **"Only these email addresses"**), **"Password (at least 6 characters)"**,
  **"Email addresses, one per line"**, **"Stops working on"**, **"Apply"**.
  Non-owner: **"Only the page owner can change who can see this page."**
* **Sources** (`WebpageSources.jsx`): **"Knowledge"**, add **"File"** / **"URL"** / **"Text"**,
  placeholders `https://example.com` and *"Paste text content…"*, empty state **"No knowledge yet"** /
  *"Add a file, URL, or paste text — the AI can use it as reference and inspiration."*, per-item
  **"Processing…"**, **"Retry"**, **"Cancel"**, **"Delete"**.
* **Database** (`WebpageDbViewer.jsx`): **"Tables ({count})"**, **"New table"**, **"Insert row"**,
  **"Drop table"**, columns grid **Column / Type / PK / Not Null / Default**, empty state
  *"No tables yet — click + to create one, or use the SQL tab for a custom CREATE."*, and the honest
  unknown state *"The tables could not be read, so this list is not "no tables". Try refreshing before
  you create one."*

### 2.5 Code tab (`WebpageIDE.jsx`, `FileExplorer.jsx`, `WebpageCodeStrip.jsx`)

VS-Code-like shell: **"Explorer"** with **"New file"**, **"New folder"**, **"Upload image / asset"**,
empty state *"No extra files yet. Use the buttons above to add a file, folder, or image — or just ask
the AI."*, drop hint **"Drop images to upload"**. Monaco editor tabs carry an **"Unsaved changes"** dot.
The three primary slots are always called **`index.html`**, **`style.css`**, **`script.js`**.
The code strip marks lines that link to Studio: legend **"Highlighted = Studio link"**, families
**"Data table"**, **"Automation"**, **"Agent"**, **"Not linked yet"**, **"Not recognised"**; when nothing
is found: *"Nothing in this code links to Studio yet."*
Right pane is the chat: **"AI Chat"**, **"New chat"**, mode selector **"How the assistant edits"** with
**"Edit automatically"** (`auto`) and **"Propose first"** (`ask`), placeholder *"Describe the webpage you
want…"*, empty state **"Describe a page, get a webpage"**. Each AI turn gets a card with
**"How I did this"**, **"Keep"**, **"Undo"**, **"Change in code"**; after an undo:
*"Undone — the page is back to how it was before this turn."*

### 2.6 History tab (`WebpageHistoryTab.jsx`)

**"Version history"**; rows carry a source chip **Manual / AI / Publish / Restore point**, a line delta
(`+12`, `−7`, `±0`, or nothing when it was not measured), an actor (**"You"** / **"Unknown"**), a
**"Published"** chip on the pinned row (**"Published: v{seq}"**), and per-row **"View"** and
**"Restore"**. Empty: *"No versions yet. Auto-snapshots are created every 5 minutes when you edit."*
Paging button **"Load more"**. Restore asks **"Restore v{seq}?"**.

### 2.7 Used by tab (`WebpageUsedByTab.jsx`)

Deliberately incomplete and says so: *"Bee Flow cannot list everything that links to this page yet, so
treat this as incomplete rather than as "nothing uses it"."* If the page sits in a Solution:
**"This page is part of a Solution."** The tab badge is intentionally absent (never a "0").

### 2.8 Delete dialog (`WebpageDeleteDialog.jsx`)

Title **"Delete webpage"**, then the danger zone (type the page name when anything is unchecked) and
one of: *"Deleting is not announced and not undone. What points at this page keeps pointing at a page
that is gone; what lives on the page goes with it."* or *"The check did not finish, so what still uses
this page is unknown…"*, plus *"Could not be checked: {kinds}. Treat this list as incomplete, not as
"nothing uses this page"."*

---

## 3. Concepts a learner must understand

| Term | Plain-language definition |
|---|---|
| **Webpage** | One AI-built mini web app owned by one user. Three primary files (`index.html`, `style.css`, `script.js`) plus any number of extra files, a chat, sources, its own SQLite database, and grants. |
| **Framework** | `vanilla` (plain HTML/CSS/JS, no build step) or `react-mui` (React + Material UI source under `src/`). **Every new page is created as `react-mui`** (`DEFAULT_NEW_FRAMEWORK`); an unknown value reads back as `vanilla`. |
| **Runtime tier** | `light` (default — no server container; vanilla srcdoc or an in-browser esbuild-wasm bundle) or `full` (a real per-project Node container; env flag `WEBPAGE_FULL_RUNTIME_ENABLED=1`). |
| **Draft vs Published** | `is_published` is the flag the pill reads. Publishing also **pins a version**: everyone who is not the owner reads `published_version_id`, not the live bytes. The owner always edits live. |
| **Audience (inside Bee Flow)** | Personal (only you) · Entire organisation · specific Groups. Written through `PATCH /:id/publish`. Hint in the UI: *"Inside Bee Flow, readers see the version you published — not what you are editing right now."* |
| **Public (outside Bee Flow)** | A **share** — a snapshot served anonymously at `/share/<token>` or at the page's own address `/w/<slug>`. One share is "the address" (`public_share_id`); a page may have several other links. |
| **Column gate (`publicColumns`)** | Per bound table, the list of columns allowed to appear on the public page. **Empty means nothing goes out** — there is deliberately no "all" value. A table missing from the answer is set to zero columns. |
| **Bridge grants** | What the page may call while it runs *as the owner*: `automations`, `integrations`, `tables`, `agent`, and an `ai` block. Managed in **Apps & data** or by the AI's bridge tools. Visitors never need their own accounts. |
| **`bf-*` elements** | The five Studio elements a page can contain: `bf-table`, `bf-stat`, `bf-button`, `bf-form`, `bf-agent`. One registry (`server/core/webpages/bfElements.js`) decides what each one does on each surface (live / static / inert / refused). |
| **Preview token** | A short-lived HMAC token the editor mints (`POST /:id/preview-token`) so the sandboxed iframe — which has no cookies — can call `/api/webpages-preview/*`. Table calls run **as the signed-in viewer**; AI, automations and integrations run **as the owner**. |
| **Sources / Knowledge** | Files, URLs or pasted text ingested into an auto-created knowledge base the builder AI reads. Not the page's data; reference material. |
| **Page database** | A per-page SQLite file (slot `db`), editable from the Database pane and from the page via `window.beeflowDB`. It is versioned along with the three text slots. |
| **Version / snapshot** | A frozen copy of `html/css/js/db`. Sources: `manual`, `ai`, `published`, `restore`. |
| **Solution (project)** | `project_id` — a Studio Solution a page can be filed into; it is the only "used by" relationship the product can state today. |

---

## 4. End-to-end workflows (exactly as the user clicks)

### W1 — Create a page and get a first draft
1. Left nav → **Studio** → **Webpages**.
2. Click **"All options"** under the build bar (or **"+ New webpage"**, which opens the same panel).
3. Type a name in **"New webpage name…"** → **"Create"**. The editor opens on the new page.
4. The header shows **Draft**; the tab strip opens on **Preview** (or **Code** if you came in via the
   card's **"Edit in IDE"**).
5. Open the **Code** tab → the right-hand **"AI Chat"**. Leave the mode on **"Edit automatically"**.
6. Type the brief, e.g. *"An intake form for supplier quotes: company, contact, amount, deadline, and a
   Send button."* → Enter.
7. Watch the file cards appear under the reply. Use **"Keep"** to dismiss, **"Undo"** to revert the whole
   turn, or **"Change in code"** to jump to the edited file.
8. Switch to **Preview** and click **"Reload"** to see the page render. Changes save automatically
   (chip reads **"Saved …"**; `Ctrl/Cmd+S` inside the IDE forces a flush).

### W2 — Bind a datatable and show its rows
1. Open the page → **Data & links** → **Actions** → **"Apps & data"**.
2. Confirm the table is reachable (tables are bound via the AI's bridge tools / the build-bar source
   picker; automations and apps are added here by hand).
3. Go back to **Code** → chat: *"Show the rows of table Suppliers in a table on this page, newest first."*
   The AI inserts `<bf-table source="…">`.
4. **Data & links → Overview**: the table now has a card with its row count and column chips. A dashed
   **"Not used on this page"** chip means the binding exists but the code never names it.
5. If an automation writes into that table you get a warning card — click **"Set up"** to open the table's
   sharing screen.

### W3 — Publish to colleagues (inside Bee Flow)
1. In the editor header, click **"Publish"**. This does **not** publish: it opens the audience capsule.
2. Choose **"Entire organisation"**, or tick one or more groups under **"Or specific groups"**.
3. Confirm **"Share more widely?"** → **"Share"**.
4. The header flips to **Published**; the server froze a snapshot and pinned it.
5. Keep editing. Your colleagues keep seeing the pinned version until you press **"Republish"** —
   which flushes pending edits, creates a `Published` version and re-pins it.
6. To stop sharing: capsule → **"Personal"**. The pointer is cleared; the version row survives.

### W4 — Put the page on a public address
1. **Data & links** → **"Who can see it"**.
2. In the **Public** card click **"Make public"**.
3. The column gate opens: **"What may leave this page?"** — tick, per bound table, exactly the columns
   that may be shown. The footer counts them (*"{n} columns go out."*). Nothing ticked = nothing goes out.
4. Click **"Make public"** in the dialog. The server saves the column choice, mints the address
   (`/w/<slug>`), creates the canonical share, writes the snapshot, then moves the pointer.
5. The **Address** card now shows **"Live"** and the URL — **"Copy"** it.
6. Optional: **"All options"** → pick **"Anyone with the address and the password"** (min 6 characters)
   or **"Only these email addresses"** (one per line), set **"Stops working on"**, then **"Apply"**.
   Changing the access mode mints a **new** link and the old one stops working.
7. To take it down: **"Turn off"**. The address is kept for later; the share is revoked.

### W5 — Roll back a bad edit
1. Editor header → **History**.
2. Find the row (chips tell you whether it came from **AI**, a **Manual** edit, a **Publish** or a
   **Restore point**); **"View"** opens it read-only.
3. Click **"Restore"** → confirm **"Restore v{seq}?"**.
4. The editor state is replaced and re-baselined, so the restore is saved as the current content.
   A published page keeps serving its pinned version until you press **"Republish"**.

### W6 — Hand the page over / take it out
1. **"Download ZIP"** in the header (pending edits are flushed first) gives `index.html`, `style.css`,
   `script.js` + every extra file.
2. `POST /api/webpages/:id/export/pdf` renders a PDF — **vanilla pages only**; a React + MUI page is
   refused with *"PDF export is not available for React + Material UI pages yet. Use Download ZIP…"*.
3. Delete: card → trash icon → **"Delete webpage"**. If the guard cannot check every kind (it never can
   today — agents and chats are unanswerable), you must type the page name to confirm.

---

## 5. Defaults, limits, numbers

| Thing | Value | Where |
|---|---|---|
| New page framework / runtime | `react-mui` / `light` | `integrations/webpageFramework.js` |
| Read-time fallback framework | `vanilla` | same |
| Overview list size | **50** most recently updated pages, no paging in the UI | `stores/webpage/access.js:13` |
| Build-bar sources | max **10**, kinds `datatable` \| `automation` only | `routes/webpages.js:212` |
| Build prompt | truncated at **4 000** characters; derived name capped at **60** | `routes/webpages.js:213-214` |
| Editor auto-save debounce | **1 500 ms** (chat history **800 ms**) | `hooks/useWebpageSave.js` |
| Auto-version debounce | **5 minutes**, per source (`manual` and `ai` have separate clocks) | `stores/webpage/versions.js:15` |
| Versions kept per page | **200** (`MAX_VERSIONS_PER_WEBPAGE`); `published` rows are never pruned | `stores/webpage/versions.js:14` |
| Version list page size | default **50**, clamped 1–200, `offset` supported | `routes/webpages.js:1846` |
| Upload size (sources and assets) | **50 MB** (multer memory storage) | `routes/webpages.js:68` |
| Asset types the header accepts | `image/*, .svg, .woff, .woff2, .ttf, .otf, .ico, .mp3, .mp4, .webm` | `WebpageEditorPage.jsx` |
| `bf-table` rows on a public page | max **100** (`limit` is clamped; missing = 100) | `core/webpages/bfElements.js` |
| `bf-stat` rows aggregated | max **500** | same |
| Share token | 32 random bytes (**256 bit**), stored as sha256 | `stores/webpagePublicShareStore.js` |
| Public slug | **60 random bits** appended, so addresses are not enumerable | `routes/publicViewer.js` header |
| Share password | minimum **6** characters, argon2id | `stores/webpagePublicShareStore.js:229` |
| Share expiry choices | 1 / 7 / 30 / 90 days or **No expiry**; a date must be ≥ 60 s in the future | `ExternalShareSection.jsx`, `webpagesAudience.parseExpiry` |
| Preview bridge rate limits (per minute) | AI **20**, side-effecting integrations/automations **10**, read-only integrations **60**, page DB **60**, bound-table reads **60**, bound-table writes **20** | `routes/webpagesPreviewRateLimits.js` |
| Chat tool rounds | **20** (config key `max_tool_rounds_chat`) | `routes/ai/webpageChat.js:703` |
| Preview selection sent to the AI | truncated at **8 000** characters | `routes/ai/webpageChat.js:322` |
| Default chat model tier | `fast` | `WebpagesPage.jsx`, `webpageChat.js:206` |
| Chat modes | `ask` \| `auto` \| `plan`; UI exposes `ask` and `auto`; default `auto`, remembered per user | `WebpageEditorPage.jsx`, `WebpageChat.jsx` |

---

## 6. What happens on failure

* **Save fails** → the chip reads **"Save failed — retry"** and is clickable; the dirty markers stay, so
  the next debounce retries. A failed extra file is re-queued; a failed primary slot does not block extras.
* **Publish cannot freeze a snapshot** → `500 "Could not freeze a snapshot — nothing was published"`, and
  the page is left exactly as it was (the pin happens *before* the flag goes up; unpublish clears the
  pointer *after* the flag goes down).
* **Publishing with no organisation** → `400 "Cannot publish: owner has no organisation"`; groups from two
  different orgs → `400 "Cannot publish to groups across multiple organisations"`; unknown group →
  `400 "Unknown group: …"`.
* **Making public but the current link cannot be read** → `500` with *"…the column choice was saved; the
  existing link is unchanged. Please try again."* — narrowing is saved, nothing is widened.
* **Making public but another live link could not be re-snapshotted** → `500 "Column choice saved, but not
  every public link could be updated"`. Old links may still show the previous columns until this succeeds.
* **Restore of an unreadable snapshot** → `409 { code: 'snapshot_unreadable' }` — refused rather than
  writing an empty page over the live one.
* **Delete** → `409 { code: 'in_use' }` whenever something was found **or** whenever a kind could not be
  checked. Because agents and chats are principally uncheckable today, *every* page hits at least one 409;
  the escape is the confirmed second call (`DELETE /:id?confirm=1`), never a silent retry.
* **Data cards / bindings / audience read fails** → the panel says so (**"Could not load what is linked to
  this page."**) and offers **"Try again"**; it never renders an empty list as "nothing".
* **A grant to an app you have not connected** → `409 { code: 'connection_required', provider }`; the UI
  shows **"Connect it in Settings → Integrations"**.
* **Public snapshot of a vanilla page runs no JavaScript at all** (`webpageSnapshot.js` omits the js slot).
  Anything that needs JS is rendered *visibly inert* with a notice rather than silently vanishing; on a
  shared **React** page `bf-table` is refused with *"This table cannot be shown on a shared link."*

---

## 7. Permission and licence gates

* **Licence**: `webpages` is an **Enterprise-tier** feature (`server/license/tiers.js:144`). The Studio tab
  gate is `hasLicenseFeature('webpages') && canUse('webpages')`; the page wraps itself in
  `<RequireTier feature="webpages">` and the inner shell re-checks `useCan('webpages')`.
  A feature gate **fails open** on a resolver outage — the server gate stays authoritative.
* **Beta/compound capability**: mount is
  `app.use('/api/webpages', requireModule('webpages'), requireCapability('webpages'), …)`
  (`server/index.js:813-814`) — licence **and** the `webpages` beta (GA lifecycle,
  `licenseFeature: 'webpages'`), honouring per-group grants. Route map note:
  `'/api/webpages': { gate: 'webpages', beta: 'webpages', notes: 'Enterprise tier + beta opt-in' }`.
* **Auth**: every route uses `requireAuth`; `router.use(requireActiveOrgForMutations())` blocks writes from
  a suspended/archived org.
* **Ownership is the real gate inside the feature.** Owner-only (404 for anyone else):
  `GET/PUT/DELETE /:id/files`, `/:id/assets*`, `/:id/grants*`, `/:id/data-cards`, `/:id/bindings`,
  `/:id/audience*`, `/:id/usage`, `/:id/versions*`, `/:id/chat`, `/:id/db*`, creating/revoking share links.
  A viewer of a published page can read `GET /:id` (pinned snapshot), `GET /:id/files`,
  `GET /:id/thumbnail` and a redacted `GET /:id/public-shares`.
* **`PATCH /:id/publish`** is the one place a non-owner is considered: it needs session admin
  (`isAdmin`/role `admin`) **or** `hasPermission(userId, 'manage_webpages')`. **`manage_webpages` is
  declared nowhere** (not in `server/auth/permissions.js`, not in `server/config/orgRoles.json`), so in
  practice only the wildcard `all` permission satisfies it. The legacy `use_webpages` permission exists but
  is marked *"Use Webpages (deprecated) — access is now controlled by the `webpages` beta feature"*.
* **Chat history is per owner**: a non-owner gets `chatMessages: []` from `GET /:id`.

---

## 8. How Webpages connects to the rest of the product

* **Datatables** — `bridge_grants.tables` + `bf-table` / `bf-stat`; reads and writes from the page run **as
  the signed-in viewer** with that viewer's own grade; the public page reads only `publicColumns`. Saves
  reconcile the dependents index (`automation_datatable_usage`, `consumer_kind='webpage'`), which is what
  makes a page appear in a table's "used by" list and what can block a table's deletion.
* **Automations / automations** — `bridge_grants.automations` + `bf-button` / `bf-form`; run **as the owner**
  via the preview bridge. The build-bar source picker turns a picked automation into a real grant.
* **Integrations (apps)** — granted per tool, optionally with **pinned arguments** that always beat what the
  page sends.
* **Agents** — `bf-agent` puts an inline chat block on the page (signed-in readers only).
* **Knowledge bases** — sources create an auto KB the builder AI searches (`webpage_kb_search`); deleting the
  page deletes those KBs.
* **Solutions (projects)** — `project_id` files a page into a Solution; the Audience panel prints
  *"Part of solution {name}"*.
* **Chat** — a `/app/webpages/:id` link in a chat renders as a card and opens the page in the right-hand
  side panel (`WebpageLinkCard`, `SideWebpagePanel`).
* **Compliance/export** — PDF export is stamped through `compliance/dataPortability/stampExport('ai_webpages')`.

---

## 9. Common mistakes

1. **Thinking "Publish" publishes.** On a draft the pill only opens the audience capsule; nothing is shared
   until an audience is chosen. Conversely, ticking a group on a live page does **not** push your newest
   work out — only **"Republish"** re-pins the snapshot.
2. **Expecting colleagues to see the latest edit.** Non-owners read the pinned version. "But it works on my
   screen" is nearly always a missing **Republish**.
3. **Forgetting the column gate.** A table bound for internal use shows nothing on the public page until its
   columns are ticked — and a table left out of the answer is silently reset to **zero** columns.
4. **Assuming public = the same page.** A vanilla public snapshot runs **no JavaScript**; a React + MUI page
   cannot expand `bf-table` on a share at all. Test the page at its `/w/<slug>` address, not only in preview.
5. **Changing the access mode casually.** Switching unlisted → password/email mints a new link; every URL
   already handed out stops working.
6. **Treating "Used by" or a delete check as complete.** Both say out loud that they are not; deleting on an
   unchecked list is a decision made without the answer.
7. **Editing as a viewer.** Code and History are not offered to non-owners because every save would 404.
8. **Losing pages below the 50-row cap.** The overview lists only the 50 most recently updated accessible
   pages; use the search box, or the deep link `/app/studio/webpages/<id>` (which loads by id).
9. **Expecting the build bar to work.** Today it is inert in the shipped shell — create by name, then brief
   the page in its chat.
10. **Leaving an automation writing straight into a bound table** without noticing the warning card — the page's
    content then changes without anyone editing the page.
11. **Assuming `+ New webpage` pre-fills anything.** It opens the name form; the AI never sees a brief you
    did not type into the chat.

---

## 10. Scenarios for "Van Dijk Groep" (Dutch SME)

### Procurement — supplier quote status page
Van Dijk Groep collects supplier quotes in a datatable `Offertes` (columns: `referentie`, `leverancier`,
`bedrag`, `status`, `contactpersoon`, `telefoon`). The buyer builds a page **"Offertestatus"**: a single
input for the reference number, a `bf-table` bound to `Offertes`, and a thank-you line. In **Who can see
it → Make public** she ticks only `referentie` and `status` — `leverancier`, `bedrag`,
`contactpersoon` and `telefoon` stay off, so nothing personal or commercial leaves the building. The page
goes live at `/w/offertestatus-…` with **"Anyone with the address and the password"** and an expiry of 90
days. Teaching points: the column gate, the 100-row clamp, and "the address is the key, so it carries
entropy".

### HR — internal onboarding checklist
The HR manager builds **"Onboarding nieuwe collega's"**: a form with name, start date and department that
starts the automation *"Onboarding starten"* (a `bf-form` bound to a granted automation), plus a `bf-stat`
counting open onboardings in the table `Onboarding`. She publishes to **groups** (HR + Office) rather than
the whole organisation, and confirms **"Share more widely?"**. Because the page runs as *her*, the new
colleague's manager never needs access to the connected apps. Teaching points: groups vs entire
organisation, acts-as-author, pinned arguments (the HR mailbox is pinned so no one can retarget the mail),
and the GDPR rule that personal data must not travel to an external system.

### Sales — quarterly pipeline dashboard for the MT
The sales lead builds **"Pipeline Q3"** on top of the automation *"Pipeline samenvatten"* (which writes into
the table `Pipeline`): headline `bf-stat` cards (count, sum of `waarde`), a `bf-table` with the top deals,
and the last-run timestamp. The Overview cards show the warning *"Pipeline samenvatten writes straight into
table Pipeline"* — exactly the behaviour he wants, and now visible. He publishes to **Entire organisation**,
then presses **"Republish"** every quarter after restyling. When a chart turns out wrong he uses **History**
to restore the previous **AI** snapshot. Teaching points: automations feeding a page, republish discipline, and
per-turn **Undo** vs version **Restore**.

---

## 11. List/read API endpoints a "did the learner do it?" check can call

All of these were read in `server/routes/*` and all require an authenticated session cookie
(`requireAuth`) **plus** the mount gates `requireModule('webpages')` + `requireCapability('webpages')`.
Owner-only endpoints answer **404** (not 403) to anyone else.

| Method | Path | Auth | What the JSON contains |
|---|---|---|---|
| GET | `/api/webpages` | session; any user with the capability | `{ webpages: [ … ] }`, max 50 rows, `ORDER BY updated_at DESC`. Each row (`mapWebpageRow`): `id`, **`userId` (owner)**, `name`, `description`, `instructions`, `knowledgeBaseIds`, `settings` (`{framework, runtime}`), `htmlSha/cssSha/jsSha/dbSha`, `htmlSize/cssSize/jsSize/dbSize`, **`isPublished`**, **`publishedVersionId`**, **`sharedGroups`**, `organizationId`, `projectId`, **`slug`**, `publicShareId`, `icon`, `accentColor`, `tagline`, `thumbnailSha`, `sourceCount`, **`publicShareCount`** (null = unknown), `bridgeGrants`, `createdAt`, `updatedAt` |
| GET | `/api/webpages/:id` | owner **or** a reader of a published page | `{ webpage, sources[], files:{html,css,js}, chatMessages[] (owner only), extraFiles[], readOnly, servedVersionId }` |
| GET | `/api/webpages/:id/versions?limit=&offset=` | **owner only** | `{ versions:[{ id, seq, summary, source ('manual'\|'ai'\|'published'\|'restore'), actor, lineDelta, isPublished, createdAt … }], hasMore, published:{versionId,seq}\|null, coverage }` |
| GET | `/api/webpages/:id/versions/:vid` | owner only | `{ version: { … full file trio … } }` |
| GET | `/api/webpages/:id/sources` | owner only | list of knowledge sources with `id, type ('pdf'\|'docx'\|'xlsx'\|'csv'\|'text'\|'url'\|'file'), name, status ('processing'\|'ready'\|'error'), metadata` |
| GET | `/api/webpages/:id/files` (no `?path`) | owner or published-page reader | `{ files: [ { path, mimeType, isText, size, … } ] }` — extra-file inventory |
| GET | `/api/webpages/:id/files?path=…` | owner or reader | `{ meta, content }` (text) or `{ meta, contentBase64 }` (binary) |
| GET | `/api/webpages/:id/grants` | **owner only** | current bridge grants + integration availability (`{ ai, automations[], integrations[], tables[], agent }`) |
| GET | `/api/webpages/:id/data-cards` | **owner only** | `{ tables:[{datatableId,name,mode,columns,publicColumns,allColumns,rowCount,usedInCode}], automations:[{automationId,datatableId,title,writes,columns,lastRunAt}], warnings:[…] }` |
| GET | `/api/webpages/:id/bindings` | **owner only** | what the page's own code does: outgoing calls, `bf-*` element locations (file + line), form/agent state |
| GET | `/api/webpages/:id/audience` | **owner only** | `{ public:{on,accessMode,allowedEmails,expiresAt}, address/slug+url, columnGate:{tables:[{datatableId,label,columns,publicColumns}]}, shareCount, solution, ai }` |
| GET | `/api/webpages/:id/usage` | **owner only** | `{ usage[], unchecked[], sources{}, complete }` — `complete` is always `false` today |
| GET | `/api/webpages/:id/public-shares` | owner in full; a reader of a published page gets status without recipient emails | share rows: `id, accessMode, expiresAt, revokedAt, createdBy, viewCount…` (raw token never returned again) |
| GET | `/api/webpages/:id/thumbnail` | owner or published-page reader | PNG bytes, ETag = `thumbnailSha`, 404 when no thumbnail |
| GET | `/api/webpages/:id/db/schema` | **owner only** | the page's SQLite tables + columns |

Good verification signals: a row in `GET /api/webpages` whose `userId` is the learner **and**
`isPublished === true` (published at all) with a non-null `publishedVersionId` (really pinned);
`publicShareCount > 0` or a non-null `slug` (made public); `bridgeGrants.tables/automations` non-empty
(wired to Studio); a non-empty `GET /:id/versions` (they actually edited); `sourceCount > 0` (added
knowledge).

Write endpoints exist for everything above (`POST /`, `PUT /:id`, `POST /:id/clone`,
`DELETE /:id[?confirm=1]`, `PATCH /:id/publish`, `PUT /:id/audience/public`, `POST /:id/public-shares`,
`POST /:id/assets`, `POST /:id/versions`, `POST /:id/versions/:vid/restore`, `POST /:id/export/pdf`,
`POST /:id/preview-token`) — do not use them for verification, only for teaching what the buttons do.
