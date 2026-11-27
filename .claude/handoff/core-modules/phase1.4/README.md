# Step 1.4 and 1.5: the core stands without any module

The rules for every worker of this step. Your own work list is the file beside this one named
after your area (`chat-runtime.md`, `knowledge.md`, ...): the core files of your area that
still reach into a module, and the core test files of your area that fail with every module
hidden. Touch only the core files of YOUR list, the shared files named below, and the tests
next to your files.

## The two measures

1. **Import edges from a core-owned file into a module-owned file**:
   `node scripts/module-boundary.mjs --list`. They go to zero.
2. **Core test files that fail with every module hidden**:
   `cd server && node scripts/run-tests.mjs --hide-modules all --files <tree path>[,<tree path>...]`.
   (`--scope core --hide-modules all` runs them all; that takes about ten minutes, the driver does it.)

With every module present nothing may change: the same functions are called in the same order
with the same results, the composition goldens stay as they are, the route contract does not move.

## Settle each edge, in this order of preference

### 1. Ownership: whose file is it really? (no code change)

- The **core file exists only for one module** (a kit that builds that module's fixtures, a
  script that migrates that module's data, a route helper only that module's routes use):
  give it to the module. Add a glob line to `modules.<id>.server` in `scripts/module-map.json`.
  Only possible when no core-owned file requires it afterwards.
- The **target is really core**: a small helper the core needs that does not depend on the
  rest of its module. Add it to `core.server` in the map (those globs win over module globs).
  Check what it requires first: a file that pulls in its module's stores is not core.

`node scripts/module-map.mjs --owner server/<path>`, `--check`, `--list <id>`. The header of
`scripts/module-map.mjs` has the glob rules (a colocated test follows its source unless a glob
names the test itself).

### 2. An optional lookup by name

The core asks for the module's file by name and takes "absent" for an answer.

In the core file:

```js
const { optionalFeatureModule } = require('../core/featureModules');   // path as it is from your file
...
const studioApps = optionalFeatureModule('stores/studioAppStore');
if (!studioApps) return [];           // the absent answer, see below
```

In the module (three lines, in three files that already exist for every module):

- `server/firstParty/<id>.register.js`: a getter line inside the block
  `contribute('boot/featureModules', () => require('../core/featureModules').registerFeatureModules({ ... }))`:
  `'stores/studioAppStore': () => require('../stores/studioAppStore'),`
- `server/firstParty/<id>.provides.json`: the name in `"featureModules"`.
- `server/core/featureModules.js`: a line in the `FeatureModuleMap` typedef:
  `'stores/studioAppStore': typeof import('../stores/studioAppStore'),` (use `any` only when
  the module's own types make a caller of yours fail to typecheck, and say so).

The name is the target's tree path without its extension. `optionalFeatureModule` returns the
module's exports when the module is loaded, `null` when it is absent, and throws a
`ModuleFailedError` when the module failed to load (so a broken module never looks absent).
`boot/featureModules.test.js` and `modules/firstParty/provides.test.js` hold the three lines
against each other. Where the target is already an integration client or a runner port, use
`optionalIntegrationClient(name)` or `optionalRunnerPort(name)` instead.

Rules for the call site:

- **Keep the place.** A lazy `require` inside a function becomes a lookup at that same place.
  A top-level `require` of a module file becomes a lookup at each point of use: never look up
  while the file loads, the modules may not have registered yet.
- **The absent answer** is what the caller already does when there is nothing: an empty list,
  zero, `null`, the block skipped, a tool not offered, a setting not shown. It must be what a
  user of an installation without that module would call correct. When the only honest answer
  is "this needs module X", throw an `HttpError` (`core/http/errors.js`) with status 404 or 409
  and code `module_absent`. Never report success for something that did not happen.
- **Present means identical.** No reordering, no changed arguments, no changed error text.
- A `featureModule('<name>')` lookup that your list names (the ratchet counts those too)
  becomes `optionalFeatureModule` with its absent answer; its registration already exists.
- Not the mechanism: a `try { require(...) }` that maps `MODULE_NOT_FOUND` to null
  (`boot/optionalModuleFile.js`, `boot/optionalRequire.js`). It cannot tell a module this
  edition leaves out (`BEEFLOW_EDITION=core`: the files are there, the module is not loaded)
  from one that is loaded. Area `shell` replaces the five uses and deletes both helpers.

### 3. Leave it and report it

When neither fits: the core file is half the module's logic and has to be split by someone who
decides where the line goes, or the edge is a data duty outside the `data-duties` area (below).
Say what you would do. No new registries, ports or abstractions in this step: report a
candidate under `followUps`.

## Data duties are never skipped silently

Erasing, exporting, pruning (retention) or re-encrypting a module's data on behalf of the core
is a data duty. When the module is absent the answer is not simply "skip": if this database
ever held the module's data, an erasure that skips it reports success while personal data
stays behind. Area `data-duties` builds the guard for this (`data-duties-design.md` beside this
file). If you meet such an edge in another area, leave it and list it under `dataDuties`.

## The failing core tests of your list

For each file: run it in core mode (command above), read the first error, and settle it:

1. **It is the module's test.** It tests a module's behaviour, through a core file or not: give
   the test file to that module in the map (a glob that names the test file itself).
2. **It fails on an edge of your list.** Cutting the edge makes it green. Check.
3. **It mixes both.** Split it: the assertions about the module move, unchanged, to a new test
   file beside it that the module owns (`<name>.<moduleId>.test.js`, given to the module in
   the map); the core half stays. Shared set-up goes through the kit the file already uses.
   Never delete or skip an assertion, and no `if (core mode)` around one. The one exception is
   a test about the composition itself ("each module that is here contributes ..."): there
   "when the module is present" is the honest wording; say so in your report.
4. **It needs a kit under `testUtils/` that is module-owned or loads module code.** Report it
   under `kits`; area `kits-scripts` decides. Do not edit `testUtils/`.
5. **The cause is outside your area.** Report the file with its first error line.

Every test you touch stays green in full mode too.

## Shared files (several workers append to them, the driver merges)

`server/firstParty/<id>.register.js`, `server/firstParty/<id>.provides.json`,
`server/core/featureModules.js` (the typedef map only) and `scripts/module-map.json`. Add
lines, one name per line, at the end of the block or list. Do not reorder, reformat or rewrap
existing lines: your branch is merged with six others.

## Do not

- edit `server/modules/firstParty/order.json`, the loader, a golden, `server/.module-boundary-ratchet.json`,
  `pendingBudget` of `scripts/roots-inventory.json`, or raise any budget;
- add an eslint suppression or skip a test;
- refactor beyond the edge you are settling.

## Gates before you commit

- `npm run check:fast`
- `cd server && npm run typecheck`
- `cd server && npx eslint <your files>`
- `cd server && node scripts/run-tests.mjs --files <every test next to a file you changed>`
- `cd server && node --test boot/composition.*.characterisation.test.js` (goldens unchanged)
- `cd server && node scripts/run-tests.mjs --files modules/firstParty/compositions.test.js,modules/firstParty/provides.test.js,boot/featureModules.test.js,importPaths.test.js,layering.test.js,routes.contract.test.js`
- `npm run test:scripts` when you touched `scripts/`
- `npm run lint:duplication`
- core mode: every core file you changed loads
  (`cd server && BEEFLOW_HIDE_MODULES=all node -e "require('./moduleRoots.cjs'); require('./testUtils/registerFeatures.js'); require('./<file>')"`),
  and the test files of your list are green or reported.
