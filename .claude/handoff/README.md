# .claude/handoff

This directory holds authoring input that code and tests read, not notes:

- `curriculum/` — the lesson JSON and `generate.mjs` behind the Learning
  Center catalog; `agent-hub/src/components/onboarding/actionChecks.test.js`
  compares the shipped registry against it.
- `compliance/keys/` — the per-stream translation key files that
  `server/scripts/mergeComplianceKeys.mjs` folds into the dictionaries.

Session hand-off notes, plans and journals do not belong in this repository.
