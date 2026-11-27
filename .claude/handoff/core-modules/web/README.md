# The web client's split: how the slices work

`DESIGN.md` beside this file is the design; its first section ("Decisions") wins over the rest.
Each slice has a brief here (`W0.md`, `W1.md`, ...). The rules every slice shares:

- **The ten inventory goldens do not change** (`agent-hub/src/**/**.inventory.golden.json`), and
  neither does `web/build-sources.txt` except for additions under `src/firstParty/` and
  `src/moduleHost/`. `UPDATE_GOLDEN=1` is the driver's to run, never a worker's. A golden that
  wants to change is your finding: stop and report what changed.
- **A module-owned file is not edited.** Ownership: `node scripts/module-map.mjs --owner agent-hub/src/<path>`.
  New files of a module are its area files `src/firstParty/<id>.<zone>.tsx` only.
- **With every module present the GUI is identical**: same order, labels, icons, gates, and a part
  that rendered synchronously still does.
- **Absent means two things, and both get the same answer**: the module's files are not in the
  build, or the server did not load it.
- The repository's web rules are in CLAUDE.md (TypeScript for new files, API calls through
  `src/api/typedRequest.ts`, import zones, no new `eslint-disable`, i18n keys with their Dutch,
  the count ratchets, `knip`, `@/` instead of three `../`). Never raise a ratchet budget.
- **Memory.** This machine kills `tsc` and `eslint` when several heavy runs overlap. Run the
  tests related to your files (`cd agent-hub && npx vitest related --run <files>`) and eslint on
  your files freely; run the full `npm run typecheck` of agent-hub ONCE, at the end, and if it
  is killed (exit 137, or no output) wait a minute and run it again, up to five times. Report
  the outcome exactly: "killed five times" is a valid report, "passed" without a run is not.
- Do not run the full vitest suite; the driver does.
- Commit on your worktree branch, never push. End the commit message with the single line
  `Co-Authored-By: Claude <noreply@anthropic.com>`.
