# Final review, part 3 of 3: plumbing (everything outside agent-hub/ and server/)

Range 77c40ea8..05393c5f (578 commits). Checked out at 05393c5f, clean tree.

Commands run: `npm run check:fast` (39/39 pass), `npm run test:scripts` (467/467 pass),
`node scripts/duplication-ratchet.mjs` (production 15165 against a budget of 15290, test 26188 against 26228),
mobile jest `src/meta/{serverClosure,ciTriggers}.test.ts` (9/9) plus 46 suites around the mirrored
wrappers (1742/1742), mobile eslint on the four new mirror dirs and their wrappers (clean),
`sync-web-tokens.mjs --check` and `sync-web-icons.mjs --check` (both up to date).

## Scores

| Dimension | Score | One line |
|---|---|---|
| Ratchet integrity | 10/10 | Every count budget went down. checkjs is a floor and went up (991 to 1063). Both `.file-budget.json` files: 0 entries added and 0 raised (compared with .js/.ts renames mapped), `data` unchanged. Nothing to justify. |
| CI coverage | 7/10 | The mobile filters are sound (serverClosure passes, no renamed file lost coverage). The server filter has 2 stale patterns that now match nothing, so 3 files the server lockstep tests read are no longer covered. |
| Mirror integrity | 9/10 | `--check` passes, `generatedRoots` holds no stray files, every transformed target has its header, and the eslint `bindings/mirror/**` rule behaves as documented (checked by linting stdin). |
| Mobile type honesty | 7/10 | No new `any`, `as unknown as`, `!` or `@ts-ignore`. But 9 new wrapper exports cast a web function to a different signature with `as (…) => …`. |
| Repo hygiene | 6/10 | No `node_modules` or symlink anywhere in the range, and the `.gitignore` line is correct. The 105-file `.claude/handoff/ts-conversion/` work-state folder should not go to main. |
| Commit hygiene | 4/10 | 319 of 578 commits have no signature. 100 commit messages name a model ("Opus-reviewed") outside the trailer. A squash merge with a clean message fixes both. |

## Findings

### BLOCKING 1: ci.yml server filter has 2 stale patterns, so the server lockstep tests stop firing on 3 agent-hub files

- `.github/workflows/ci.yml:261` `'agent-hub/src/components/admin/Studio/AppStudio/tables/TablesManager.jsx'` matches nothing. TablesManager.jsx was deleted. Its modes now live in `tablesManagerModel.ts`, which is what `server/core/dataEngine/dataModel/vocabulary.lockstep.test.js:41` reads.
- `.github/workflows/ci.yml:263` `'agent-hub/src/components/admin/Studio/Solutions/{SolutionCard,SolutionsOverview}.jsx'` matches nothing. Both files were renamed to `.tsx`, and `server/migrations/add-nl-solution-overview-translations.test.js:38-41` reads the `.tsx` files.
- On main, both patterns matched files. I checked this mechanically: I took every file each main filter covered, mapped it through `git diff -M`, and tested the result against the branch filter. These are the only losses in any filter.
- The concrete failure: a PR that touches only `tablesManagerModel.ts`, `SolutionCard.tsx` or `SolutionsOverview.tsx` does not set `server`. The `server-*` jobs skip, and the test that would catch the drift never runs. The next unrelated server PR then goes red.
- Minimal fix:
  ```yaml
  - 'agent-hub/src/components/admin/Studio/AppStudio/tables/tablesManagerModel.ts'
  - 'agent-hub/src/components/admin/Studio/Solutions/{SolutionCard,SolutionCardParts,SolutionsOverview,SolutionsOverviewParts}.tsx'
  ```
  The two `*Parts.tsx` files were already a gap on main. Adding them costs nothing.

### BLOCKING 2 (merge hygiene): `.claude/handoff/ts-conversion/` should not ship to main

- The folder is 105 new files, about 660 KB: `README.md`, `batches/01-42.txt` and `state-2026-10-15/` (STATE, reviews, split reports, briefs, tools).
- It contains no secrets, keys, IPs or customer data. Gitleaks and `scan-secrets --range` are clean, and I grepped for e-mail addresses (only noreply@anthropic.com), IPs and URLs (only nodejs.org and claude.ai session links).
- It is agent working state, not product:
  - branch statuses and "next steps" for `ts-local/*` and `ts-bugs/*` branches
  - an instruction to "check for new `bug` issues every 30 min" (`split/BUG-report.md:3`)
  - 17 local paths in 13 files that expose the owner's machine layout: `/home/tom/Projects/bee-flow-la-wt/...` (`reviews/LA-r1-A.md:140`, `reviews/LA-r4.md:42`) and `/tmp/claude-1000/...` or `<integrator scratchpad>` scratchpads (for example `reviews/LC-round1.md:31`, `reviews/b2-B.md:63`)
  - claude.ai session URLs
  - per-model review verdicts
- Nothing outside the folder depends on it, except two comment lines in `scripts/ts-convert-local.mjs:7,9`, which point at `README.md` and `batches/23.txt`.
- Recommendation: remove `.claude/handoff/ts-conversion/state-2026-10-15/` before merge. Keep `README.md` and `batches/` only if `scripts/ts-convert-local.mjs` stays on main as a tool for further conversion. Otherwise remove the whole folder and drop the doc pointer from the script.
- The one-line edit to `.claude/handoff/curriculum/gateAudit.mjs` (surfaceGates.js to .ts) is a correct rename follow-up and should stay.

### BLOCKING 3 (only if merged as a merge commit, not squashed): unsigned commits and model names in messages

- **Signatures.** 319 of 578 commits have no `gpgsig` header. They are all by Tom Kooy (the laptop sessions), and 97 of them are merges. The 259 commits by Claude carry SSH signatures; `%G?` shows `N` only because no `gpg.ssh.allowedSignersFile` is configured here.
- **Model names.** 100 commit messages name a model outside the Co-Authored-By trailer. Examples:
  - `0b34bacd merge(ts): batch 27 …, Opus-reviewed`
  - `067b9f32 docs(handoff): S3 Opus review of the connectorJwt split`
  - `25d08a0c … with the Opus security review fix`
- The trailers themselves are allowed: Opus 5.5 ×520, Sonnet 5.5 ×3, Fable 5.1 ×4.
- Fix: squash-merge with a clean message. GitHub signs the squash commit, and none of the branch messages reach main. Rewriting 578 commits instead is not worth it.

### FOLLOW-UP 1: 9 mobile wrapper exports cast a web function to a different signature

These are new lines in the diff:
- `mobile/src/features/flow-editor/bindings/bindingHelpers.ts:37,40,43,83`
- `mobile/src/features/flow-editor/bindings/conditionText.ts:19`
- `mobile/src/features/flow-editor/formState/approvalStages.ts:28,29`
- `mobile/src/features/flow-editor/model/route/bindingText.ts:32,39`

They are not `as unknown as`, but they are assertions:
- Parameters are widened to `unknown`. For example, `webCleanApprovalSeat(raw: FormRecord | null | undefined)` is exported as `(raw: unknown) => …`.
- Return types are narrowed without proof. `webInputFromBinding` returns `{ mode: string; … }` (`mirror/utils/bindingHelpers.ts:208`), and the cast turns that into `{ mode: BindingMode; … }`.

Today the web functions guard their inputs at run time, so nothing breaks. The cost is that a third mode added on the web would not fail the mobile typecheck.

Minimal fix: in the web sources (`agent-hub/src/utils/bindingHelpers.ts` and `…/formState/approvalStages.ts`):
1. Annotate the return types, for example `{ mode: 'fixed' | 'expression'; text: string }`.
2. Widen the parameters the functions already guard to `unknown`.
3. Run `npm run gen:shared`.

Then re-export the functions in mobile without `as`.

### FOLLOW-UP 2: stale `.js` paths left by the renames

- `server/learning/learnMediaPack.test.js:20` reads `onboarding/lessons.js`, which no longer exists (it is `lessons.ts` now).
  - `if (!fs.existsSync(file)) continue;` skips it silently.
  - No coverage is lost today: lessons.ts, and lessons.js on main, contain 0 `videoId`s. All 79 are in `generated/lessons.js`.
  - Fix: `'lessons.ts'`. This line is in server/, so part 1 or 2 may also report it.
- Comment-only staleness:
  - `mobile/src/features/chat/model/prompts.ts:3` (`utils/prompts.js`, now `.ts`)
  - `mobile/src/features/recording/model/insights/insights.lockstep.test.ts:15` ("the web modules are untyped JS", though 3 of the 5 are now `.ts`)
  - `scripts/README.md:201` (`storageMigrations.js`, now `.ts`)

### Verified, no finding

- **Ratchets.** jscpd went from 15488/26279 to 15290/26228, and the measured numbers are lower still. The other changes:
  - authfetch-effect 229 → 219
  - authfetch-outside-api 314 → 312
  - dutch-comment 291 → 282 (agent-hub) and 375 → 359 (server)
  - empty-catch 506 → 505 and 1218 → 1204
  - import-zones 49 → 45
  - inline-style 9335 → 5664
  - scc 68 → 61 (agent-hub) and 569 → 60 (server)
  - ts-ratchet 3115 → 1955
  - unchecked-mutation 36 → 33
  - big-file 233 → 190 and 55 → 33
  - long-function 314 → 257 and 201 → 104
  - module-mock 813 → 810
  - status-5xx 737 → 14
  - checkjs floor 991 → 1063

  The eslint budgets, i18n, version-drift, coverage, fire-event and all mobile budgets are unchanged. `count-ratchet.mjs` only renames the `utils/helpers.js` exemption to `.ts`, and the test follows it.
- **.jscpd.json.** The 4 new ignores are generated mirror dirs. The `.quality-round/**` ignore was removed, which makes the check stricter.
- **.gitleaks.toml.** The new allow-list regex is anchored (`^DraftStatusMap$`). The path rename points to an existing file (`server/core/automationModel/runLogRedaction.test.js`).
- **Mobile CI filters.** `serverClosure.test.ts` and `ciTriggers.test.ts` pass. Every pattern in both mobile blocks matches a file on the branch. No agent-hub path named in mobile tests or `mobile/scripts` is missing; the only paths flagged were test fixtures and node_modules.
- **Shared mirror.**
  - All 5 `generatedRoots` are clean under `--check`.
  - Transformed or rewritten targets (`keyPath`, `utils/bindingHelpers`, `mapping/**`) carry `GENERATED from …`.
  - Byte-for-byte targets (`transform: none`, no rewrite) carry no header, as documented.
  - Only wrappers in `bindings/`, `model/` and `formState/` import `bindings/mirror` (checked by grep).
  - Linting stdin confirms that `components/` and `screens/` files are rejected and that wrapper paths are allowed.
  - The other 4 mirror dirs are linted by mobile eslint and are clean.
- **Mobile lockstep.** The ports became generated mirrors. The lockstep tests still run their fixtures, and 46 suites pass. The `webModule.ts` `stripTypes` lets the loaders read `.ts` web files.
- **node_modules.** `git log -p --name-only … | grep -cE '(^|/)node_modules$'` returns 0, and `git ls-tree -r 05393c5f` has no `node_modules` and no mode-120000 entries. The earlier symlink commit 2d6f26e9 is not an ancestor of 05393c5f.
