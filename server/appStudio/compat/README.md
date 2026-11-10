# App Studio compatibility corpus

Apps that exist today must keep working and looking the same. This folder holds the proof.

- `corpus/<name>.json` is one app **as stored**: `{ about, definition, dataModel?, datasets? }`.
  `definition` is what a `studio_apps` row holds, `dataModel` the model next to it, `datasets`
  the saved dataset descriptors. `about.source` says where it came from, `about.captured` when.
- `frozen/<name>.json` is what the code did with that input on the day it was captured.

Neither kind of file is ever edited or deleted once it is on `main`.
`npm run lint:compat-corpus` (`scripts/check-compat-corpus.mjs`, part of `check:fast`, and run
against the PR base in ci.yml's server-checks job) fails a pull request that does. Adding files
is allowed.

## What is frozen

| Section | Product code it runs | Test |
|---|---|---|
| `canonical` | `canonicalizeAppDefinition`: sha256 and length of the exact bytes, a second pass changes nothing, top-level key order, a hash per key, screen and action | `canonical.test.js` |
| `schemaVersion` | stored and canonical `schemaVersion` | `canonical.test.js` |
| `installHash` | `templateUpgrade.hashDefinition`, stored and after a save without a change (templates only) | `canonical.test.js` |
| `validation` | `validateAppDefinition` on the canonical form, publish-style (`strict`) and save-style (`save`, data references as warnings), as `code @ path` | `validation.test.js` |
| `ordinals` | `actionSequence.flattenSteps` per action, `<ordinal> <kind>`, stored and canonical | `stepsAndPublic.test.js` |
| `publicDefinition` | `publicAccess.buildPublicDefinition` over the stored bytes (apps with `publicAccess`) | `stepsAndPublic.test.js` |
| `reads` | per binding and saved dataset, per role, in sqlite and pg: the SQL and params the query compiler produces, and under `expand` the lookup each expanded relation runs afterwards (`readSql.mts` says how) | `reads.test.js` |

A missing or invalid id is replaced by a random one when the input is canonicalized. Those ids are
masked as `<generated-N>` before hashing (`canonical.generatedIds` counts them).

## Green

Run `cd server && node --test appStudio/compat/*.test.js` (also part of `npm test`).

Green means every corpus app canonicalizes to the same bytes, validates with the same findings,
numbers its steps the same way, sends a public visitor the same definition and compiles its reads
to the same SQL as on the day it was captured.

Red means a change alters an app that already exists. Do not refreeze to make it green. Make the
change leave existing apps alone: an optional addition with no written-out default, emitted only
when present. If an existing app has to change, that is a decision for the owner.

## Web and phone

The same corpus files drive three more checks. Their expectations live next to the code they
check, not under `frozen/`, and `lint:compat-corpus` does not guard them.

**Web DOM** (vitest, jsdom, no browser, part of the frontend suite):

```
cd agent-hub && npx vitest run src/components/admin/Studio/AppStudio/runtime/lookRegression
```

Every screen of every corpus app is mounted through the headless runtime entry
(`agent-hub/src/appRuntimeHeadless.tsx`: the real `AppRenderer`, run mode, no network), with every
data binding answered empty under the key the fetch layer uses, and written down as text: elements,
sorted classes, attributes and the inline style declarations. The text is compared with
`agent-hub/src/components/admin/Studio/AppStudio/runtime/__lookSnapshots__/<name>.txt`. The
normaliser (`agent-hub/src/test/appLookRegression.ts`) drops class tokens starting with `bfa-` or
`u-` (part classes are an addition, not a change), numbers React's generated ids, masks dates and
times, fixes the clock and the default locale, and leaves out what is inside an `<svg>`. A node
whose error boundary catches a crash fails the test, except the types in `KNOWN_HEADLESS_CRASHES`
(`input_dataset` today: the headless entry mounts no QueryClient). The apps are split over
`lookRegression.shard*.test.ts`; the snapshot is per app, so the split can change.

**Phone planner** (jest):

```
cd mobile && ./node_modules/.bin/jest src/features/apps/model/compatCorpus.test.ts
```

Every corpus app goes through the phone's real planner (`planScreen`, `navigableScreens`, the input
collector), per screen, with no role and with each declared role: the blocks it draws, the fields
and defaults it collects, which buttons it can run, and the types it names as missing (browser-only
marked). Compared with `mobile/src/features/apps/model/__snapshots__/compatCorpus.test.ts.snap`.
ci.yml's mobile filter lists `server/appStudio/compat/corpus/**`, so a new corpus file runs it.

**Pixels** (a script for the person making a look change, not in `check:fast` or CI):

```
cd agent-hub && npx vite build --config vite.runtime.config.js --outDir <bundle-dir>   # on main
node scripts/app-compat-pixels.mjs --write <baseline-dir> --bundle <bundle-dir> --chrome <chrome>
cd agent-hub && npx vite build --config vite.runtime.config.js --outDir <bundle-dir>   # on the branch
node scripts/app-compat-pixels.mjs --compare <baseline-dir> --bundle <bundle-dir> --chrome <chrome> --diff <diff-dir>
```

It renders every screen at desktop, tablet and mobile under the light, dark and high-contrast host
themes through `server/services/appStudioRender.js` (`renderAppScreenshot`, empty data, a fixed
page clock) and reports each screenshot that differs. `--ws <url>` uses a running Playwright server
instead of a local Chrome. The baseline directory must be outside the repository. The header of
the script has the details.

**Adding a corpus file** adds a DOM snapshot and a phone snapshot too. Run the two commands above
once, locally: vitest and jest write a missing snapshot outside CI and refuse to in CI (`--ci`), so
a corpus file pushed without them fails. Read what they wrote before committing it.

An expected change to the DOM or phone snapshot (a fixed defect, a changed English text) is
updated with `npx vitest run <the shard file> --update` or `jest <file> -u`, and the snapshot diff
goes in the pull request for review. A change that only adds `bfa-` or `u-` classes does not touch
the DOM snapshot.

## Adding a corpus file

A change that brings new vocabulary adds its own example, so later changes cannot break it:

1. Write `corpus/<name>.json` (lower-case words and dashes) with `about.source`, `about.captured`
   and the `definition` exactly as the product would store it. For a template, store it as
   create-from-template does: `canonicalizeAppDefinition(<deep clone of template.definition>).def`,
   with `about.templateId` set and the data model run through `canonicalizeDataModel`.
2. `cd server && node appStudio/compat/freeze.mts` writes `frozen/<name>.json` for every input that
   has none yet. It never touches an existing frozen file.
3. Read the frozen file. It is now the contract for that app.

`node appStudio/compat/freeze.mts --check` writes nothing and lists every input whose frozen file is
missing or differs from what the code produces today.

`--all` rewrites every frozen file. The guard then fails the pull request, as it should.
