# Bee Flow Learning Center — lesson authoring spec

You are writing a LESSON for the in-product Learning Center of Bee Flow (a self-hosted, privacy-first AI workspace).
Lessons play inside the app in a "lesson player" (a centred window or a 420px panel docked beside the live app).
Everything you write must be TRUE about the real product — verify claims in the codebase under
this repo (frontend `agent-hub/src`, backend `server/`). Use the product's real UI labels.

## Output: ONE JSON file per lesson

Write `<lessonId>.json` into the directory you are told. Shape:

```json
{
  "id": "kebab-case-lesson-id",
  "icon": "🧬",
  "estMinutes": 9,
  "title": "Anatomy of a great prompt",
  "desc": "One sentence for the course table.",
  "gate": {},                       // permission = ANY-of ("manage_agents" or ["a","b"]); feature = ALL-of ("automations" or ["automations","app_studio"]); both may be present.
                                    // The gate must cover EVERY surface the lesson sends the learner to — see surfaceGates.json for the gate the product itself puts on each one, and gateAudit.mjs to check.
  "learningGoal": "After this lesson the learner can …",
  "steps": [ …8 to 24 step objects… ]
}
```

### Step objects (six kinds — mix them)

1. **slide** — a teaching card (markdown). Keep to ~60–140 words; one idea per card.
```json
{ "type": "slide", "id": "why", "icon": "🧭", "title": "Context steers everything", "bodyMd": "Markdown… **bold**, lists, short paragraphs." }
```
2. **quiz** — multiple choice. Exactly ONE correct choice unless `"multi": true` (then 2+ correct). 3–4 choices. Wrong choices carry a `feedback` that teaches WHY. `explanation` shown after a pass.
```json
{ "type": "quiz", "id": "q1", "icon": "❓", "question": "…?", "multi": false,
  "choices": [ { "id": "a", "label": "…", "correct": true }, { "id": "b", "label": "…", "correct": false, "feedback": "Why this is wrong." } ],
  "explanation": "Why the right answer is right." }
```
3. **exercise** — free text graded by an AI coach against a server-side rubric YOU define (in the same file, see `rubrics`). Soft gate; learner may skip after `maxAttempts`.
```json
{ "type": "exercise", "id": "ex", "icon": "🎯", "exerciseId": "ex-<lessonId>-<slug>", "title": "Your turn: …",
  "instruction": "What to write and what a strong answer contains.", "placeholder": "e.g. a concrete example answer…", "passScore": 70, "maxAttempts": 4 }
```
4. **sim** — an interactive widget that IS the question. Three kinds, graded locally:
   - match: `{"kind":"match","pairs":[{"id":"x","left":"scenario","right":"concept","note":"why"}]}` (3–5 pairs; ids unique; the learner pairs left↔right)
   - order: `{"kind":"order","items":[{"id":"a","label":"…"}],"solution":["a","b","c"],"feedback":"why this order"}` (4–6 items)
   - flow-build: a mini automation canvas — see below. ONLY for automation/routine lessons.
```json
{ "type": "sim", "id": "sim", "icon": "🧩", "title": "…", "instruction": "…", "sim": { … } }
```
   flow-build shape:
```json
{ "kind": "flow-build", "scenarios": [ { "id": "digest", "brief": "“Every Friday at 16:00 …”",
   "trigger": { "options": [{"id":"manual","label":"Trigger manually","desc":"Run from a button click"},{"id":"form","label":"On form submission","desc":"…"},{"id":"schedule","label":"On a schedule","desc":"…"},{"id":"webhook","label":"On webhook call","desc":"…"},{"id":"app_event","label":"On app event","desc":"…"}],
                "correct": "schedule", "feedback": { "webhook": "why not", "manual": "why not", "app_event": "why not", "form": "why not" } },
   "steps": { "palette": [{"id":"fetch","label":"…"},{"id":"summarise","label":"…"},{"id":"send","label":"…"},{"id":"approve","label":"distractor"}],
              "solution": ["fetch","summarise","send"], "feedback": { "approve": "why this step does not belong" } } } ] }
```
5. **action** — "do it for real": the learner performs a task in the live app and a checklist verifies it against the product's own APIs. Uses a `checkId`. EXISTING checks you may use: `agent-created` (an agent of the learner's own), `automation-first` (an automation with a trigger that ran a dry-run), `kb-with-doc` (a knowledge base with ≥1 document), `hive-master` (capstone composite), `cowork-first` (a cowork item). If the lesson needs a NEW check, declare it in `actionChecks` (see below) with the real list endpoint(s) you verified in `server/routes` — the integrator implements it. Keep new checks simple: "at least one X exists (owned by the learner where the row carries an owner)".
```json
{ "type": "action", "id": "do", "icon": "🏗️", "checkId": "form-created", "title": "Build it — we’ll verify it",
  "instruction": "What to do in the app, in 2–3 sentences.", "launch": { "navigateTo": "studio/forms", "label": "Open Forms" } }
```
   `navigateTo` vocabulary: `agents`, `agentWizard`, `cowork`, `apps`, `forms`, `studio/agents`, `studio/skills`, `studio/knowledge`, `studio/routines`, `studio/approvals`, `studio/datatables`, `studio/webpages`, `studio/apps`, `studio/forms`, `studio/playbooks`, `studio/solutions`, `studio/runs`, `studio/meetingNotes`, `settings/memory`, `settings/integrations`, `settings/preferences`, `settings/security`, `settings/organisation/<sub>` where sub ∈ `privacy`, `encryption`, `info`, `usage`, `compliance`, `users`, `academy`, `integrations`, `nextcloud-sync`, `meeting-templates`, `azure`, `auth`, `license`.
6. **tour** — a spotlight on a real element of the live app. ONLY these targets exist (use the selector verbatim):
   `[data-tour="nav-new-chat"]`, `[data-tour="nav-cowork"]`, `[data-tour="nav-studio"]`, `[data-tour="nav-agents"]`, `[data-tour="account"]`, `[data-testid="settings-nav-preferences"]`, `[data-tour="chat-composer"]`, `[data-tour="agent-wizard-prompt"]`, `[data-tour="agent-system-prompt"]`, `[data-tour="agent-tools"]`, `[data-tour="agent-knowledge"]`, `[data-tour="skill-create"]`, `[data-tour="knowledge-create"]`, `[data-tour="integration-card"]`, `[data-tour="memory-manage"]`, `[data-tour="routine-create"]`, `[data-tour="usage-summary"]`, `[data-tour="automation-start-tabs"]`, `[data-tour="cowork-composer"]`, `[data-tour="cowork-options"]`.
   Always `"optional": true` and a `timeoutMs` (6000–8000) so a missing element never blocks. Prefer at most 1–3 tour steps per lesson, in one contiguous run.
```json
{ "type": "tour", "id": "where", "target": "[data-tour=\"chat-composer\"]", "navigateTo": "agents", "placement": "top", "optional": true, "timeoutMs": 6000, "icon": "⌨️", "title": "This is where you ask", "body": "One or two sentences." }
```

### Also in the file (top level, beside `steps`)

```json
"rubrics": { "ex-<lessonId>-<slug>": { "title": "…", "task": "what the learner was asked", "criteria": ["3–4 concrete things a strong answer shows"], "passScore": 70, "guidance": "grading notes: what must NOT pass" } },
"practiceTopic": { "title": "…", "summary": "one sentence", "facts": ["4–6 true, specific facts the AI practice generator may quiz on — mirror real UI labels"] },
A criterion may name its OWN `endpoint`, and it MUST declare what "done" looks like with `expect` to be checkable at all. **There is no default.** A criterion without `expect` is UNVERIFIABLE: the runtime never ticks it, never fetches for it, and the step falls back to the honor button — which is the honest outcome, and far better than crediting the learner off the first row of a list they merely opened. The four kinds:
  `{"kind":"rows"}` / `{"kind":"rows","field":"apps"}` · `{"kind":"truthy","field":"shield.enabled"}` · `{"kind":"nonEmpty","field":"terms"}` · `{"kind":"equals","field":"tier","value":"strict"}`
`rows` means "that array holds at least one row the learner owns" — ownership binds only on `ownerId`, `owner_id`, `userId`, `user_id`, `createdBy`, `created_by`, `authorId`; a row with NO such field counts, because the endpoint is then already scoped to the caller. So write `rows` only when the endpoint returns the learner's own rows, or when its rows carry one of those exact fields. An org-wide list whose owner column is named something else (`/api/datatables` → `ownerUserId`, `/api/kb` → `tenant_id`, `/api/automation/forms` → `mine`) would credit a colleague's work: leave those criteria without `expect`. The other three kinds read a dotted path on the BODY, for "is this setting configured" checks — those endpoints answer with a config OBJECT, not a list.
There is NO per-row predicate: "one of your apps is *published*", "that routine has an *approval* step", "a note that *finished*" cannot be expressed, so those criteria stay unverifiable. Do NOT rubber-stamp them with `{"kind":"rows"}` to make the checklist look green — a criterion must claim exactly what its `expect` proves.
A path may contain `:orgId` / `:org` / `:orgid` / `:id` (the runtime substitutes the learner's own organisation — a user with no organisation simply cannot pass that check) and may carry a query string that narrows the answer (`/api/automation/_runs/recent?mode=dry_run&limit=1`).

"actionChecks": [ { "checkId": "form-created", "existing": false, "label": "Create a form", "hint": "In Studio → Forms …", "endpoints": [{ "method": "GET", "path": "/api/forms", "returns": "array of form rows with id, title, ownerId?" }], "criteria": [ { "id": "created", "label": "A form exists", "hint": "…", "rule": "list length > 0" } ] } ]
```
`rubrics` must contain one entry per exercise step (same `exerciseId`). `practiceTopic` is required for every lesson that has ≥1 quiz. `actionChecks` lists only NEW checks (omit or `[]` when only existing checks are used).

## Hard rules (the validator enforces most)
- 8 ≤ steps ≤ 24. Step ids unique within the lesson, `^[a-z0-9-]{2,24}$`. Lesson id `^[a-z0-9-]{4,40}$`.
- At least 3 different step kinds; at least 3 interaction points (quiz/exercise/sim/action) and never two identical kinds back-to-back more than twice.
- The first step is never a quiz; the lesson opens with orientation (slide or tour) and closes with a check or a "what you can do now" slide.
- Quiz: exactly one correct unless multi; every wrong choice has feedback; no "all of the above".
- Every claim about the product is verifiable in the code: UI labels, menu names, what a setting does, defaults, limits. If you cannot verify it, do not write it.
- No purple anywhere, no emoji inside markdown body text except in titles/icons; British or American English consistently (the product uses "organisation").
- Never mention prices, competitor products, or internal file paths in learner-facing text.
- Keep the learner's language plain; explain a term the first time it appears.

## Learning design — think about who is learning and how

Choose the mix from the audience:
- **Everyday users** (chat, memory, cowork, forms as a respondent): low confidence, short attention, want quick wins. Open with a 20-second "why this matters to you", show one concrete example, let them try in a low-stakes exercise, confirm with a 1-question quiz. Avoid jargon; celebrate small wins; never a wall of slides.
- **Builders** (agents, skills, knowledge, automations, apps, tables, webpages, playbooks): want mental models and then hands. Give the anatomy (parts + how they connect), a diagnose-before-build sim (match/order), a guided build, then an ACTION step verified in the real workspace, then a "debug this" quiz about what goes wrong. Pace: concept → sim → do → reflect.
- **Admins** (organisation settings, privacy shield, encryption, compliance, users, usage): risk-aware, need to know consequences and defaults. Give the decision ("what happens if I turn this on"), the defaults, a scenario quiz ("a colleague pastes a customer email — what does the Shield do?"), and a checklist-style action or an ordered-steps sim for rollouts. Always say what is reversible.

Spacing and retention: put the hardest interaction around 60% of the way through; end with a summary slide "what you can do now" (3 bullets) so the lesson feels finished. Reuse a running example (one fictional company, e.g. "Van Dijk Groep", a Dutch SME) across the lesson so each step builds on the previous one.
