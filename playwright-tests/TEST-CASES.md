# Regression test cases from resolved YouTrack issues

Source: **BFSF** (`Bee Flow: Sovereign Flow`) — the product project. Reviewed every issue in a
resolved state (`Resolved`, `Closed`, `Done`) and turned the ones reachable from the Agent Hub UI
into automated specs. The rest are written up as manual cases so the coverage gap is explicit rather
than silent.

Search tip: `project: BFSF` matches oddly in the YouTrack query API — use the full name,
`project: {Bee Flow: Sovereign Flow}`.

## Automated

Live in [tests/regression/](tests/regression/). All four pass against the local stack
(`localhost:5176`, 2026-08-11).

| Case | Issue | State | Component | What it guards |
|---|---|---|---|---|
| [bfsf-132-conversation-title.spec.ts](tests/regression/bfsf-132-conversation-title.spec.ts) | [BFSF-132](https://youtrack.beeflow.nl/issue/BFSF-132) | Closed | DirectChat | After the first exchange the conversation appears in the sidebar with a generated title — not blank, not still "New Chat". The report was that unnamed chats made history unsearchable. |
| [bfsf-179-chat-history-search.spec.ts](tests/regression/bfsf-179-chat-history-search.spec.ts) | [BFSF-179](https://youtrack.beeflow.nl/issue/BFSF-179) | Resolved (Major) | DirectChat | Chat-history search is **complete** (both of today's conversations come back), **ordered newest-first**, and **deterministic** (three consecutive identical searches return the same ordered list). Follows the verification recipe written into the ticket's own audit comment. |
| [bfsf-136-html-answer-rendering.spec.ts](tests/regression/bfsf-136-html-answer-rendering.spec.ts) | [BFSF-136](https://youtrack.beeflow.nl/issue/BFSF-136) | Resolved | DirectChat | An HTML/CSS answer renders as readable code with no `blob:` iframe and no CSP violation logged. |
| [bfsf-143-direct-chat-responds.spec.ts](tests/regression/bfsf-143-direct-chat-responds.spec.ts) | [BFSF-143](https://youtrack.beeflow.nl/issue/BFSF-143) | Resolved (Show-stopper) | DirectChat | A reply arrives within budget, no provider-error banner (`API error 400`, `invalid function arguments`, `Something went wrong`), and neither the conversation nor a reload of it white-screens. |

### Notes on two of them

**BFSF-179** — the shortcut in the ticket title, `Ctrl+Alt+R`, never existed in the app; the audit
comment found only `Ctrl/Cmd+K` bound to the search overlay. The test uses Ctrl+K. The fix also
switched the overlay's default sort from `relevance` to date, which is still the default in
`SearchOverlay.jsx:49` — the newest-first assertion covers that.

**BFSF-136** — the mechanism described in the fix (`LiveAppRenderer` loading a `blob:` URL as the
iframe `src`, blocked by `default-src 'self'`) no longer exists: there is no `LiveAppRenderer.jsx`
and no `looksLikeApp` heuristic in the tree any more. The test therefore asserts the *behaviour* the
ticket asked for rather than the old implementation, so it stays meaningful if a live-preview
feature is ever reintroduced. It passes trivially today — that is expected, and worth knowing when
reading the result.

## Not automated (manual cases)

Each of these is a resolved issue whose surface this suite cannot reach yet — a second account, a
connected Google/Gmail integration, or the routines builder. Written as steps so they can be run by
hand or picked up when the suite grows.

### BFSF-360 — Limit node outputs stale cached data (Critical, Routines)

The fix note lists five independent mechanisms (dry-run rows replayed into live runs, a newer failed
run leaving an older success in place, a >256 KB `{__truncated__:true}` sentinel replayed verbatim,
`fillMissingUpstream` dispatching non-ancestor siblings, and `pollRunProgress` wiping other nodes'
output). Backend coverage already exists: `automationRunner.partial.replay.test.js` (11/11) — run it
with `cd server && node --test`.

1. Build a routine whose source step yields 60 records, feeding a Limit node with Count=50,
   Mode="First N items".
2. Run the whole routine, then re-run **only** the Limit node.
3. Expect: output has 50 items from the current input — not 10, not a previous run's items.
4. Switch Mode to "Last N items", execute again → output changes accordingly.
5. Expect no `arrayRef did not resolve to an array` while the upstream input is still pinned and
   valid, and other nodes' outputs stay visible in the panel during a partial run.

### BFSF-359 / BFSF-356 / BFSF-330 — Routines builder (Resolved)

Same surface as above: downstream nodes re-fetching instead of reusing pinned results (359),
"Add rule" vs "Add condition" confusion in the Condition/Filter node (356), and the parameter input
showing a generic reference expression until clicked (330). All need the routines canvas driven
end-to-end; worth a dedicated page object before automating.

### BFSF-287 — Agent notebook edits overwrite manual edits (Notebook)

1. Have an agent generate notebook content.
2. Manually edit a line in the notebook panel.
3. Ask the agent, in the same conversation, for a further change (e.g. "bedenk een betere titel voor
   punt 1").
4. Expect: the agent builds on the **current** notebook content — the manual edit survives.

### BFSF-187 — Opening the URL of another user's styled webpage (Webpages)

Needs two accounts in one org; the suite currently has one.

1. As user A, create a webpage and publish/share it to the org.
2. As user B, open that webpage's URL directly.
3. Expect: the page loads (the frontend gate was removed; the server enforces access via
   `webpageStore.canReadWebpage`).
4. As user B, open a **non-shared** page's URL → an explicit access error, not a silent failure.

### BFSF-298 — PII token numbering reused across individuals (Critical, PrivacyShield)

Closed as a duplicate, and the strongest candidate for a data-driven test rather than a UI one:
token numbering must be stable and unique per individual, never reused for two people and never
renumbered mid-processing. Best expressed as a fixture-based test against the guard service, next to
the existing DLP smoke, rather than through the chat UI.

### BFSF-171 — Token returned instead of email address in Google Doc output

Needs a connected Google Workspace integration; out of reach for a local run.

## Worth knowing

There is a large batch of issues in **`To Verify`** in BFSF — including several on surfaces this
suite already reaches (BFSF-273 inline code wrapping in Direct Chat, BFSF-263 reasoning leaking into
the visible response, BFSF-303 Privacy Shield balloon layering, and a run of Notebook bugs
BFSF-309/312/313/314/315/351). Those are the natural next batch: a test there does double duty as
the verification step the state is waiting on.
