# Coverage critique — Learning Center curriculum vs. the product fact sheets

Method: all 25 fact sheets in `facts/` were walked section by section (screens, concepts,
end-to-end workflows, settings). Every named screen, setting and workflow was searched against the
flattened text of all 85 authored lessons in `lessons/` (not just the lesson that "owns" the area),
so a topic counted as covered wherever it is actually taught. Items below are things no lesson
teaches, or teaches only in a passing clause.

Catalog note: `curriculum.json` lists 86 lessons, 85 have files. `getting-started` (course-foundations)
has no authored JSON — it is assumed to be the pre-existing product tour. If it is not, the entire
"where things live" orientation is missing.

---

## 1. Whole surfaces that are never taught (highest severity)

### 1.1 Projects — a sidebar destination with its own memory pool  · HIGH
`facts/search-research.md` §0 and `facts/memory.md` §2.5 describe **Projects** (`/app/projects`,
sidebar row **Projects** / **New Project**, Enterprise) as a collaboration workspace with tabs
*General · Chats · Content · Knowledge · Members · Activity · Memory · Danger*, plus the
per-conversation action **Remove from project**. Project memory is a **shared, third memory pool**
with its own type set (Instruction/Project/Fact/Context), a read-only state for view-only members
(*"You have view-only access to this project, so project memory is read-only."*) and a
**Extract Project Memories** checkbox in Project → Settings (default off).

Coverage today: the word "projects" appears only inside a list of Studio object kinds, plus one
sentence in `using-memory` about "her project pool". Nobody is taught what a Project is, how to make
one, who can see it, or that a conversation shared into a project is re-encrypted with an org-derived
key (`facts/org-encryption.md` §6.2 — i.e. the operator can read it).
→ **course-power**, new lesson `projects-shared-workspace`; one extra step in `using-memory` for the
three pools (personal / per-agent / project).

### 1.2 Templates — document assembly (`/app/templates`)  · HIGH
`facts/search-research.md` §0 and §2: a real sidebar surface for `.docx` templates with
`{{parameters}}`, header hint *"Upload .docx templates with {{parameters}} for AI to fill"*, per
template **Fill with AI** → **Generate Document**, failure text *"No {{parameters}} found in the
document to fill."*, and the notebook-side **AI fill**.
Coverage today: zero. Every "template" hit in the lessons is an automation template or a meeting summary
template. `research-notebooks` promises "export the document" and stops at PDF/Word download.
→ **course-research**, new lesson `templates-document-assembly`.

### 1.3 The app canvas by hand  · HIGH
`facts/apps.md` §2 documents the editor in detail: the component strip grouped
**Basics · Content · Layout · Data · Input · AI**, *"Click to add — or drag it onto the canvas"*,
**Add screen / Screen options / Set as home screen / Delete screen / Manage navigation…**,
*"An app needs at least one screen"*, per-component conditional rules **"Hidden in the running app"**
/ **"Only shown when {expr}"** / **"Only usable when {expr}"**, multi-select, and the
**View as role** / **Previewing as** / **Exit preview** capsule.
Coverage today: all four Apps lessons drive the AI builder, the data model, action wiring and roles.
The canvas is named but never operated — there is no lesson in which a learner adds a component,
adds a screen, sets a home screen, or hides a field from a role. `View as role` gets one clause in
the `apps-roles-and-publish` tour, although it is the only way to verify a row rule.
→ **course-apps**, new lesson `apps-edit-the-canvas` (and a "verify with View as role" step in
`apps-roles-and-publish`).

### 1.4 Compliance: Training & competence, AI literacy, and the Risk register  · HIGH
`facts/org-compliance.md` §3 gives each of these its own rail row and page:
- **Training & competence** — per member: policies acknowledged, platform learning progress,
  **Attest training** → **Record attestation**, **Re-attest**.
- **AI literacy (EU AI Act Art. 4)** — a Settings group; a legal obligation, not a nicety.
- **Risk register** — **Seed suggested risks**, **Add risk**, Likelihood 1–5 × Impact 1–5, score
  `L× I`, categories Confidentiality/Integrity/Availability/Compliance, statuses
  Open/Treating/Accepted/Closed, **review overdue**.
Coverage today: training and AI literacy: nothing. Risk register: named twice, both times only as
**Risk register (PDF)** inside the Stage-1 evidence pack — the register is never opened, scored or
reviewed.
→ **course-admin-trust**, new lessons `compliance-risk-register` and
`compliance-training-and-literacy`.

### 1.5 The public DSR intake form  · HIGH
`facts/org-compliance.md` §3 documents `/dsr` (also `/privacy/requests`, no login): **Privacy
request**, the six request types with their articles, the reference number, **Check an existing
request**, and `/dsr/verify?id=…&token=…` → **Identity confirmed**; plus the DSR section's own
**Public form** and **Settings** header tabs, and the footer note that the form is
*"rate-limited, linked from the privacy notice"*.
Coverage today: `compliance-dsr-and-incidents` teaches the inbox and the 30-day clock well, but only
says requests "sent through the public form are already in the list". Nobody is taught to switch the
channel on, publish its address, or how identity gets confirmed — the one part of the GDPR flow that
lives outside the admin's screen.
→ **course-admin-trust**, new lesson `compliance-public-dsr-form` (or a second half to
`compliance-dsr-and-incidents`).

### 1.6 Admin → AI configuration (the switchboard behind every tier)  · HIGH
Referenced from four sheets: `facts/memory.md` §2.8 (**Memory Extraction Model**, *"Defaults to the
Fast tier model when unset"*), `facts/meeting-notes.md` §3 (**Admin → Integrations → Transcription**,
**Active Provider**: Voxtral / Azure Speech / WhisperX / Scaleway / pyannoteAI),
`facts/search-research.md` §2 (**Admin → Integrations → Search**, Azure Bing / Serper / Agent Search
Service URL), `facts/org-users-access.md` §2.7 (**Azure Configuration → Chat Model Tiers**).
Coverage today: nothing. `chat-answer-depth` teaches "Bee Flow asks for depth, not a model name" —
correct for the user, but no lesson tells the admin who decides *which model each tier is*. On a
self-host this is the most consequential screen in the product.
→ **course-admin-operations**, new lesson `admin-ai-configuration`.

### 1.7 Datatable rows in daily use  · HIGH
`facts/datatables.md` §2 documents, on the table page: **Search the text columns…**, the filter
builder (**Show rows that match** / **all conditions** / **any condition** / **Add a condition** /
**Apply {n} conditions**), row editing (**Edit this row / Save this row / Delete this row**),
bulk **{n} rows selected → Delete selected**, paging (**Load more / Previous page / Next page**), the
**Dashboard** tab, **Check & repair** (*"The storage for this table has not been made yet." →
**Repair it***), **Rename table**, **Delete this table…** / **Unlink this table…**, and the AI path
**Build it with AI** → **Draft the columns**.
Coverage today: `datatables-create` covers scope, technical name, purpose, import/export;
`datatables-columns-safely` covers schema change. Filtering, searching, the dashboard, repair, and
deleting/unlinking a table other things depend on are untaught — and deletion is the dangerous one.
→ **course-data-and-forms**, new lesson `datatables-rows-and-repair`.

### 1.8 Cowork: "Run as agent" and the per-item Apps allow-list  · HIGH
`facts/cowork.md` §3.3/§4: chip 3 **Run as agent** with the **Agent sheet** (*"Who does the work?" —
"An agent brings its own skills, knowledge and connected apps."*, first row `No agent` =
*"Runs as a plain prompt"*); linking an agent means the result **also lands in that agent's chat
thread** and the tier is forced to `auto`; the **Apps** picker is a per-item allow-list where
*an empty list is a real answer* and an unreadable workspace list shows
*"App list unavailable — this run follows your workspace list"*.
Coverage today: the three Cowork lessons teach the brief, When/Repeat, notifications, pause, failures
and retention very well — but never the third chip. Two mentions of "apps", none of "run as agent".
→ **course-cowork**, new lesson `cowork-run-as-agent` (or a second half to `cowork-hands-on`).

### 1.9 Webpage share links  · HIGH
`facts/webpages.md` §2: **+ New link** → **Who can access this link?** with **Anyone with the link**,
**Password-protected**, **Email-gated (one-time link)**, **Expires**, **Create link**,
*"Share link created."*
Coverage today: `webpages-publish-and-public` teaches audience, the public address and the per-column
gate thoroughly, but the share-link ladder — the control an owner actually uses to send a page to one
customer — is absent.
→ **course-apps**, extend `webpages-publish-and-public` or add `webpages-share-links`.

### 1.10 Meeting Insights, and the org-level meeting settings  · HIGH
`facts/meeting-notes.md` §3: the **Insights** tab (**Overview / People / Flow / Topics / Follow-up**,
metrics **Balance / Interactivity / Silence**), the transcript tools (**Search transcript…**,
**What is this line?**, **Copy quote**, *"Already an action"*), **Ask AI** and **AI report** on a
note. Org side: **Settings → Organisation → "Talk Meeting Notes"** (which *overrides each member's
personal setting*) and **"Per-person meeting insights"** — an org switch that decides whether staff
are measured individually; plus **Settings → Organisation → Meeting Templates**
(*"Organization summary templates"*, Default badge, scope *Just me / Whole organization / group*),
described in `facts/org-academy-licence.md` §2.6.
Coverage today: Insights, Ask AI and the transcript tools: nothing. Org Talk settings and org meeting
templates: nothing in any admin lesson.
→ **course-meeting-notes**, new lesson `meetings-insights-and-transcript`;
**course-admin-operations**, new lesson `org-meeting-settings-and-templates`.

---

## 2. Settings and behaviours an admin or user will hit, taught nowhere  (medium)

| # | Gap | Fact sheet | Course / suggested lesson |
|---|---|---|---|
| 2.1 | **Media creation in chat** — composer **Create image, music, video** with tabs **Image / Music & TTS / SFX**, gated on org keys | chat-basics §2.4, search-research §2 | course-foundations · `chat-create-media` |
| 2.2 | **Voice mode (beta) and the mic** — *"Talk with your assistant instead of typing"*, **Dictate — speak your instruction** | chat-basics §2.4 | course-foundations · `chat-voice-and-dictation` |
| 2.3 | **Agent → Advanced settings → Behavior** — **Allow copying**, **Disable integrations & web search**, **Memory** (own private bucket) + **Also read from your general memory** | agents §3.3, memory §2.6 | course-build-agent · `agent-behavior-and-memory` |
| 2.4 | **Secondary triggers** — `definition.triggers[]`; only `webhook`, `app_event`, `schedule` may be secondary; dropping a primary-only trigger *replaces* the existing one | automations §3 | course-automations-production · `automation-extra-triggers` |
| 2.5 | **The Privacy Shield step inside an automation** — three modes (*Find personal data* / *Hide personal data* / *Show real values again*), placeholders minted into the run vault | automations §5, org-privacy-shield | course-automations-production · `automation-shield-step` |
| 2.6 | **Form appearance** — themes *Clean, Corporate, Friendly, Night, Match visitor* + **Corners / Spacing / Text size / Appearance**; and **"Stop collecting?"** | forms §3 | course-data-and-forms · extend `forms-audience-answers-and-links` |
| 2.7 | **Skill visibility** — a skill has the same **Publish to… Personal / Entire organisation / Or specific groups** capsule and the **"Share more widely?"** confirm | skills §3 | course-skills-automation · extend `skills-attach-and-apply` |
| 2.8 | **Personal Settings → Security** — password change, two-factor, sessions (the admin counterpart **"Reset two-factor authentication?"** is documented) | org-users-access §2.8, memory §2.1 (tab list) | course-power · `settings-account-security` |
| 2.9 | **License & Usage as a workflow** — **Change plan / Manage Billing / Subscribe / Cancel subscription**, **Plan limits** (Users / Agents / Knowledge sources), **cost cap / month** | org-academy-licence §2.4 | course-admin-operations · `admin-plan-and-billing` |
| 2.10 | **Org integration settings** — the **n8n** panel (Connection / Workflows / Permissions, **Test Connection**) and **Google Maps** key; distinct from the access matrix | org-integrations §2.1 | course-admin-essentials · extend `integrations-org-access` |
| 2.11 | **Extra compliance frameworks** — **More frameworks** (NIS2 · CRA · Data Act · PLD · EAA · DORA · Machinery · own), **Add framework**, the **relevance gate**, *locked* (licence) vs *disabled* (choice) | org-compliance §3, §4 | course-admin-trust · extend `compliance-setup-and-score` |
| 2.12 | **ZK caveat for meetings** — transcripts are keyed to the organisation, so on Zero-knowledge *the server operator can read a meeting transcript*. The sheet says: "Say this out loud in any lesson about meeting notes." No meetings lesson mentions encryption at all | org-encryption §6.2 | course-meeting-notes · step in `meetings-capture` |
| 2.13 | **Notebook sharing** — notebook **Members / Activity / Danger** tabs; who else can read a notebook | search-research §2 | course-research · extend `research-notebooks` |
| 2.14 | **Solutions: the scrub** — secrets/credentials stripped when a Solution is published or exported | solutions §4 | course-playbooks-solutions · extend `solutions-bundle-and-check` |
| 2.15 | **The consumer app surface** — **Apps** list, **Recently used / All apps**, categories *All · Sales · Service · Finance · HR · Internal*, *"Only what you are allowed to use appears here"*, *"This app is not available to you"* | apps §2 | course-apps · step in `apps-roles-and-publish` |
| 2.16 | **Knowledge freshness and deletion** — the freshness dot / *"updated {when}"* / refresh-failed state; deleting a base or a source and what it takes with it | knowledge §2, §3 | course-agent-knowledge · extend `knowledge-sources-and-refresh` |
| 2.17 | **Studio Start / the Studio map** — **"Needs attention"** (same grounding function the agent cards use) and the graph of what uses what | agents §9, apps §8 | course-build-agent · `studio-start-and-map` |
| 2.18 | **Playbook option forms** — the pre-run options (**Pick a table…**, **Approver group (optional)**, **Nextcloud folder with the invoices**, **Me (the owner)**) and *"Check the options."* | playbooks §2, §4 | course-playbooks-solutions · extend `playbooks-run-a-recipe` |
| 2.19 | **Self-hosted SSO extras** — **Allowed Domains**, Azure **Group Sync** settings (**Auto-activate synced users**, **Destructive sync** is taught, **Automatic periodic sync / Sync every**), required Graph permissions | org-users-access §2.6–2.7 | course-admin-essentials · extend `admin-joining-and-sso` |
| 2.20 | **Detail level of web search** — `basic` / `detailed` / `highly_detailed` (~300 tokens vs a full read): the cost/quality knob behind every search | search-research §3 | course-research · extend `research-web-and-browse` |

---

## 3. Lower-severity gaps (worth a step, not a lesson)

- **Agent conflict modal** — *"This agent changed elsewhere"* → **Load latest** / **Keep mine**
  (agents §3.3). Two people editing one agent is a normal Monday.
- **Admin → Security → Users**, the second user surface with the modals Users & Groups lacks:
  **Add new user**, **Delete this user?**, **Delete this group?**, **Reset two-factor
  authentication?** (org-users-access §2.8).
- **Custom model tiers** — `OrgCustomTiersPanel` is reachable only by URL (`/app/org-settings/users/customTiers`)
  and is named twice in `admin-groups-and-tiers` without being opened.
- **Per-user AI cost in the member list** — the *"cost · 30d"* column and its tooltip (org-users-access §2.3).
- **Chat search overlay** — the filter row (All/Agents/Direct, agent, date, **Relevance / Date**) is
  only partly covered by `chat-history-hygiene`.
- **Datatable AI column drafting** — **Build it with AI** → **Draft the columns** (datatables §2).
- **Meeting series**, **Used by** on a note, **Export as Markdown/Text**, **Copy transcript**.
- **Usage token kinds** — cached tokens, cache-creation tokens, reasoning tokens; and the
  "no export button" fact (org-usage §3, §10).
- **Answer Reuse at step level** — the per-step tick in the automation builder (org-ai-context §2.4) is
  taught only as an org switch in `org-context-and-reuse`.
- **Presenter mode** for playbooks (Shift+P), and the locale rule (a playbook follows the interface language).

Out of scope note: there is no fact sheet for the Support Studio inbox or the mobile (Expo) client, so
their coverage could not be assessed here — but no lesson teaches either.

---

## 4. Lessons whose coverage of their own area is thin

| Lesson | Why it is thin |
|---|---|
| `settings-preferences` | Owns the whole personal-settings area but teaches only Simple Mode, language, startup screen, appearance and phone behaviour. Silent on Settings → Security, notification preferences, the Memory row, Connections and Help & Support. Smallest-but-one lesson in the set. |
| `research-notebooks` | Sources in → ask → export. No Templates/AI Fill (§1.2), no Members/Activity/Danger, no command palette, no versions beyond one clause. |
| `meetings-capture` + `meetings-speakers-and-summary` | Capture, speakers and summary templates are strong; the Insights tab, transcript search, "What is this line?", **Ask AI** / **AI report** and the ZK transcript caveat are all missing. |
| `cowork-basics` | Excellent on the life of an item, but the **Run as agent** chip and the per-item Apps allow-list — two of the three chips' worth of decisions — are absent. |
| `apps-data-and-screens` | Title promises screens; the lesson is a data-model lesson. Screen creation, the component strip, home screen and conditional visibility never appear. |
| `datatables-create` | Create + import/export only. A learner leaves without being able to find a row (search, filter builder) or read the Dashboard tab. |
| `compliance-registers-and-iso` | ROPA, DPIA, SoA, policies and audits are solid; the Risk register appears only as a PDF in the evidence pack, and Training & competence is absent — two of the ten rail rows. |
| `compliance-setup-and-score` | Setup wizard, score and evidence chain are good; "More frameworks", the relevance gate and locked-vs-disabled are not taught, so an admin cannot switch NIS2 on. |
| `skills-attach-and-apply` | Attach / session / retire are covered; the skill's own audience capsule (Personal / org / groups) is not, so "write once, reuse" stops at your own agents. |
| `chat-attachments` | Files in, knowledge bases, web search. The rest of the composer's "+" menu — media creation, voice — is never opened. |
| `automation-anatomy` | The seven trigger kinds are taught as an exclusive choice; secondary triggers (`definition.triggers[]`) are not mentioned. |
| `knowledge-bases` | Freshness verdicts, duplicate-vs-overlap, system-managed bases and deletion consequences are each one clause or absent. |
| `forms-create-and-draft` | Questions and types are well covered; appearance/theme (five presets plus corners/spacing/text size) is untouched, though these forms face customers. |
| `integrations-org-access` | The access matrix is thorough; the **Integration settings** tab (n8n, Google Maps) — the half where credentials live — is not. |
| `org-usage` | Reads the report well but never names cached/reasoning tokens, and does not warn that there is no export. |

---

## 5. Where the curriculum is genuinely complete

Worth saying, because it narrows where the next authoring round should go: the **Privacy Shield**
course (all four admin lessons plus the three user lessons) covers the sheet almost item for item,
including the pre-flight modes, the "always show this check" checkbox, EU-only models, the What
happened KPIs and the sovereignty score. **Automations** (10 lessons) covers the whole step palette,
bindings, dry-run, journeys, approvals and failures. **Encryption**, **Solutions**, **Approvals** and
the **prompting** course are likewise faithful to their sheets.
