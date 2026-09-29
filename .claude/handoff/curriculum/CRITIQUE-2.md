# Coverage critique, round 2 — the 40 scheduled gaps, re-checked

Method: every one of the 40 entries in `gaps.json` was opened as lesson JSON
(`lessons/<id>.json`), flattened (slides, quizzes, sims, matches, orders, exercises, action
checks, rubrics, summaries) and searched for the specific artefacts the gap named — not for the
topic word. Where a lesson missed a probe, the whole 107-lesson corpus (≈313 000 words) was
searched to see whether a sibling lesson teaches it. Afterwards the 25 fact sheets were swept
again — headings, bolded UI strings, quoted labels and routes — against the corpus, to find
material that is still untaught.

Bar used: a subject counts as taught only if a learner could go to the screen and do it — the
control is named as it appears, the consequence is stated, and something in the lesson makes the
learner exercise it (quiz, sim, order, exercise or action check). A sentence that merely mentions
the feature does not count.

---

## Verdict

**40 of 40 gaps are genuinely closed.** All 22 new lessons exist and all 18 extensions landed.
The closures are not name-drops: each one carries the specific strings the gap asked for, the
failure states around them, and at least one graded interaction. Several lessons go past the fact
sheet and correct it (see "Lessons that overtook the sheet" below).

Four things remain untaught. None of them were in `gaps.json`; three come from the fresh sweep and
one was in round 1's low-severity list but never scheduled. All are small.

---

## 1. The high-severity twelve — all closed

| Gap | Evidence it is actually taught |
|---|---|
| `projects-shared-workspace` | 14 steps. Sidebar group + **New Project** (and that it is hidden in Simple Mode), all eight tabs each tied to a question, Owner/Editor/Viewer, **Remove from project**, the memory pool with Instruction/Project/Fact/Context and the view-only read-only notice, **Extract Project Memories**. The re-key is taught twice with the app's own warning, and the operator point is said out loud: *on a zero-knowledge tier a shared thread is the exception your administrator can read*. |
| `templates-document-assembly` | 16 steps. **Word Templates**, the upload hint, detected parameters, **Fill with AI** → **Generate Document**, the *Settings & Knowledge* tab as the fill context, the notebook-side **AI fill**, and *"No {{parameters}} found in the document to fill."* used as a diagnosis quiz rather than a footnote. |
| `apps-edit-the-canvas` | 17 steps on the component strip (**Start here** / **Basics · Content · Layout · Data · Input · AI**, *"Click to add — or drag it onto the canvas"*), selection, the Inspector's Look/Logic split, the badge vocabulary (**Hidden in the running app**, **Only shown when {expr}**, **Only usable when {expr}**), the ceilings (40/40/500/6), no Save button, and the tab-collision dialog. Screen management (**Add screen**, **Screen options → Rename / Set as home screen / Delete screen / Manage navigation…**, *An app needs at least one screen*) is taught — but in the sibling `apps-data-and-screens`, not here. Same course, so the subject is covered; the placement diverged from the plan. |
| `compliance-risk-register` | **Seed suggested risks** explained as a read of the real workspace (with the seeded rows and their L×I), **Add risk**, 1–5 scoring, the four categories, the drawer, all four treatments, **Accept risk** with its stamp, filter pills incl. **High (≥ 10)** and **Review overdue**, and the review clock. |
| `compliance-training-and-literacy` | The Art. 4 stamp for the organisation vs the per-member row, **Attest training** → **Note** → **Record attestation** → **Re-attest**, the Learning column, the obligation clock that brings the re-confirmation back, and the deployer obligation dated 2 February 2025. |
| `compliance-public-dsr-form` | `/privacy/requests` and `/dsr` as the same page, the six rights with their articles, **Request received** + reference number, **Check an existing request**, `/dsr/verify` → *Confirming your identity…* → **Identity confirmed**, the admin-side **Requests · Public form · Settings** tabs, the rate limit, and the privacy-notice paragraph as an exercise. |
| `admin-ai-configuration` | Both doors, the tier cards and their badge (*2/4 tiers*), **Memory Extraction Model** with the "defaults to Fast" line, **Integrations → Transcription → Active Provider** (Voxtral / Azure Speech / WhisperX / Scaleway / pyannoteAI / local Whisper), and **Integrations → Search** (Disabled / Azure Bing / Cloud-only Serper / Self-hosted Agent Search + Serper, **Agent Search Service URL**) with the silent-failure behaviour. |
| `datatables-rows-and-repair` | Row edit with the stale-write refusal, bulk delete, paging, the form **Dashboard** tab, **Check & repair** with its three verdicts and **Repair it**, **Rename table**, **Delete this table…** (type the name, lists the routines that break) and **Unlink this table…** on a mirror. The filter builder and **Search the text columns…** are taught in `datatables-create` instead — again a placement change, not a hole. |
| `cowork-run-as-agent` | The **Run as** sheet (*Who does the work?*, *An agent brings its own skills, knowledge and connected apps*, **No agent** → *Runs as a plain prompt*), results landing in the agent's thread, the tier pill forced to **Auto**, and the per-item Apps allow-list with all three answers — following the workspace list, an explicit empty list, and an unreadable list that claims nothing. A step also explains why the chip may be absent (the picker is permission-gated). |
| `webpages-share-links` | **+ New link** → *Who can access this link?* with all three modes, **Expires** (1/7/30/90/none, opening at 30 days), **Create link**, the frozen copy the link serves, and a quiz that punishes mailing the password with the link. |
| `meetings-insights-and-transcript` | The three header chips with their definitions, all five Insights views with their real metrics, **Search transcript…** as literal search, the **What is this line?** menu with all five choices and the **Already an action** state, **Ask AI** scoped to one note vs **AI report** across up to ten. |
| `org-meeting-settings-and-templates` | The **Talk Meeting Notes** panel with *"These org settings override each member's personal settings"* treated as the point of the lesson, **Per-person meeting insights** framed as the works-council decision, and **Organization summary templates** with **New template…**, scope, the default badge and the *"Scope can't be changed after creation"* trap. |

## 2. The medium and low entries — all closed

Spot-checked in the same way; the ones worth calling out for depth:

- `routine-shield-step` teaches **four** modes (Check for personal data, Check and hide, Hide
  personal data, Show real values again), both exits (**Stop the run** / **Pass a masked copy on**),
  and contrasts irreversible masking with vault-backed placeholders.
- `routine-extra-triggers` teaches the menu's own two hint lines (*Adds another way to start this
  routine* vs *Replaces the current trigger*), the replace confirmation, and per-entry-point testing.
- `routine-steps-that-persist` now teaches the per-step reuse window, the org window (1–60 min,
  default 5), the step cap (15 min), *the shorter of the two wins*, the "shortening the org window
  shortens stored answers" consequence, and the separate **Remember answers in a table**.
- `admin-access-control`, `agent-publish-and-audience`, `usage-caps-and-quality`,
  `chat-history-hygiene`, `datatables-create`, `org-usage`, `admin-groups-and-tiers` each carry the
  exact strings the gap named plus a quiz or sim that turns on them.
- `meetings-capture` says the zero-knowledge caveat plainly, in a sim whose third option is
  *"Don't record it — write it up by hand."*

### Lessons that overtook the fact sheet

Three closures are more accurate than the sheet that prompted them, which is worth keeping:
the Privacy Shield step has four modes, not three; the knowledge freshness cell has **no** failed
state (a failing scheduled source shows on the Sources tab, and the lesson says so); and the media
row lists four named generators (Image Generation, Music Generation, ElevenLabs, Video Generation)
rather than the sheet's *Image / Music & TTS / SFX* tabs. If the sheet is the source of truth these
are discrepancies to reconcile — but in each case the lesson reads like the product and the sheet
like a summary.

---

## 3. Still untaught after this round

| # | Area | What is missing | Severity |
|---|---|---|---|
| 3.1 | **App Variables** (`facts/apps.md` §2.7, §5 glossary, §7 limits) | The **Variables** view — *"Named values your screens and actions share — formulas read them as `vars.<name>`"*, 30 per app, each default ≤ 2 048 bytes. No lesson in the Apps course contains the word. `apps-edit-the-canvas` teaches conditions written as `{expr}` and `apps-actions-and-routines` teaches action steps, so a learner meets the expression language without ever meeting the one named value it can read. | medium |
| 3.2 | **Meeting series** (`facts/meeting-notes.md` §, Series row) | Notes recorded from the same Meet code or Talk room form a series, and the detail shows a *"previously in this series"* card. Untaught; `meetings-insights-and-transcript` even tells learners Ask AI is the wrong tool for *"what did we agree the previous three times"* without pointing at the card that answers it. | low |
| 3.3 | **Meeting note exports** (`facts/meeting-notes.md`, ⋯ More actions) | **Export as Markdown** and **Export as Text**. *Copy transcript*, *Edit speakers*, *Re-transcribe* and *Delete* from the same menu are all taught; only the two exports are not, so a learner asked to hand a note to someone outside Bee Flow has no route. Flagged in round 1 §3 and never scheduled. | low |
| 3.4 | **The n8n row is taught without its name** (`facts/org-integrations.md` §2.1) | `integrations-org-access` teaches the panel correctly — Connection / Workflows / Permissions, **Instance URL**, **API Key**, **Test Connection**, the diagnostics — but calls it "the workflow engine" throughout. On screen the row is titled **n8n**, its sub-line is *"Connect n8n workflows as AI tools"* and the field is literally **n8n Instance URL**. Other lessons name Gmail, Nextcloud and Azure, so this is an inconsistency rather than a house rule. Taught, but the label the learner has to recognise is withheld. | low |

Unchanged out-of-scope note from round 1: there is no fact sheet for the Support Studio inbox or
the mobile (Expo) client, and no lesson teaches either. That cannot be called a gap against the
sheets, but it is still a hole in the product's curriculum.

---

## 4. What this round did not re-examine

The "thin lesson" list in round 1 §4 was a judgement about lessons, not a list of missing facts;
every fact it named has since been scheduled and closed except 3.2–3.3 above. Lesson *quality*
(pacing, whether the sims discriminate, whether the action checks can actually pass) was out of
scope here — this pass measured coverage only.
