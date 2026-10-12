# Fact sheet — Skills (Studio → Skills)

Audience: **builder**. Verified against the working tree on branch `claude/builder-redesign-fase-1-6sun0h`, 2026-09-14.
Every label below is copied from the source (English default of the `t()` call or `agent-hub/src/i18n/en-defaults.js`).

Primary source files
- Frontend section: `agent-hub/src/components/admin/Studio/SkillsStudio/` (`index.jsx`, `SkillsList.jsx`, `SkillsOverview.jsx`, `SkillDetail.jsx`, `SkillStepEditor.jsx`, `RulesEditor.jsx`, `OutputFieldsCard.jsx`, `CanUseCard.jsx`, `FillInCard.jsx`, `ExamplesTab.jsx`, `TestTab.jsx`, `skillModel.js`, `skillsApi.js`, `useSkillPickerData.js`)
- Registry / nav: `agent-hub/src/components/admin/Studio/studioApps.jsx` (lines 309–355)
- Agent side: `agent-hub/src/components/agents/AgentWizard/canUse/SkillsCard.jsx`, `.../pickers/SkillPicker.jsx`, `.../BuilderSplit.jsx` (`openChooser`, line ~968)
- Automation side: `agent-hub/src/components/automation/Builder/flow/settings/agentStepFields.jsx` (`SkillChooser`, lines 440–515)
- Chat side (session skills): `agent-hub/src/components/skills/SkillsPopover.jsx`
- Backend: `server/routes/skills.js`, `server/routes/skills/{ai,test,examples}.js`, `server/stores/skillStore.js`, `server/stores/skillActivations.js`, `server/core/skills/{skillStructure,skillDraft,skillTest,skillSandbox}.js`, `server/core/tools/skillInjection.js`
- Product docs (mostly accurate, two corrections below): `docs/docs/studio/skills.md`

---

## 1. What the feature is for

A **skill** is a reusable *method* — a written way of working that you author once and attach in many places. It carries:
a summary, a "when to use it" instruction, ordered **steps**, always/never **rules**, the **fields it delivers**, and the
apps / automations / knowledge it **may use** while active.

The point is separation of concerns: an agent's own instructions describe *who it is*; a skill describes *how a specific
job is done*. Change the skill once and every agent and every automation AI step that names it changes at the same moment
("A change here applies everywhere at once" — the standing note in the editor).

A skill is **not** standalone. It never runs by itself. It reaches a model turn in exactly three ways:

1. attached to an agent (`agent.config.attachedSkillIds`) — picked in the agent builder;
2. applied by an automation **AI step** (`ai_step.skillIds`) — picked in the step's "Who does the thinking" section;
3. toggled on for one chat conversation from the composer Skills popover (session skills; the Flow tier also mints them).

URL: **`/app/studio/skills`** and `/app/studio/skills/<skillId>`. There is **no `/app/skills`** route — a legacy
`SkillsPanel`/`SkillsGrid` still exists in `agent-hub/src/components/skills/` but nothing navigates to it any more
(`useNavigateToPage.js` line 207 handles `page === 'skills'`, but no caller emits that page id).

---

## 2. Availability, permissions and gates

### Licence + beta (compound)
- `/api/skills` is mounted as `app.use('/api/skills', requireCapability('skills'), require('./routes/skills'))`
  (`server/index.js:922`).
- `skills` is in the **community** tier feature list (`server/license/tiers.js:83`) — it is *free core*, not Enterprise.
- `skills` is **also a beta feature**: `{ id: 'skills', name: 'Skills', description: 'Reusable instruction packs for
  consistent AI task execution', licenseFeature: 'skills', lifecycle: BetaLifecycle.BETA }`
  (`server/core/entitlements/betaFeatures.js:121`).
- Because both must hold, an org that never switched the beta on sees the Studio row **disabled with a hint**, not an
  empty section. The hint string is **"Not switched on for your organisation — ask an admin"**
  (`studio.locked_not_granted`); the "upgrade" variant is **"Available on a higher plan"** (`studio.locked_upgrade`).
  Registry: `gate: ({ can }) => can('skills')`, `gateCapability: 'skills'`, `lockOn: 'disable'`.
- Where an admin grants it: **Admin → Access & permissions** (`AccessPermissionsPanel`) — left rail **Grants**
  (capability matrix: "All members" + per group) and **Ceiling** (what the plan/licence permits; super-admin editable,
  org-admin read-only). The ceiling's section heading for this kind is **"Beta features"**.
  On cloud the subscription plan's `allowed_beta_features` must contain `skills`.

### Role permission
- Writes are gated by **`manage_skills`**. In `server/config/orgRoles.json` it ships with:
  - `org_admin` ("Organisation Admin")
  - `agent_admin` ("Agent Admin")
  - `agent_editor` ("Agent Editor")
  - **not** `member`, `dpo`, `isms_auditor`.
- Server routes carrying `requirePermission('manage_skills')`: `POST /`, `PUT /:id`, `POST /:id/examples/from-message`,
  `GET /examples/conversations`, `GET /examples/conversations/:id/messages`, `POST /ai/draft`,
  `POST /:id/ai/improve`, `GET /test-agents`, `POST /:id/test`, `GET /:id/test-runs`.
- **Ungated reads** (any authenticated user who passes the capability gate): `GET /`, `GET /usage-summary`,
  `GET /:id`, `GET /:id/usage`. `DELETE /:id` is not permission-gated on the route; ownership (or admin) is settled in
  the store.
- Frontend `canManage` in `SkillsStudio/index.jsx` is deliberately broader than the server:
  `hasPermission('manage_skills') || hasPermission('manage_agents') || user.isAdmin || user.role === 'admin' ||
  ['admin','org_admin','agent_admin','agent_editor'].includes(user.orgRole)`. The server re-checks every write.

### Row-level editability
`canEditSkill(skill, userId, { orgId, canManage })` (`skillStore.js:249`): you need `manage_skills`, **and** either you
own the skill (`skill.userId === userId`) **or** the skill belongs to *your own* org. A manager of another org never
matches. A skill you can see but not edit answers **403 `not_editable`** — deliberately not 404, so the 350 ms autosave
stops retrying.

### Suspended org
`router.use(requireActiveOrgForMutations())` blocks every write when the caller's org is suspended/archived.

---

## 3. Screens and their real labels

### 3.1 Getting there
Studio rail → category **AI** → **Skills** (`studio.tab.skills` = "Skills", description `studio.tab.skills_desc` =
"Reusable abilities for your agents", icon `Sparkles`, kind colour `--kind-skill`).
The Studio **New** menu has an entry **"Skill"** (`studio.new.skill`) which posts an untitled skill and opens it.

### 3.2 Left column — the skill list (`SkillsList.jsx`)
- Header title: **"Skills"** (`skills_studio.title`).
- Create button: a round **+** with aria-label/title **"Create skill"** (`skills_studio.create`); only drawn when
  `canCreate`.
- Search box placeholder + aria-label: **"Filter…"** (`skills_studio.filter`).
- Row = icon (default ⚡) + name (or **"Untitled skill"**) + subline `usageSubline`:
  - `"3 agents · 1 automation"` (singular/plural via `{count} agent` / `{count} agents`)
  - `"not linked yet"` (`skills_studio.usage.none`) when both counts are a real 0
  - `"not counted"` (`skills_studio.usage.unknown`) when the server could not scan automations
  - `"draft · empty"` (`skills_studio.meta.empty`) for a skill with no steps and no description
  - `''` (blank) when `/usage-summary` has not answered — **blank is not zero**
- Three different empty states, never one:
  - loading: **"Loading skills…"**
  - read failed: **"Could not load the skills."** (`skills_studio.err_list`, warning colour, `role="status"`)
  - filter matched nothing: **"No skill matches “{query}”."**
  - genuinely empty: **"No skills yet — create one with the + button."**

### 3.3 Landing (nothing selected) — "All skills" table (`SkillsOverview.jsx`)
Header: **"All skills"** + row count + a sort menu (**"Sort: {mode}"**, aria **"Sort skills"**) with three modes:
**"most used"** (default, `used`), **"last used"** (`recent`), **"name"**.

Four columns:

| Column header | Content |
|---|---|
| **Skill** | Name + meta line `"4 steps · 3 rules · 2 examples"`, or `"draft · empty"` |
| **Used by** | `"3 agents · 1 automation"`, or an em dash when unknown |
| **Last time** | Relative time the skill last actually fired (from `skill_activations`); em dash when never |
| **Test** | Last Test verdict: **"ok"** / **"{count} advice"** / **"failed"** / **"not tested"** |

An **empty** skill's Test cell shows an offer instead of a verdict: **"Let AI fill it in"**
(`skills_studio.overview.fill`) — clicking it *opens* the skill (it does not rewrite from the table).

Empty-org state (only when the read succeeded and no filter is active):
title **"Create your first skill"**, body **"Skills are reusable instruction packs you can attach to any agent. Create
one to define how an agent should behave in a specific situation."**

### 3.4 Skill detail — shared Studio header
- Back link: **"All skills"**.
- Title is inline-renameable (`onRename`), save chip is the shared `SaveStatus`.
- Visibility capsule (`VisibilityCapsule`): **"Publish to…"**, **"Personal"** ("Only you can access") /
  **"Entire organisation"** ("All members can access") / **"Or specific groups"**. Widening asks
  **"Share more widely?"** with **"Share"** / **"Keep as is"**. If groups cannot be read:
  "The list of groups could not be read, so sharing with specific groups is not offered right now. That is not
  “this organisation has no groups”."
- Primary action (hidden in read-only): **"Improve with AI"** → **"Improving…"** while running.
- Read-only banner: **"You can see this skill but not change it. Ask its owner, or an admin of the organisation it
  belongs to."**
- Four tabs: **Method** · **Examples** (with a count badge) · **Test** · **Used by** (with a count badge).

### 3.5 Tab: Method
Two text cards on top, then steps beside a right rail.

- **"What this skill does"** — placeholder *"Short summary of what this skill does"*.
- **"When to use it"** — placeholder *"When and how the agent should use this skill (max 4000 chars)"*.
  Past 90 % of the limit a hint appears: **"{count} characters left"**.
- **"Steps"** (hint *"in this order · drag to rearrange"*)
  - empty: **"No steps yet. Write down what the agent should do, one step at a time."**
  - per step: label **"Step {n}"**, placeholder *"What happens in this step?"*, **"Remove step"**,
    **"Reorder step {n}"**, and a **"reference"** button that adds a **reference pill** pointing at a
    **Automations** / **Knowledge bases** / **Tables** item (`skills_studio.ref.*`). If nothing can be referenced:
    **"Nothing to reference yet."**
  - **"Add step"**
- **"Rules"** (hint *"always, whatever the question"*)
  - empty: **"No rules yet. A rule holds for every answer this skill gives."**
  - each rule is a sentence plus a polarity button: **"Always"** / **"Never"**; tooltips
    **"Change to “always do this”"** / **"Change to “never do this”"**; placeholder
    *"One sentence — what always holds?"*; **"Add rule"**, **"Remove rule"**.
- **"Delivers"** (hint *"fields an automation can use"*)
  - empty: **"No fields — this skill answers in its own words."**
  - a read-back line **"How an automation will see these"** names each field in the product's own vocabulary
    (text, number, yes-no, date, one of a list, table) while the row editor underneath edits raw JSON types
    (string / number / boolean / datetime / object / array). If the shared row editor is unavailable:
    **"These fields can only be edited from an AI step for now."**
- **"May use"** (hint *"within this skill"*) — three grant lists rendered as pills, plus a **"link"** menu:
  - **Apps** (`enabled_integrations`) → **"Browse apps…"** opens the same apps picker the agent builder uses
  - **Automations** (`allowed_automation_ids`) — only automations whose trigger is *an agent calls it*
  - **Knowledge** (`knowledge_base_ids`)
  - nothing left to link: **"Nothing else to link. An automation appears here once its trigger is “an agent calls it”."**
  - a list that failed to load: **"Some of these lists could not be read, so this is not “nothing to link”."** + **"Try again"**
  - unlink control: **"Unlink {name}"**; missing names fall back to **"Automation {id}"** / **"Knowledge base {id}"**
  - **"All options"** disclosure holds:
    - **"Dynamic activation"** with help *"When on, the agent decides at runtime whether to apply this skill based on
      the user message."*
    - the legacy linked-automation note: **"This skill runs automation {id} instead of its own steps. Steps, rules and
      examples are ignored while that is set."**
- Standing note at the bottom of the rail:
  - **"No agent or automation uses this skill yet."**, or
  - **"Used by {count} agents and automations. A change here applies everywhere at once."**, or (when a kind could not
    be scanned) **"Not everything could be checked, so this list may be short. A change here applies everywhere at once."**
- On a brand-new, still-empty skill a card appears above everything: **"Start from one sentence"**, label
  **"What should this skill do?"**, placeholder *"Describe in one sentence what this skill should do…"*, button
  **"Let AI fill it in"** → **"Writing…"**. Success toast: **"Filled in with AI. Read it through before you rely on it."**

### 3.6 Tab: Examples
- Intro: *"Examples show what it should look like. Two or three good ones are enough; a bad one helps with things the
  agent keeps getting wrong."*
- Card fields: **"When someone asks"** → **"Good answer"** → **"Why this is good"**; optional
  **"Add an answer to avoid"** which creates a **"Not like this"** half plus **"Rule it breaks"**
  (or **"No specific rule"**; a deleted rule reads **"The rule this broke was removed"**).
- **"Pick from a conversation"** — help: *"Only your own conversations are listed. Personal data is removed before the
  example is stored."* Inside: **"Back to conversations"**, **"Untitled conversation"**,
  **"No conversations of your own yet."**, **"Nothing in this conversation to use."**
  Imported cards are marked **"Taken from a conversation"** / *"Taken from one of your conversations · personal data removed"*.
- Failure lines that refuse to lie: **"Your conversations could not be read just now, so none are listed. That is not
  “you have none”."** and **"This conversation could not be read just now. That is not “there is nothing in it”."**
- Caps: **"This skill already has the maximum number of examples."**, **"Could not use that message."**
- Empty: **"No examples yet."**

### 3.7 Tab: Test
- Header **"Test"**, hint *"one question through the steps"*.
- Agent selector: **"Just this skill"** or **"as agent"** (+ a named agent).
- Question field placeholder: *"Ask something this skill should handle…"*; button **"Run"** → **"Running…"**.
- Results: **"What the agent answered"** (streams first), then **"Per step"** with **"Advice"**, **"no advice"**, and
  **"Open what this step uses"** links; plus **"Earlier runs"** (history).
- Refusals and failures, each with its own sentence:
  - **"Add steps first — a test grades one step at a time."** (button disabled state)
  - **"This skill has nothing to follow yet — write the steps first."** (`empty_skill`)
  - **"No AI model is configured for this workspace."** (`no_model`)
  - **"Could not check which agents you may use. Try again."** (`agent_check_failed`)
  - **"Could not load your agents, so a test cannot run as one."**
  - **"Could not check which knowledge bases this skill may use, so no test was run. Try again."** (`kb_check_failed`)
  - **"The model returned no answer, so there is nothing to grade."** (`no_answer`)
  - **"The answer came back, but it could not be graded. Try again."** (`grading_failed`)
  - **"The test stopped before a verdict came back, so nothing was graded or saved. Try again."**
  - **"Could not load earlier runs, so the test history is unknown."**
  - **"Could not run this test."** (generic)

### 3.8 Tab: Used by
- Rows = agents that attach the skill, and automation **AI steps** that apply it (with `step <label>`).
- Empty: **"No agent or automation uses this skill yet."**; partial:
  **"Not everything could be checked, so this list may be short. A change here applies everywhere at once."**
- Bottom of this tab only: the shared **danger zone** → **"Delete skill"**, notice
  **"Agents that attach this skill lose the behaviour immediately."**, and it requires typing the skill name
  (`requireName`).

### 3.9 The agent side (Agent builder → "Can use" tab)
Card **"Skills"**, subtitle **"The working methods it follows"**, action button **"Link"**.
- empty: **"No skills attached yet — the agent works from its instructions alone."**
- row subline: *"5 steps · 3 rules · also used by 2 other agents"* (the "other" figure is the usage summary minus this
  agent, and only when this agent is in the **saved** config)
- failure lines: **"Could not load the skills, so their names and steps are missing here."**,
  **"Attached, but this skill could not be read — so what it does is unknown."**,
  **"One or more attached skills are not in the list you can see — they still run."**,
  **"Could not read which other agents use these skills, so that is left unsaid."**
- **"Link"** today jumps to the **Role** tab and opens the older `SkillPicker` popover (`BuilderSplit.openChooser`):
  search placeholder **"Search skills"**, **"Create a new skill"**, **"Create & attach"**, fields
  **"Skill name"**, **"Short description (optional)"**,
  **"Instructions: when and how the agent should use this skill"**, and
  **"Linked automation (optional)"** with **"— No automation, use instructions above —"** and the help
  *"When the agent activates this skill, the linked automation runs and its result is returned to the agent."*
  Empty list: **"No skills yet — create one below."** A skill with a linked automation shows a small **Flow** badge.

### 3.10 The automation side (AI step)
Automation editor → an `ai_step` → section **"Who does the thinking"** → **"Skills for this step"**, hint:
*"A skill is a written way of working. The first one leads: it is the one whose instructions come first, and whose
output fields the step inherits. With an agent, the step's skills come before the agent's own."*
The first-picked skill wears a **"Leading"** pill. At the cap:
**"That is the most a step can use (5). Remove one to pick another — the first one stays the leading skill."**
Other lines: **"No skills yet — write one under Skills first."**,
**"The list of skills could not be read. Any skills this step already uses are kept."**

### 3.11 The chat side (session skills)
Composer tools menu → **"Skills"**, hint *"Toggle reusable instruction packs for this chat"*.
Labels: **"{count}/{max} active"**, **"Maximum {count} skills active"**, **"Attached by agent"** /
*"Attached by this agent — always on"*, **"Create new skill"**, **"Import"** / **"Imported"** /
**"Import into skill library"**. Flow-tier session skills add **"Flow Stages"**, **"{done}/{total} done"**,
**"Regenerate"**, and the states **"Ready"** / **"Active"** / **"Done"** / **"Needs {names}"**.

---

## 4. Concepts a learner must understand

- **Skill** — a reusable, named method (summary, when-to-use, steps, rules, delivered fields, grants) that is attached
  to agents or applied by automation AI steps. It never runs on its own.
- **Method (tab)** — the body of the skill: what it does, when to use it, the steps, the rules, what it delivers, what
  it may use.
- **Step** — one ordered sentence of the method. May carry **reference pills** to an automation, a knowledge base or a table.
- **Rule** — a statement that holds for every answer, marked **Always** or **Never** (`polarity: 'must' | 'never'`).
- **Delivers / output fields** — the typed fields a skill hands back (`output_schema`, same shape as an AI step's
  `outputSchema`). An automation's AI step inherits the **leading** skill's fields.
- **May use (grants)** — three lists: **Apps** (integration tools), **Automations** (offered as callable tools; only
  *agent-call* triggers qualify), **Knowledge** (joined into the search allowlist). It is a *request*: ownership and
  entitlement are re-checked when a tool is actually dispatched.
- **Static vs dynamic activation** — static (the default) puts the skill's full body in the system prompt on **every**
  turn. Dynamic puts only a one-line manifest entry in and the model calls the `activate_skill` tool when the message
  actually matches. Grants follow the same split: a dynamic skill contributes **no** apps/automations/tables/knowledge
  until it has been activated in that conversation.
- **Leading skill** — on an automation AI step, the first skill in the list: its instructions come first and its output
  fields are merged into the step's own.
- **Attached vs session skill** — attached lives on the agent's config and is always on; a session skill is toggled by
  the user for one conversation and can be **imported** into the library.
- **Linked automation (legacy `automation_id`)** — a per-skill scalar that makes the automation **replace** the skill body
  entirely; steps, rules and examples are ignored while it is set. Old, powerful, and explained in the UI rather than
  hidden.
- **Activation record** — a row in `skill_activations` written whenever a skill actually reaches a turn
  (`source`: `static`, `activate_skill`, `ai_step`, `test`). This is what "Last time" reads.
- **Test run** — one sandboxed agent turn plus a grading pass, stored in `skill_test_runs`; the latest one is the
  overview's Test verdict.
- **canEdit** — a per-row flag on every skill the API returns. Visible ≠ editable.

---

## 5. End-to-end workflows (click by click)

### W1 — Write a skill from scratch and attach it to an agent
1. Open **Studio** → under **AI**, click **Skills**. The "All skills" table opens.
2. Click the **+** button (title **"Create skill"**) in the list header. A skill named **"Untitled skill"** is created
   immediately (`POST /api/skills`) and opens.
3. Click the title in the header and rename it.
4. In **"What this skill does"** type a one-line summary.
5. In **"When to use it"** describe when the agent should reach for it (max 4000 characters).
6. In the **Steps** card click **"Add step"** and write one sentence per step; drag the handle to reorder.
7. On a step that should use a source, click **reference** and pick a **Automation**, **Knowledge base** or **Table**.
8. In **Rules** click **"Add rule"**, type the sentence, and click the polarity button to flip **Always** ↔ **Never**.
9. In **"May use"** click **link** → add the apps (**"Browse apps…"**), automations and knowledge bases the skill needs.
10. Use the visibility capsule in the header to choose **Personal** / **Entire organisation** / specific groups.
    Everything autosaves 350 ms after the last keystroke; the header chip shows the state.
11. Open **Test**, type a realistic question, click **Run**, read the answer, then the per-step verdicts.
12. Go to **Studio → Agents**, open the agent, tab **Can use** → card **Skills** → **Link** → tick the skill in the
    popover (it lands on the **Role** tab), then save/publish the agent.
13. Back in Skills, tab **Used by** now lists that agent.

### W2 — Let the AI draft the skill from one sentence
1. Studio → **Skills** → **+**.
2. On the still-empty **Method** tab the card **"Start from one sentence"** appears.
3. Type the sentence under **"What should this skill do?"** (max 1000 characters).
4. Click **"Let AI fill it in"** (button shows **"Writing…"**).
5. `POST /api/skills/ai/draft` returns a draft; name, summary, when-to-use, steps, rules, examples and delivered fields
   are filled in and autosaved. Toast: **"Filled in with AI. Read it through before you rely on it."**
6. Read every step and rule and edit them. The model is **not** allowed to invent grants, audience or references — it
   can only write text and structure.
7. Optionally click **"Improve with AI"** in the header for a rewrite of an existing skill (this one **persists**
   immediately and answers with the stored row; toast **"Updated with AI."**).

### W3 — Add an example taken from a real conversation
1. Open the skill → tab **Examples**.
2. Click **"Pick from a conversation"**.
3. Pick one of **your own** conversations (only yours are listed), then one assistant message from the last 40 offered.
4. The preview is shown with Privacy Shield tokens left as tokens and a fresh PII scan applied.
5. Confirm; the message becomes the **"Good answer"** half of a new example card, tagged **"Taken from a conversation"**.
6. Fill in **"When someone asks"** and **"Why this is good"**.
7. Only if the agent keeps getting one specific thing wrong, click **"Add an answer to avoid"** and pick the rule under
   **"Rule it breaks"**.

### W4 — Test a skill and read the verdict
1. Open the skill → tab **Test**.
2. Choose **"Just this skill"** or **"as agent"** + one of your agents (only agents you may actually use are listed).
3. Type the question; click **Run**.
4. The answer streams under **"What the agent answered"**.
5. When the stream ends, **"Per step"** shows one verdict per gradable step; anything the grader stayed silent about
   arrives as a warning with its own sentence, never as "ok".
6. The run is stored; the overview's **Test** column now reads **ok** / **{n} advice** / **failed**.
7. **"Earlier runs"** shows the last 20 runs for this skill (visible only to people who may edit it).

### W5 — Apply a skill inside an automation
1. Studio → **Automations** → open the automation → click an **AI step**.
2. Open the section **"Who does the thinking"**.
3. Under **"Skills for this step"** tick up to **5** skills. The first one ticked wears the **Leading** pill.
4. (Optional) also pick **"Which agent"**; the step's skills come *before* the agent's own skills.
5. The leading skill's **Delivers** fields become the step's outgoing fields — map them in later steps.
6. Save the automation; the skill's **Used by** tab now lists the automation and the step label.

### W6 — Retire a skill safely
1. Open the skill → tab **Used by** and read the list (and any "could not be checked" line).
2. Scroll to the danger zone → **"Delete skill"**.
3. The dialog warns **"Agents that attach this skill lose the behaviour immediately."** and requires typing the skill name.
4. If anything still uses it the server answers **409 `in_use`** with the usage list; you must confirm the breakage
   (`confirmBreaking: true`) to proceed.
5. After deletion the server scrubs the id from every agent in the org (`agentStore.scrubSkillFromAllAgents`);
   a failure there is non-fatal and leaves a dangling id the runtime ignores.

---

## 6. Defaults and limits (numbers)

| Thing | Value | Where |
|---|---|---|
| Default icon | `⚡` | `skillStore.mapRow`, `studioApps.jsx` create body |
| Default name of a new skill | "Untitled skill" | `SkillsStudio/index.jsx`, `studioApps.jsx` |
| Default visibility | Personal (`isShared: false`, `sharedGroups: []`) | create body |
| Default activation | **Static** (`dynamicActivation: false`) | create body |
| Autosave debounce | **350 ms** after last keystroke (in-flight save re-queues after 120 ms) | `SkillDetail.jsx` |
| "When to use it" limit | **4000 characters** (server 400s past it; warning hint from 90 % = 3600) | route + `SkillDetail.jsx` |
| Max steps | **60** | `skillStructure.MAX_STEPS` |
| Max rules | **60** | `skillStructure.MAX_RULES` |
| Max examples | **40** | `skillStructure.MAX_EXAMPLES` |
| Max delivered fields | **40** stored (AI draft writes at most **12**) | `skillStructure.MAX_OUTPUT_FIELDS` / `skillDraft.MAX_OUTPUT_FIELDS` |
| Max options in a "one of a list" field | **50** | `skillStructure.MAX_ENUM_OPTIONS` |
| Max ids per grant list (KBs, automations) | **100** | `skillStructure.MAX_ID_LIST` |
| Max characters per text field in structure | **4000** | `skillStructure.MAX_TEXT` |
| Max example half length | **4000 characters** | `routes/skills/examples.js` |
| Skill name / description caps (AI draft) | 200 / 1000 characters | `skillDraft.js` |
| "one sentence" brief for AI draft | **1000 characters** | `skillDraft.MAX_SENTENCE_CHARS` |
| **Skills active per chat turn** | **5** (attached first, then session, deduped, truncated) | `skillInjection.SKILL_CAP` |
| Skills per automation AI step | **5** (`MAX_AI_STEP_SKILL_IDS`); extra ones warn `ai_step.skill_ids_ignored` | `formState.js`, `automation/validate/constants.js` |
| Apps per skill | **50** (`SKILL_INTEGRATIONS_CAP`) | `skillInjection.js` |
| Test runs kept per skill | **20** (`TEST_RUNS_KEEP`) | `skillStore.js` |
| Test question length | **2000 characters** | `skillTest.MAX_QUESTION_CHARS` |
| Test tool rounds | **3** (`MAX_TOOL_ROUNDS`); answer/grade budget 1200 tokens each | `skillTest.js`, `routes/skills/test.js` |
| Test sandbox tool list | exactly one tool: **`kb_search`** (read-only, built not filtered) | `skillSandbox.js` |
| Rate limit — AI draft/improve | **10 per minute per user** (2000 max tokens, fast tier) | `routes/skills/ai.js` |
| Rate limit — test runs | **6 per minute per user** | `routes/skills/test.js` |
| Example picker window | last **200** messages readable, **40** offered (assistant turns only) | `routes/skills/examples.js` |
| Activation retention | **180 days** | `skillActivations.RETENTION_DAYS` |
| Number of skills per org | **no quota** found anywhere | — |
| `version` bump | on content change only — not on sharing or icon change, not on a no-op save | `skillStore.js` header |

---

## 7. What happens on failure

- **List read fails** → the column and the landing both show **"Could not load the skills."** and never
  "No skills yet". The usage summary is a *separate*, non-fatal read: if it fails the subline is blank, not "0".
- **Save gets 403 `not_editable`** → the editor locks into read-only, the retry loop stops, one toast.
- **Save gets 400 `invalid_structure`** → toast **"Could not save “{field}” — check that field."**, the draft stays
  dirty so the next edit retries.
- **Delete with dependants** → `409 in_use` with `{ usage, unchecked }`; the dialog shows the list before asking again.
- **AI draft/improve returns unusable output** → `502 ai_unusable`; nothing is written. Half a skill is never saved
  over somebody's work.
- **Test fails** → an explicit code and sentence (see §3.7). A run that could not be graded shows the failure, not an
  empty result list; a stream that ended without a verdict says so; a step the grader skipped becomes a **warning**.
- **Example write with no PII scan** → `503 pii_unchecked`. A screen that promises personal data is removed may not
  store text nothing looked at.
- **Automations table missing on the install** → the usage scan returns `unchecked: ['automation']` and every claim
  narrows ("not counted", "this list may be short") instead of reading as zero.
- **Grant list can't be read** → pills keep an id fallback ("Automation {id}") and a note explains the gap, so nothing
  looks deleted.
- **A deleted skill still referenced by an agent** → the runtime just ignores the dangling id.

---

## 8. How Skills connect to the rest of the product

- **Agents** — `agent.config.attachedSkillIds`; the agent builder's "Can use" tab card **Skills**; the agent's published
  copy counts too (`COUNT(DISTINCT agent_id)` across draft + published).
- **Automations (automations)** — `ai_step.skillIds`; the leading skill's `outputSchema` becomes the step's outgoing
  fields. Also the other direction: an automation with an **agent-call** trigger can be granted to a skill under **May use**.
- **Knowledge bases** — `knowledge_base_ids` + `kb` reference pills join the agent's search allowlist while the skill is
  active; the Test tab only ever searches bases the *caller* may read.
- **Datatables** — `table` reference pills become `{ id, scope: 'own', readOnly: true }` entries in the
  `datatable_query` allowlist.
- **Integrations / apps** — `enabled_integrations`; the same catalog filter the agent builder uses, so an app the org
  has not connected is not offered. Runtime entitlement still decides.
- **Privacy Shield / PII guard** — the example picker reads conversations unrestored and re-scans with `detectPii` +
  `tokenizeText` before showing *or* storing.
- **Chat (direct)** — the composer Skills popover; Flow tier session skills; `activate_skill` tool.
- **GitHub sync** — a skill round-trips as `skills/<id>/skill.json` + `instructions.md` + `rules.md` + `examples.md` +
  `workflow.md` (`server/services/githubSyncService.js`).
- **Studio search & counts** — `GET /api/studio/search?q=` and `GET /api/studio/counts` both carry a `skills` key.
- **Mobile** (`mobile/src/features/skills`) — full CRUD, but with the **six text fields only**; the server keeps text
  and structure in sync per facet so a phone edit is never overwritten by the Studio and vice versa.
- **Learning Center** — there is already a lesson `creating-skills` ("Creating a skill", 4 min, group `building`,
  gate `{ permission: 'manage_skills', feature: 'skills' }`) inside the course "Skills & Automation".

---

## 9. Common mistakes (and corrections to existing material)

1. **Expecting a skills marketplace.** There is none. Skills are not browsed, installed, published publicly, forked or
   versioned for distribution. (The empty folder `docs/docs/img/screenshots/studio/skills-marketplace/` is a naming
   leftover, not a feature.)
2. **"Package a skill in a Solution to move it."** — *wrong today*. Solution packaging covers
   `['automations','apps','webpages','datatables','agents','knowledgeBases']` only
   (`server/projects/packaging/manifest.js:52`), and `scrub.js` explicitly strips an agent's `attachedSkillIds` on
   capture. The only export path that carries a skill is **GitHub sync**. The product doc
   (`docs/docs/studio/skills.md`) still claims the Solution route — do not repeat it.
3. **The existing `creating-skills` lesson describes the old shape** (Instructions / Workflow / Rules / Examples) and
   its tour step targets `[data-tour="skill-create"]`, which now exists **only** in the dead
   `components/skills/SkillsGrid.jsx`, not in the new `SkillsStudio/SkillsList.jsx`. The step is `optional: true`
   with a 6 s timeout, so it degrades silently — but the highlight never appears. New lesson copy should use the
   current vocabulary (Method / Examples / Test / Used by) and either add a `data-tour` anchor to the new list or drop
   the anchor.
4. **Confusing "blank" with "zero".** In the list, the overview and the Used-by tab, an em dash or a blank subline means
   *not counted*, not *nobody*. Teaching "0 agents" off a blank is teaching the one lie the section is built to avoid.
5. **Putting a scheduled automation under "May use".** Only an *agent-call* trigger automation is dispatchable as a tool;
   anything else is a promise nothing keeps, and the picker hides it.
6. **Assuming a step reference is a grant.** A step that *references* an automation is presentation only — the automation must
   also be in **May use** (`allowed_automation_ids`) to be callable. (KB and table references *do* grant.)
7. **Attaching more than five skills to one agent.** The runtime caps the merged list at **5** per turn, attached first.
   The sixth silently never reaches the prompt.
8. **Turning on Dynamic activation and expecting the grants immediately.** A dynamic skill contributes *nothing* —
   no apps, no automations, no tables, no knowledge — until the model has called `activate_skill` in that conversation.
9. **Leaving a legacy `automation_id` set.** The automation then *replaces* the whole skill body; steps, rules and
   examples are ignored. People edit steps for an hour and wonder why nothing changes.
10. **Assuming visible = editable.** A skill shared to a group is visible to people who may not edit it; they get the
    read-only banner and a 403, and they cannot see its test history either.
11. **Adding a "Not like this" example too early.** A wrong answer in the prompt is text the model has now read; it
    earns its place only once the good half exists and the agent keeps getting one specific thing wrong.
12. **Expecting the Test tab to do real work.** The test is sandboxed and read-only: the only tool available is
    `kb_search`. Nothing is sent, written or called out.
13. **Deleting from the list.** There is no delete in the list or a ⋯ menu — it lives at the bottom of **Used by**, on
    purpose, next to what deleting would break.

---

## 10. Three scenarios for Van Dijk Groep (Dutch SME)

### S1 — Procurement: "Offerte beoordelen" (assess a supplier quote)
- **Skill name**: *Offerte beoordelen*
- **What this skill does**: "Beoordeelt een binnengekomen leveranciersofferte tegen ons inkoopkader en geeft een advies."
- **When to use it**: "Zodra iemand een offerte, prijsopgave of tarievenlijst van een leverancier deelt."
- **Steps**: (1) haal leverancier, geldigheidsduur, levertijd en betaaltermijn uit de offerte; (2) zoek de vorige
  afspraken met deze leverancier op — *reference: knowledge base "Inkoopkader & raamcontracten"*; (3) vergelijk de
  regelprijzen met de laatst afgesproken staffel — *reference: table "Prijslijst leveranciers"*; (4) benoem afwijkingen
  groter dan 5 %; (5) geef een advies: akkoord / onderhandelen / afwijzen, met één reden per punt.
- **Rules**: **Always** "noem het offertenummer en de datum in het antwoord"; **Always** "reken in euro's exclusief
  btw"; **Never** "bevestig of accepteer een offerte namens Van Dijk Groep".
- **Delivers**: `leverancier` (text), `offertenummer` (text), `totaal_excl_btw` (number), `afwijking_pct` (number),
  `advies` (one of a list: akkoord / onderhandelen / afwijzen).
- **May use**: knowledge base *Inkoopkader & raamcontracten*; table *Prijslijst leveranciers*.
- **Attach to**: agent *Inkoopassistent*. **And** apply it as the leading skill on the AI step of the automation
  *Offertes uit de inkoopmailbox*, so the automation's later steps can write `advies` into a datatable.

### S2 — HR: "Sollicitatiebrief samenvatten" (screen an application)
- **What this skill does**: "Vat een sollicitatie samen tegen de eisen in de vacaturetekst en stelt drie vragen voor
  het eerste gesprek voor."
- **Steps**: (1) lees de vacature-eisen — *reference: knowledge base "Vacatures 2026"*; (2) vat werkervaring en opleiding
  samen in maximaal vijf regels; (3) markeer per harde eis: voldaan / onduidelijk / niet voldaan; (4) stel drie
  gespreksvragen voor over de onduidelijke punten.
- **Rules**: **Never** "noem leeftijd, geslacht, nationaliteit, geloofsovertuiging, gezondheid of woonplaats";
  **Never** "geef een aannemen/afwijzen-besluit"; **Always** "citeer letterlijk uit de brief bij een 'niet voldaan'".
- **Delivers**: `kandidaat_referentie` (text), `eisen_voldaan` (number), `aandachtspunten` (text),
  `gespreksvragen` (text).
- **May use**: knowledge base *Vacatures 2026* only — **no** apps, so the skill can never mail or post anything.
- **Visibility**: share with the group **HR** only (not the whole org), because the method encodes hiring policy.
- Teaching point: this is the scenario where a **Never**-rule and an empty **May use** list do the real governance work,
  and where the Test tab's read-only sandbox is the reassurance.

### S3 — Sales: "Klantvraag beantwoorden volgens onze toon" (answer an inbound question)
- **What this skill does**: "Beantwoordt een binnenkomende klantvraag over levertijd, prijs of garantie in onze
  huisstijl."
- **Steps**: (1) bepaal waar de vraag over gaat; (2) zoek het antwoord in de productkennis — *reference: knowledge base
  "Productinformatie"*; (3) controleer de actuele levertijd — *reference: automation "Levertijd opvragen" (trigger: an
  agent calls it)*; (4) schrijf het antwoord in maximaal 120 woorden, met één concrete vervolgstap.
- **Rules**: **Always** "spreek de klant aan met u"; **Always** "noem een concrete datum of termijn, nooit 'binnenkort'";
  **Never** "beloof een korting of een uitzondering".
- **Examples**: two cards built with **"Pick from a conversation"** from real answers a colleague already gave — the
  PII scan strips names before they are stored.
- **May use**: knowledge base *Productinformatie*; automation *Levertijd opvragen*.
- **Dynamic activation: on** — the sales agent carries four skills and only one applies per message, so only a one-line
  manifest entry sits in each turn's prompt until the model calls `activate_skill`.
- Teaching point: the difference between static and dynamic is visible here — with dynamic on, the automation grant does
  not exist until the skill is activated in that conversation.

---

## 11. API endpoints a "did the learner do it?" check can call

All under `/api/skills`, all behind `requireAuth` **and** the mount-level `requireCapability('skills')` (Community
licence + `skills` beta). Session-cookie auth, same as every other Agent Hub API — `authFetch` is enough.
Usable by the Learning Center pattern in `agent-hub/src/components/onboarding/actionChecks.js`.

### `GET /api/skills` — **the main verification endpoint**
- Auth: `requireAuth` + capability. **No `manage_skills` needed.**
- Returns: a bare **JSON array** of skills visible to the caller (own personal skills + org skills shared to them or
  their groups), newest first.
- Each row (`skillStore.mapRow` + viewer fields):
  `id`, `orgId`, **`userId` (the owner)**, `name`, `description`, `instructions`, `workflow`, `rules`, `examples`,
  `icon`, `isShared`, `dynamicActivation`, `sharedGroups[]`, `automationId`, `enabledIntegrations[]`,
  `steps[{id,text,refs[{kind,id}]}]`, `rulesV2[{id,polarity,text}]`,
  `examplesV2[{id,question,good,rationale,bad?,violatedRuleId?,sourceConversationId?}]`, `outputSchema|null`,
  `knowledgeBaseIds[]`, `allowedAutomationIds[]`, `version`, `lastUsedAt|null`, `createdAt`, `updatedAt`,
  plus **`canEdit`** (boolean) and **`lastTest`** = `{ status: 'ok'|'warning'|'error', adviceCount, ranAt } | null`.
- Good criteria: *created a skill* (`rows.some(s => s.userId === me.id)`), *wrote steps*
  (`s.steps.length >= 3`), *wrote a rule* (`s.rulesV2.length >= 1`), *granted something*
  (`s.knowledgeBaseIds.length || s.allowedAutomationIds.length || s.enabledIntegrations.length`),
  *tested it* (`s.lastTest && s.lastTest.status`), *shared it* (`s.isShared`),
  *switched on dynamic activation* (`s.dynamicActivation`).

### `GET /api/skills/usage-summary`
- Auth: `requireAuth` + capability. No `manage_skills`.
- Returns `{ summary: { [skillId]: { agents: n, automations: n, lastUsedAt: ISO|null, automationsUnchecked?: true } } }`.
- Good criterion: *attached the skill to an agent* (`summary[id].agents > 0`) or *used it in an automation*
  (`summary[id].automations > 0`). Beware `automationsUnchecked` — treat it as unknown, not 0.

### `GET /api/skills/:id`
- Auth: `requireAuth` + capability. No `manage_skills`. 404 when not visible.
- Returns one skill row (same shape as a list row) with `canEdit`.

### `GET /api/skills/:id/usage`
- Auth: `requireAuth` + capability. No `manage_skills`. 404 when not visible.
- Returns `{ usage: [...], unchecked: ['automation'?] }`. Rows:
  - agent: `{ kind: 'agent', id, title, role: 'chat', lastAt, ownerId }`
  - automation step: `{ kind: 'automation', id, title, role: 'ai_step', siteLabel: 'step X', stepId, layerKey, lastAt, ownerId }`
- Good criterion: *the skill is actually wired up somewhere* — and it names **which** agent/automation, so a lesson can say
  "you attached it to the wrong agent".

### `GET /api/skills/:id/test-runs`
- Auth: `requireAuth` + capability + **`manage_skills`** + the row's `canEdit` (else **403 `not_editable`**).
- Returns `{ runs: [ … up to 20 … ] }`, newest first. Rows carry the free-text question the tester typed, per-step
  results, status and advice.
- Good criterion: *ran a real test*. Note the extra gate — a plain member cannot call this.

### `GET /api/skills/test-agents`
- Auth: `requireAuth` + capability + **`manage_skills`**.
- Returns `{ agents: [{ id, name, description }] }` — the agents this account may run a test as.

### Adjacent (not in `routes/skills`, but confirmed and useful)
- `GET /api/studio/counts` (`server/routes/studio/counts.js`, mounted `/api/studio` with `requireAuthedUser`) — includes
  a `skills` key with `{ count, owners[] }`; gated by the same `skills` capability, absent when not entitled.
- `GET /api/studio/search?q=…` (`server/routes/studio/search.js`) — includes a `skills` bucket of name matches.

### Write endpoints (for completeness — not for verification)
`POST /api/skills` · `PUT /api/skills/:id` (owner **or** `manage_skills` in the skill's own org; 403 `not_editable`) ·
`DELETE /api/skills/:id` (409 `in_use` unless `confirmBreaking: true`) · `POST /api/skills/ai/draft` ·
`POST /api/skills/:id/ai/improve` · `POST /api/skills/:id/test` (SSE: `answer` → `done` / `error`, plus a
`notice` frame with code `kb_dropped`) · `POST /api/skills/:id/examples/from-message` ·
`GET /api/skills/examples/conversations` · `GET /api/skills/examples/conversations/:conversationId/messages`.
All of these carry `manage_skills`.
