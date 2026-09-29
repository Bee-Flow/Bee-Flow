---
id: agent-refine-preserve
title: The Refine-this-agent chat patches instructions without wiping curated apps/skills/model
mode: agentic
tags: [agents, refine, studio]
requires: [llm]
timeout: 240000
auth: admin
cleanup: "Delete every agent whose name starts with 'E2E Refine' that this run created, even if an earlier step failed."
---

## Steps

1. Navigate to `/app/studio/agents`.
2. Create a new agent named `E2E Refine <runId>` (use the runId from the task
   context). Give it a short instructions text (e.g. "You help with support.")
   and Save it (the draft "Save" button — after the first save further edits
   autosave, wait for the "Saved" indicator).
3. Curate the configuration on the right panel:
   - Set the model tier to **Thinking** (the tier selector near the name).
   - Open **Vaardigheden** (Skills) and attach or create one skill.
   - Open **Apps bekijken** (browse apps) and enable one app (e.g. **Web Search**
     / `agent-search`, which is always available).
   Wait for the "Saved" indicator after each change.
4. In the left **"Refine this agent"** chat, type `maak de toon vriendelijker`
   and send it. Wait until the assistant's plan reply appears in the chat AND
   the "Saved" indicator settles.
5. Verify **preserve & patch**:
   - The instructions text changed (the tone was rewritten).
   - The model tier is still **Thinking** (NOT reset to Fast).
   - The enabled app from step 3 is still enabled.
   - The skill from step 3 is still attached.
6. Reload the page (`/app/studio/agents/<id>`) and confirm the same state
   persisted server-side (instructions changed; tier/app/skill intact).

## Expected

- After step 4 the chat shows an assistant plan reply and the pill shows
  "Saved" (a single settle, no "Save failed" banner).
- After step 5 the curated tier/app/skill are all unchanged; only the
  instructions were patched.
- After step 6 the persisted agent matches step 5 (no lost updates on reload).
- No error toast/banner at any point.

## Notes for generation

- Runs agentically (Claude drives by role/accessible name) — the
  `admin/AgentWizard/BuilderSplit` editor has few data-testids today. The
  "Refine this agent" heading and the suggestion chips are text-addressable; the
  chat input placeholder is "Ask me to change anything about this agent".
- The whole point is the regression guard: a tone-only refine must not clobber
  curated apps/skills/model. If any of those reset, the test fails.
- Never touch agents not created by this run.
