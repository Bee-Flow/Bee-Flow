# Data duties: the design for area `data-duties`

Read `README.md` beside this file first. This area has the same edges-and-tests work as the
others (`data-duties.md` is its work list), plus one piece of new core code.

## The problem

The core does things to module data on a user's or the platform's behalf:

- **erasure** of an account or an organisation (`stores/user/usersDelete*.js`,
  `stores/user/organizations.js`, `stores/user/projectErasure.js`, `stores/user/orgErasure.js`,
  `projects/accountContentErasure.js`, through `stores/user/erasurePorts.js`);
- **retention** (`jobs/platformRetention.js`, `jobs/memoryRetentionEnforcer.js`);
- **re-encryption** (`stores/encryptionBackfill.js`, `stores/lib/sheetCrypto.js`).

Today these files require the module's stores directly. With the module absent a plain
optional lookup would skip the module's part and report success. For an erasure that is wrong
whenever the database still holds that module's rows: the module was installed, wrote personal
data, and was then removed. `stores/user/erasurePorts.js` already says it for today's ports:
FAIL CLOSED, an erasure that cannot reach the data refuses.

## The rule

A data duty reaches the module's code whenever that code is in the tree and this database
holds the module's schema, whether or not this edition loads the module. The edition switch
hides features; it does not orphan data. Only when the code is not there and the schema is,
an erasure refuses.

| State of M | M's files in the tree? | Database holds M's schema? | Erasure, export | Retention, re-encryption |
|---|---|---|---|---|
| loaded | - | - | runs, as today | runs, as today |
| failed | - | - | throws (`ModuleFailedError`, from the lookup) | throws; the job logs it as it logs any failed pass |
| absent | yes (this edition leaves M out) | yes | runs with M's file, as today | runs with M's file, as today |
| absent | yes | no | skipped: there is nothing, and M's schema is not created for it | skipped |
| absent | no (core mode, not installed) | no | skipped | skipped |
| absent | no | yes | **refuses**: throws `ModuleDataPresentError` | skipped with one `log.warn` per process naming the module and the duty |

Row 3 is today's behaviour of `BEEFLOW_EDITION=core` and of a `BEEFLOW_MODULES` list on a
database that ran the full edition before: the module's routes and jobs are off, its data is
still erased with the account. It must stay that way.

"Holds M's schema" is read from the schema ledger: every store init is a unit `store:<tag>`
in `schema_migrations` (`stores/lib/ddlLedger.js`, `ddlLedgerTable.js`; the tag is the first
argument of `makeStoreInit`). A unit of a store that M owns means M's tables were created in
this database. No ledger table, or no such unit: no schema. (Whether the tables hold rows is
not asked: an empty table and a full one refuse alike in the last row. A later step may add
a purge for a module that is gone for good; say so under followUps, do not build it.)

## What to build (core, `// @typecheck strict`, with tests beside it)

`server/modules/firstParty/moduleData.js`:

```js
/**
 * The module file `name` for a data duty, or null when there is nothing to do.
 * @param {string} moduleId   the first-party module that owns the data, e.g. 'apps'
 * @param {K} name            a FeatureModuleMap name: the tree path of M's file, without extension
 * @param {{ duty: string, whenDataPresent: 'refuse' | 'warn' }} opts
 *   duty: a few words for the message, e.g. "erase the apps of an account"
 * @returns {Promise<FeatureModuleMap[K] | null>}
 */
async function moduleForDataDuty(moduleId, name, opts)

/** Does this database hold a schema of that module? */
async function hasSchemaOf(moduleId)

class ModuleDataPresentError extends Error   // code 'MODULE_DATA_PRESENT', moduleId, duty
```

- Loaded or failed: exactly `optionalFeatureModule(name)` (it returns the module, or throws).
  M registers the name like any other lookup (register part, provides file, typedef line).
- Absent: first `hasSchemaOf(moduleId)`. No schema: null. Schema and M's file is in the tree
  and not hidden (`moduleRoots.cjs`: `treePath`, `hiddenOwner`; the name plus `.js`, `.mts` or
  `.cjs`): require that file and return it. Schema and no file: throw (`refuse`) or warn once
  and return null (`warn`).
- The record of which ledger units belong to which module is core data, because the module
  may not be there to ask: add `"storeUnits": { "store:<Tag>": "<module id>", ... }` to
  `server/modules/firstParty/migrationOwners.json` (it already records the owners of the loose
  migrations for the same reason). A test holds it equal to the tree with every module
  visible: every store row of every composition (`firstParty/<id>.stores.js`), the tag its file
  passes to `makeStoreInit`, the owner of that file in `scripts/module-map.json`. Follow
  `boot/migrationLadder.test.js`, which does the same for migrations. Say in your report how
  you read the tag (a static scan of the store file is fine; a store without a ledger unit is
  listed with the reason).
- `hasSchemaOf` reads the ledger through the query function the ledger itself uses. A failure
  of its own is "cannot tell": for `refuse` that REFUSES when M's file is not in the tree
  (fail closed) and runs M's file when it is; for `warn` it warns. Cache a positive answer for
  the life of the process, a negative one only briefly (a module can arrive while the server
  runs, later).
- The message names the way out: `module "apps" is not installed but this database holds its
  data; refusing to erase the apps of an account. Install the module or remove its data first.`

## Where to use it

Every edge of your work list that is a data duty: the lookup goes through
`moduleForDataDuty` instead of `optionalFeatureModule`, with the absent branch skipping that
module's part of the duty. Keep the code where it is: the step functions stay in the core
file, only the `require` of the module's store becomes the lookup, and SQL of theirs that
names a module table is guarded by the same lookup result. Moving a whole function into the
module is allowed only when it is entirely about that one module and the move is a cut and
paste (then the core calls it through the lookup); say so in your report.

Edges of your list that are not data duties (a count, a read for display) are ordinary
optional lookups.

The existing erasure ports (`stores/user/erasurePorts.js`): the port `projects` is registered
by the module `projects` today, so with every module hidden `resolveErasurePorts()` refuses
every erasure. The project container (the stores, access, teardown of a project) is core by
decision; the Solutions features on top are the module. Find out which side
`projects/projectTeardown` and the `projects` port really are (what they require), and settle
it by ownership if they are the container. `notebooks` and `content` likewise: a port the
core needs for its own tables is core; a port that only reaches module data goes through the
rule above.

## What must hold at the end

- Full mode: every erasure, retention and backfill test passes unchanged, including the
  characterisation tests (`stores/user/usersDelete.characterisation.pg.test.js` and its
  neighbours). No trace or golden changes.
- Core mode (`--hide-modules all`): deleting a user and deleting an organisation work on a
  database that never held a module (the core's own tests of those paths are green), and
  refuse with `ModuleDataPresentError` on one that did. Write the six rows of the table as
  tests of `moduleData.js` with a ledger double and a tree double; do not build a database
  for them.
- `BEEFLOW_EDITION=core`: on a fresh database nothing of a module is created by an erasure;
  on a database with the modules' schema the erasure reaches the module data as it does
  today. Check one erasure path by hand in both and report what you saw.
