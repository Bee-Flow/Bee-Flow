# Bee Flow — App Map for E2E (curated)

> Facts only, verified against `agent-hub/src` source. Never invent a `data-testid` that is not
> listed here; prefer `getByTestId` with these ids, fall back to `getByRole`/`getByText` with the
> exact accessible names quoted below. English UI strings are the `en-defaults.js` values.

## Global

- SPA with a **custom pushState router** (`agent-hub/src/App.jsx`). Links are normal `<a>`/pushState;
  `page.goto()` works for every route listed below (the router parses `location.pathname` on load).
- **Viewport**: `< 768px` wide = mobile mode — deny-by-default redirect to `/app` for every page
  except the eight keys in `MOBILE_ALLOWED_PAGES` (`agent-hub/src/authedApp/appRoutes.js`, frozen in
  `appRoutes.test.js`): `agents`, `settings`, `apps`, `appRun`, `forms`, `formView`, `cowork`,
  `approvals`. `approvals` is not the Studio page — it is the `/app/studio/approvals[/:id]` slice
  only (`mobilePageKey`/`MobileRouteGuard`), because an approval push has to open on the phone it
  landed on; the rest of `/app/studio/*` still bounces to `/app`. `768–1279` = "compact",
  `>= 1280` = desktop (`useViewport.js`). **Always run tests with a desktop viewport, e.g. 1440×900
  (minimum width 1024, prefer >= 1280).**
- **Unauthenticated**: any `/app` URL renders the `LoginPage` in place (no redirect to a `/login`
  route). Session = **HTTP cookie** (`credentials: 'include'` on all API calls); once logged in, the
  browser context stays authenticated. (`X-Session-Token` in sessionStorage exists only as an
  embedded-iframe fallback — irrelevant for tests.)
- API base: same origin in the built app (nginx proxy); dev frontend calls `http://<host>:3001`.

## Routes

| Path | Page |
|---|---|
| `/` | normalized to `/app` |
| `/app` | Agents home / chat shell |
| `/app/a/:agentIdPrefix[/:convIdPrefix]` | agent chat (8-char id prefixes accepted) |
| `/app/d/:convIdPrefix` | direct chat (legacy bare `/d/:id` also parses) |
| `/app/studio` | Studio (defaults to Agents tab) |
| `/app/studio/<segment>[/:id]` | Studio section — built-in segments: `agents`, `skills`, `knowledge`, `automations` (legacy `routines`, `ai-tasks`), `approvals`, `datatables`, `webpages`, `apps`, `solutions`, `meeting-notes`. They come from the Studio app registry (`studioApps.jsx` → `studioRoutes.js`), so installed modules add their own; there is no longer a `support` tab |
| `/app/studio/approvals[/:approvalId]` | Approvals — the one Studio slice a phone may open (page key `approvals`) |
| `/app/studio/cowork[/:id]` | legacy — resolves to the standalone Cowork page, matched before the Studio rule |
| `/app/admin[/seg1[/seg2[/seg3]]]` | Admin dashboard (admins only) |
| `/app/org-settings[/...]` | Org settings |
| `/app/settings[/<section>]` | User settings — sections `preferences`, `appearance`, `security`, `memory`, `integrations`, `learning`, `help_support` (`authedApp/settingsRoutes.js`, frozen in `settingsRoutes.test.js`) — each is a deep link, e.g. `page.goto('/app/settings/security')` opens Security. Unknown segment → Preferences; legacy `/app/settings/simple-mode` → Preferences |
| `/app/settings/account/<sub>`, `/app/settings/organisation/<sub>` | the two group parents — consumer subs `license`, `privacy`, `usage`, `integrations`, `beta`; org subs `license`, `auth`, `privacy`, `encryption`, `info`, `usage`, `compliance`, `users`, `academy`, `integrations`, `github-sync`, `nextcloud-sync`, `meeting-templates`, `azure`. `account`/`organisation` are NOT tab names and win over any top-level segment |
| `/app/billing` | plans, invoices, checkout (the pricing page links `/app/billing?plan=<id>`) |
| `/app/cowork[/:id]` | Cowork, master-detail (legacy `/app/work[/:id]`) — phone-friendly |
| `/app/apps` | published-apps directory (page key `apps`, mobile-allowed) |
| `/app/apps/:id` | published App Studio app, standalone run view (page key `appRun`, mobile-allowed) |
| `/app/forms` | directory of published forms (page key `forms`, mobile-allowed) |
| `/app/forms/:token` | that form inside the workspace shell (page key `formView`); the same form answers anonymously at `/f/:token` |
| `/app/projects[/:id[/:tab]]` | Projects (list + detail) |
| `/app/agent-designer[/:agentId]`, `/app/agent-designer-advanced[/:agentId]` | legacy agent editor (advanced form) |
| `/app/agent-wizard` | agent wizard |
| `/app/routines[/:taskId]` (legacy `/app/ai-tasks`) | Routines / AI tasks |
| `/app/notebooks[/:id]`, `/app/templates`, `/app/reports`, `/app/components` | as named |
| `/app/webpages[/:id]`, `/app/meeting-notes` | redirect into the matching Studio section |
| `/login`, `/settings/billing` | not routes — server-minted mail/redirect targets that land on Agents home (`/login?verified=1`, `?signup=1`, `?reset=<token>`, `?error=…`; the boot code reads the query) |
| any other `/app/*` | falls back to Agents home |

After chatting, the app rewrites the URL itself via `replaceState` to short forms `/d/:8chars`
(direct) or `/a/:8chars[/:8chars]` (agent).

## Login

Testids (in `pages/login/LoginForm.jsx`): `username` (email input), `password`,
`login-submit-button`, and — on the full form only — `sso-nextcloud-button`, `sso-google-button`,
`sso-microsoft-button` (each only when that SSO is configured), `create-account-button` (when
signups allowed). Button/label strings: "Email address", "Password", "Sign In", "Create Account".

- A `bf_preferred_login` cookie switches to a single-method "dedicated view". For
  `password` it still renders `username`/`password`/`login-submit-button`; SSO testids are absent
  there. Fresh browser contexts always get the full form.
- Submit → `POST /auth/admin-login`; if the account is migrated, an **OPAQUE** flow runs
  transparently client-side — same button, no extra UI. On success the app shell renders.
- Possible interstitials after submit: MFA code prompt (`data.mfaRequired`), email-verification
  screen. Errors render in a red alert `div` containing the error text (no testid; default text
  "Login failed").

### Post-login full-screen gates (each REPLACES the whole app; detect by visible text)

| Gate | Detect (exact text) | Dismiss |
|---|---|---|
| EncryptionSetup, recovery-key screen | heading "Save Your Recovery Key" | click button "I've saved my recovery key — Continue" |
| EncryptionSetup, PIN setup/unlock (SSO accounts) | PIN form (`mode='setup'|'unlock'`) | enter PIN — should not occur for password test accounts |
| MfaSetupGate (forced MFA enrollment) | heading "Set up two-factor authentication" | cannot be skipped — CI must disable required-MFA |
| No-org / approval gates | "No Organisation Found" / "Awaiting Approval" | account misconfigured — fail the test |

CI disables required MFA and the login probe consumes the recovery-key screen, but tests should
still defensively dismiss the recovery-key and reconsent gates if they appear after login.

## Sidebar & navigation

Static testids (`components/shell/Sidebar.jsx`): `sidebar`, `main-navigation`, `toggle-sidebar`
(only when expanded; clicking a collapsed sidebar expands it), `sidebar-profile` (opens the profile
menu), `profile-menu`, `profile-menu-admin` (admins only → `/app/admin`), `profile-menu-settings`,
`sidebar-signout`.

Nav rows use a **locale-independent** testid, exactly (from source):
``data-testid={`nav-${key}`}`` — the row's stable key, not its label. It used to be slugified
from the *translated* label, which meant the selector changed with the install's UI language
(`nav-approvals` is `nav-goedkeuringen` on any install where the Dutch sidebar translations ran).
In English the two forms are identical, so the values below did not move:

| testid | Label | Action | Always visible? |
|---|---|---|---|
| `nav-new-chat` | "New Chat" | starts a new direct chat | yes |
| `nav-cowork` | "Cowork" | `/app/cowork` | yes (phone-friendly) |
| `nav-approvals` | "Approvals" | `/app/studio/approvals` | when the org can browse approvals |
| `nav-search` | "Search" | opens search overlay | yes |
| `nav-agents` | "Agents" | opens the agent **marketplace overlay** (no route change) | yes |
| `nav-studio` | "Studio" | navigates to `/app/studio` | admins / manage_agents / manage_skills / org admins, desktop, non-simple-mode |
| `nav-apps` | "Apps" | `/app/apps` | `app_studio` capability |
| `nav-forms` | "Forms" | `/app/forms` | forms permission, desktop |
| `nav-notebooks` | "Notebooks" | `/app/notebooks` | licence/flag gated |

Each row also carries `data-tour="nav-<key>"` with the same value; both are now derived from the
same key, so either selector works in any language. Flyout rows inside a nav panel
(`nav-studio-<section>`, `nav-forms-all`, `nav-app-<id>`, `nav-recent-<source>-<id>`) were already
key-based and did not change.

Conversation / agent rows (dynamic, full UUIDs): `conv-row-${conv.id}`, `conv-options-${conv.id}`
(three-dot menu, hover-revealed), `conv-delete-${conv.id}` ("Delete" item inside that menu),
`agent-row-${agent.id}` (favorite agents under "My Agents"). Chats list section header text: "Chats".

## Direct chat

- **Start a new chat**: click `nav-new-chat` (the sidebar logo button, aria-label "New Chat", does
  the same). On a fresh desktop profile `/app` shows an empty state ("Welcome to Bee Flow" +
  "Browse Agents" button) until New Chat is clicked; the last-used mode is then remembered per user.
- Composer testids (`components/chat/InputArea.jsx`): `chat-input-form` (role=form, also
  `data-cowork-mode` / `data-tour="chat-composer"`), `chat-message-input` (textarea; placeholder
  "Message AI..." in direct mode, `"Message " + agentName + "..."` in agent mode),
  `send-message-button`, `voice-send-button`, `stop-generating-button`, `file-upload` (hidden
  `input[type=file]`, multiple, accepts images/pdf/docx/csv/xlsx/txt/md/json/code),
  `composer-shield-line` (the Privacy Shield line), and the knowledge picker
  `composer-kb-picker` with `composer-kb-error` / `composer-kb-saving`. The attach, web-search,
  memory-write and multimedia controls carry NO testid — reach them by their accessible name.
- Enter sends on desktop; Shift+Enter = newline.
- **Reply lifecycle**: while generating, `send-message-button` is REPLACED by
  `stop-generating-button`; when the reply is complete it flips back. Reliable wait: after send,
  `stop-generating-button` appears, then wait for `send-message-button` to be visible again.
- Message items (`components/chat/MessageItem/index.jsx`): container testid
  `message-${msg.id || idx}` for BOTH roles — there is no role-specific testid. Distinguish by
  layout class on the same element: user = `items-end` (right-aligned bubble), assistant =
  `items-start`. Practical check: count of `[data-testid^="message-"]` grows by 2 per turn, and the
  finished assistant message shows hover actions `msg-copy-btn`, `msg-thumbs-up`,
  `msg-thumbs-down`, `msg-retry-btn` (also `msg-guardrail-warning` on policy hits).
- After the first reply the URL becomes `/d/:8charConvId`; the conversation appears in the sidebar
  as `conv-row-<uuid>`.

## Studio shell (rail & Start)

Since H1 the Studio sections are a left **rail** (`admin/Studio/StudioRail.jsx`), not a tab bar.
Container testids: `studio-rail`, `studio-rail-nav` (the `<nav aria-label="Studio navigation">`),
`studio-rail-back-to-chat`, `studio-rail-search`. Each row is a button with testid
``rail-${app.id}`` — plus `rail-start` for the Start row and `rail-approvals`. A locked row carries
`data-locked="true"` and a `rail-<id>-lock-hint`; rows with a count render `rail-<id>-count`.

The registry is `admin/Studio/studioApps.jsx` (`STUDIO_APPS`) plus `studioStart.js`
(`STUDIO_START`, id `start`). **Twelve** built-in sections today, in registry order, with their id
(= the rail testid suffix) and English label:

| id / testid suffix | URL segment | Label |
|---|---|---|
| `agents` | `agents` | Agents |
| `skills` | `skills` | Skills |
| `knowledge` | `knowledge` | Knowledge |
| `aiTasks` | `automations` | Automations |
| `approvals` | `approvals` | Approvals |
| `datatables` | `datatables` | Datatables |
| `webpages` | `webpages` | Webpages |
| `apps` | `apps` | Apps |
| `forms` | `forms` | Forms |
| `solutions` | `solutions` | Solutions |
| `runs` | `runs` | Runs & log |
| `meetingNotes` | `meeting-notes` | Meeting Notes |

There is **no** "Support" section any more. Installed modules add their own rows. The rail groups
them under four headings (`STUDIO_CATEGORIES`, `studioApps.jsx`): **Build · AI · Bundle ·
Add-ons**; a module without a category lands under Add-ons.

`/app/studio` with no segment lands on **Start** (`StudioStart.jsx`, testid `studio-start`), whose
section cards are ``studio-start-${app.id}`` (locked ones also render
``studio-start-${app.id}-lock-hint``). Sections are licence/permission gated, so a row or card may
legitimately be absent — assert on the ones your scenario needs, not on the full list.

## Studio: Agents (CRUD)

Route `/app/studio/agents` (deep link `/app/studio/agents/:agentId`). **No data-testids** in
`admin/AgentStudio/index.jsx` or the `BuilderSplit` editor — use roles/names/text:

- Left list header: text "Agents"; **create** = the icon-only `+` button next to it with
  `title="Create empty agent"` (aria: use `getByTitle('Create empty agent')`). Empty-state text:
  "No agents yet — create one with AI or start empty."
- Clicking `+` opens the editor with a local draft: name `input` with placeholder **"Agent name"**
  (draft default name "Untitled agent"), header shows "Draft — not saved yet" and a **"Save"**
  button ("Saving…" while in flight). After the first save the agent persists and further edits
  autosave; a publish menu appears.
- Agent rows: `div` with `aria-label` = the agent name; hover reveals a delete button with
  `title="Delete"` / `aria-label="Delete: <name>"`.
- Delete confirm: `role=alertdialog`, title "Delete agent", body `Delete agent "{name}"? This cannot
  be undone.`, buttons "Cancel" and "Delete" ("Deleting…" while busy).
- Navigation between Studio sections is the **rail**, not a tab bar — see "Studio shell" above.

## Knowledge base

Primary surface `/app/studio/knowledge` (`Studio/KnowledgeStudio/`), three screens behind one
route — `/app/studio/knowledge[/:id[/:tab[/:sourceId]]]`:

- **Overview** (testid `kb-overview`): one row per base, testid `kb-row` with `data-kb-id`. Category
  chips are `button[aria-pressed]` ("All", each used category, "Uncategorised"). The freshness cell
  is testid `kb-freshness` with `data-tone` = `ok` | `idle` | `problem`. A search box appears only
  past four bases.
- **Create**: button testid `kb-create`, visible text **"New knowledge base"**, still carrying
  `data-tour="knowledge-create"` (the onboarding tour anchors on it). It creates the base and opens
  it, so the URL becomes `/app/studio/knowledge/<id>/sources` — there is no `/new` form any more.
- **Detail** (testid `kb-detail-page`, `data-kb-id`): the shared 48px Studio header
  (`components/shared/StudioSectionHeader.jsx`, testid `studio-section-header`) — back arrow
  `studio-section-back` ("Back to Knowledge"), kind tile `studio-section-kind`, the name as
  `studio-section-title` (a button; clicking it swaps in the input `studio-section-title-input`,
  aria-label "Rename" — type the new name and press Enter), the status chip
  `studio-section-status` ("Updated <when>", or "Nothing in it yet"), then the tab strip as a
  `role="radiogroup"` of `role="radio"` segments: **Sources · Test question · Settings · Used by**
  (at narrow widths it folds into the menu button `studio-section-tab-menu` with
  `role="menuitemradio"` items). Action buttons sit in `studio-section-actions`; on the Sources tab
  that is "Add a source". The visibility capsule is testid `visibility-capsule`. Tab changes push
  the URL, so `…/<id>/usage` is deep-linkable.
- **Sources tab** (testid `kb-tab-sources`): table rows testid `kb-source-row` with `data-source-id`,
  `data-kind` and `data-status`. Row menu is `button[aria-label="Actions for <name>"]` →
  `role=menuitem` (Refresh now · Rename · Refresh schedule… · Open · Delete). To the right, the
  "Add a source" card (testid `kb-add-source`) with one button per kind, testid
  `kb-add-kind-<kind>` and `data-disabled`. Seven buttons in this order (`sourceKinds.js`
  `ADD_SOURCE_KINDS`): `nextcloud_folder`, `upload`, `datatable`, `meeting_tag`, `webpage`, `text`,
  `automation`. Three states, not two:
  - **creatable** (`CREATABLE_KINDS` = `text`, `upload`, `webpage`, `meeting_tag`, `datatable`) —
    the button opens a form in the panel;
  - **disabled** — `nextcloud_folder` only, `data-disabled="true"` with a tooltip (arrives with K9);
  - **signpost** (`SIGNPOST_KINDS` = `automation`) — enabled, but it opens an EXPLANATION, not a
    form: an automation source appears when a routine writes to this base. Testids
    `kb-signpost-automation` (the panel), `kb-signpost-automation-source` (one row per routine
    already feeding this base) and `kb-signpost-automation-link` (the "Open Routines" link to
    `/app/studio/automations`). It is not "coming soon" — do not assert that wording.
- **Source forms** inside the panel: `kb-form-datatable` (fields `kb-datatable-select`,
  ``kb-datatable-column-${key}``, `kb-datatable-title`, submit `kb-datatable-submit` "Add this
  table") and `kb-form-meeting_tag` (fields `kb-meeting-tag`, ``kb-meeting-field-${field}`` for
  `summary` | `decisions` | `questions` | `actions` — `summary` is always on and disabled — submit
  `kb-meeting-submit` "Add meetings").
- **Upload a file**: click `kb-add-kind-upload`, then `setInputFiles` on the input labelled
  **"Choose files"** (multiple allowed, 20 MB each). Upload starts on pick and answers 202 — the
  document rows appear immediately with status "processing" and settle by polling.
- **Source detail** (testid `kb-source-detail`, reached by clicking a source row; URL
  `…/<id>/sources/<sourceId>`): filter chips testid `kb-doc-filter-{all,processed,skipped,pii}`, and
  document rows testid `kb-doc-row` with `data-doc-id` and `data-status`
  (`processed` | `redacted` | `skipped` | `error` | `duplicate`).
  The unscanned banner is `kb-unscanned-banner`; a row that Privacy Shield could not scan shows
  `kb-doc-unscanned`.
- **Test question tab** (`TestQuestionCard.jsx`, testid `kb-test-question`): `kb-ask-input`,
  `kb-ask-submit`, and one of `kb-ask-empty` (nothing found) / `kb-ask-answer`. Supporting
  passages: `kb-ask-passages` (the list) with `kb-ask-passage` per item and `kb-ask-citation` per
  citation link.
- **Settings tab** (`SettingsTab.jsx`, testid `kb-tab-settings`): `kb-settings-name` ("Name"),
  `kb-settings-description` ("What is in it"), `kb-surfaces` ("Where it can be used") holding one
  ``kb-surface-${id}`` toggle per surface — ids `agent` ("Agents"), `direct_chat` ("Chat"),
  `ai_step` ("Routines") — `kb-audience` ("Who may see and use it"), `kb-category`,
  `kb-duplicate` ("Make a copy") with `kb-duplicate-shell` and `kb-duplicate-sources`, and the
  shared danger zone (testid `danger-zone`, `components/shared/DangerZone.jsx`), which may render
  `kb-delete-unchecked` when the usage list is incomplete.
- **Deleting a knowledge base** is the danger zone, NOT a dialog: click the collapsed link
  "Delete this knowledge base", which arms an inline `role="group"` panel headed
  `Delete “<name>” for good?`. A name field (aria-label "Type the name to confirm.") appears only
  when something still uses the base or the usage list has not loaded — fill it when it is there,
  otherwise skip it — and then the "Delete for good" button runs the delete. While it checks usage
  the panel shows `danger-checking`; then one of `danger-unused`, `danger-unchecked` or
  `danger-dependents` (+ `danger-dependents-incomplete`). On success the app navigates back to
  `/app/studio/knowledge`. A personal base instead shows `kb-personal-notice` with the
  `kb-move-to-org` button ("Move to my organisation"). There is no storage mode, embedding model,
  chunk size, search mode, reranker or retention control here — those never existed in this UI.
- **Overview extras**: `kb-usage-none` (the "used by nothing" cell), `kb-suggestion` with
  `kb-suggestion-dismiss` (suggestion cards above the list).
- **No chunks, no re-index anywhere in Studio.** Neither word appears in this surface; a spec that
  waits for a chunk count will wait forever. Processing completion = the row's `data-status`
  becomes `processed` (or `redacted`).
- Destructive actions never use `window.confirm` here. Deleting a **source** or a **document**
  goes through the in-app confirm (`useConfirm` → `role=alertdialog`, buttons "Cancel" and the
  destructive label); deleting the **base itself** goes through the danger zone described above.

Secondary surface — the agent editor's knowledge panel (`components/knowledge/KnowledgePanel.jsx`, used in
the legacy `/app/agent-designer` editor and Templates, NOT in Studio→Knowledge) has real testids:
`knowledge-panel`, `kb-create-btn` (text "+ Create KB"; modal name placeholder
"KB Name (e.g. Product Docs)"), `kb-item-${id}`, `kb-delete-${id}`, `kb-doc-${id}`,
`kb-doc-delete-${id}`. Its file upload is likewise a hidden `input[type=file]`
(accept `.pdf,.txt,.md,.docx,.csv`) inside a "📎 File" label; deletes use `window.confirm`.

## Approvals (Studio section)

Route `/app/studio/approvals` (deep link `/app/studio/approvals/:approvalId`); also reachable
via the sidebar row "Approvals" that appears whenever the signed-in user has pending approvals.
Testids: `approval-row` (each list row), `approvals-search` (the search input). Status tabs are
plain buttons labelled Waiting / Approved / Declined / Expired / Closed (with ` · <n>` counts).
The detail's decision controls are buttons named exactly "Approve" and "Reject" plus a reason
textarea (`aria-label="Reason for your decision"`); Reject stays disabled until the reason is
non-empty. Withdraw ("Withdraw this request") uses `window.confirm`. In App Studio, the
`approval_list` component renders rows as `data-testid="approval-list-row"` and reuses the same
decision controls.

## Known modals & gates

- **MfaSetupGate / EncryptionSetup** — full-screen replacements, see Login section for exact
  texts and dismissal. Add a defensive post-login step: if "Save Your Recovery Key" is visible →
  click "I've saved my recovery key — Continue".
- **Native dialogs**: only on the LEGACY surfaces. `components/knowledge/KnowledgePanel.jsx`
  (agent-designer / Templates) still deletes KBs and documents through `window.confirm`, and
  Approvals' "Withdraw this request" does too — attach a `page.on('dialog')` handler before
  clicking those. **Studio → Knowledge does not**: it uses the in-app `useConfirm`
  (`KnowledgeDetail.jsx`) and renders a `role=alertdialog`. A dialog handler there never fires and
  the click looks like it did nothing. Same for Studio → Agents (see its section).
- Onboarding tour / lesson player components exist (`OnboardingTour`) but are user-flag driven;
  if an overlay blocks clicks, close it via its visible close button before proceeding.

## Studio: Skills

Route `/app/studio/skills` (`admin/Studio/SkillsStudio/`). Detail container `skill-detail`;
`skill-readonly` marks a skill the viewer may not edit, `skill-improve` is the AI-improve action,
`skill-usedby-note` the used-by line, `skill-legacy-automation` the legacy-automation notice.
Cards inside it: `skill-rules` (rows `skill-rule`, add `skill-rule-add`, polarity toggle
`skill-rule-polarity`), `skill-can-use` (`skill-dynamic`, `skill-grant-add`, `skill-grant-gap`,
`skill-grant-menu-gap`, and the load states `skill-grant-loading` / `skill-grant-none` /
`skill-grant-retry`), `skill-output` (`skill-output-summary`, `skill-output-empty`,
`skill-output-unavailable`), `skill-fill-in` (`skill-fill-in-run`), and `skill-examples`
(`skill-example`, `skill-example-add`, `skill-example-add-bad`, `skill-example-message`,
`skill-example-conversation`, `skill-example-source`, `skill-example-from-chat`,
`skill-example-violates`, `skill-example-pii-note`, `skill-examples-chat-hint`). The step editor
adds `skill-step`, `skill-ref-loading`, `skill-ref-none`, `skill-ref-retry`, `skill-ref-unread`.

## Studio: Forms

Route `/app/studio/forms` (`admin/Studio/Forms/FormsStudio.jsx`). List container `forms-list` with
one `form-row` per form; per row `form-status`, `form-meta`, `form-copy-link`, `form-open-routine`,
and `form-not-mine` when the form belongs to someone else. Around the list: `forms-count`,
`forms-new`, `forms-refresh`, and the states `forms-loading` / `forms-error` / `forms-retry`.
A form is created from its routine, so "new" leads into the Routines builder.

## Studio: Runs & log

Route `/app/studio/runs` (`admin/Studio/Runs/`). `executions-panel` is the run list;
`runs-scope-back` and `runs-scope-error` are the scope controls, `runs-org-not-live` the notice
when the org has no live runs. The "now running" strip is `now-running` with `now-running-list`
(rows `now-running-line`, each with `data-tone`), `now-running-open`, `now-running-more`, and the
states `now-running-loading` / `now-running-empty` / `now-running-unknown`.

## Studio: Solutions

Route `/app/studio/solutions` (`admin/Studio/Solutions/`). Overview: `solutions-create`,
`solutions-empty`, one `solutions-card` per solution and `solutions-catalogue-card` per catalogue
entry (`solutions-catalogue-install`, `solutions-catalogue-empty`). A card carries
`solution-card-sub`, `solution-card-chip`, `solution-card-health`, `solution-card-runs` (with
`data-state` = `idle` | `unknown` | …), `solution-card-update` (`data-state="available"` |
`"unknown"`) and `solution-card-counts-partial`. Detail: `solution-publish`, `solution-export`,
version rows `version-row` / ``versions-view-${id}`` / `version-note-row` /
`version-note-nosummary` / `version-omitted` / `version-unreadable-rows`. Upgrades:
`solution-update-available`, `solution-update-open`, `upgrade-confirm`, `upgrade-report`.

## Hard rules for tests

- **Never** use `page.waitForTimeout()` — wait on selectors/URLs (e.g. the
  `stop-generating-button` → `send-message-button` flip, `kb-detail-page`, `conv-row-*`).
- Credentials come **only** from environment variables / fixtures (`process.env`); never hardcode
  emails, passwords, or tokens in specs.
- Every entity a test creates (agent, KB, document title, chat message marker) MUST embed the
  provided `runId` in its name (e.g. `e2e-${runId}-kb`) so parallel runs don't collide and cleanup
  can find leftovers.
- Tests MUST clean up what they create (delete the agent/KB/conversation via the UI paths above)
  even on failure paths where practical (`test.afterEach`).
- Prefer `getByTestId`; when a flow has no testid use the exact quoted texts/titles above — do not
  guess alternative strings.
