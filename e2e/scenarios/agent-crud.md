---
id: agent-crud
title: An agent can be created, edited and deleted via the Studio UI
mode: agentic
tags: [smoke, agents, crud]
requires: [llm]
timeout: 180000
auth: admin
cleanup: "Delete every agent whose name starts with 'E2E Agent' that this run created, even if an earlier step failed."
---

## Steps

1. Navigate to `/app/studio/agents`.
2. Create a new agent named `E2E Agent <runId>` (use the runId provided in
   the task context). Give it a short instructions text. Save it (the "Save"
   button on the draft; after the first save the agent persists and further
   edits autosave — you do NOT need to click Save again).
3. Verify the agent appears in the agents list.
4. Edit the agent's instructions to end with the marker `updated by e2e`.
   Because edits autosave, wait for the "Saved" indicator — do not hunt for a
   Save button.
5. Verify the change persisted (the instructions field shows the marker).
6. Delete the agent (hover the row, use the Delete control) and confirm the
   "Delete agent" dialog.

## Expected

- After step 2 the agent exists and is visible in the Studio agents list.
- After step 4–5 the updated description is shown.
- After step 6 the agent no longer appears in the list.
- No error toast/banner at any point.

## Notes for generation

- This area has few data-testids today; the scenario runs agentically (Claude
  navigates by role/accessible name). When the `agent-*` testids land in the
  frontend, flip `mode` to `generated+agentic-fallback` and run
  `npm run gen -- agent-crud`.
- Never touch agents not created by this run.
