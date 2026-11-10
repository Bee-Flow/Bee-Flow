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
| `reads` | per binding and saved dataset, per role, in sqlite and pg: the SQL and params the query compiler produces (`readSql.mts` says how) | `reads.test.js` |

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
