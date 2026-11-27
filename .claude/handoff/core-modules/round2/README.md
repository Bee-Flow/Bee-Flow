# Round 2: the core is right without its modules, not only startable

Read `../phase1.4/README.md` first: its rules still hold (settle by ownership, then by a lookup
by name, then report; present means identical; the absent answer; how to settle a failing core
test; the shared files; the do-nots; the gates). This file says what changed since, and what
this round adds. Your own task is the file beside this one that your prompt names.

## Where we are

- `node scripts/module-boundary.mjs`: 0 core -> module import edges, budget 0. Keep it there.
- With every module hidden (`BEEFLOW_HIDE_MODULES=all`) `npm run db:migrate` works on an empty
  database (138 tables) and `node index.js` reaches `/api/ready`.
- With every module present nothing moved: schema, API reference, route contract, goldens.
- Core test files that fail with every module hidden: the list in `failing-core-tests.txt`
  beside this file (the driver measures; `cd server && node scripts/run-tests.mjs --hide-modules all --files a,b`
  runs some of them).

## What changed in the mechanism since phase 1.4

1. **The registry fills itself.** `optionalFeatureModule(name)` registers the modules' names on
   its first miss, so its answer no longer depends on whether the process loaded
   `boot/featureModules.js`. A lookup while a ROUTE file loads is therefore allowed where a
   schema or a router has to be built at load (two exist: `routes/ai/config/userSettings.js`,
   `routes/ai/config/integrations.js`). Everywhere else keep lookups at the point of use.
2. **The platform layer** (`stores/`, `auth/`, `core/entitlements/`, `modules/`) may not require
   `core/featureModules.js` (layering budgets). It looks a module file up with
   `require('<rel>/modules/firstParty/moduleData').lookupFeatureModule(name)`: same answer.
3. **Data duties** (`../phase1.4/data-duties-design.md`, "As built"): `moduleForDataDuty` asks
   the registry first, then the loader's state; a loaded module's duty is never skipped; with
   the module's data in the database but not its code, `refuse` throws
   `ModuleDataPresentError` and `warn` logs once. `hasSchemaOf(moduleId)` says whether this
   database holds the module's schema.
4. **Test doubles go by name.** Code that looks a module up by name no longer reaches a double
   installed on a require string. A test registers its double under the lookup name:
   `require('<rel>/core/featureModules').registerFeatureModules({ 'stores/coworkStore': () => DOUBLE })`
   (each test file is its own process). A double registered by name makes the "present" path
   testable with every module hidden: such a test is a core test.
5. **A module's part of a core query lives in the module.** Where a core file holds SQL or logic
   about several modules' tables (a usage scan, a read model, a retention pass), each module's
   part moves, cut and paste, into a file that module owns, and the core asks for each by name
   from a fixed list and leaves out the ones that are absent:

   ```js
   // core
   const PARTS = /** @type {const} */ (['core/kb/usage/automation', 'core/kb/usage/apps', ...]);
   for (const name of PARTS) {
       const part = optionalFeatureModule(name);   // or lookupFeatureModule / moduleForDataDuty
       if (!part) continue;                         // that module is not here: its kind is left out
       rows.push(...await part.scan(args));
   }
   ```

   The order of `PARTS` is today's order, so with every module present the result is identical.
   No new registry: the names are ordinary feature-module names (register part, provides file,
   typedef line). A part that erases, exports, prunes or re-encrypts is a data duty.

## Two ways a module is absent; test both

- **Its files are not there**: `BEEFLOW_HIDE_MODULES=all` (a checkout), later a core image.
- **Its files are there, this edition does not load it**: `BEEFLOW_EDITION=core`, or a
  `BEEFLOW_MODULES=a,b` list. Lookups answer null, its routes are not mounted, its stores are
  not initialised. Data duties still reach its data when the database holds its schema.

## Workers of this round share these files (append lines only, do not reorder or reformat)

`server/firstParty/<id>.register.js`, `server/firstParty/<id>.provides.json`,
`server/core/featureModules.js` (typedef map), `scripts/module-map.json`.
Do not regenerate `server/boot/composition.registries.characterisation.golden.json`: new names
make its `featureModules` entry differ, the driver regenerates it once after merging. Say in
your report that it differs only by your names.

## Gates before you commit (in addition to phase 1.4's)

- `node scripts/module-boundary.mjs` stays at 0.
- `npm run lint:duplication` (production and test under budget).
- `npm run lint:api-reference`, `npm run lint:routes-contract`, `npm run lint:api-types` when you
  touched a route or a schema: all unchanged.
- Commit on your worktree branch, never push. End the commit message with
  `Co-Authored-By: Claude <noreply@anthropic.com>` and nothing else after it (no session link,
  no `Claude-Session:` line).
