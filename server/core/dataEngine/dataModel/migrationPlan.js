// @typecheck
/**
 * App Studio data model — migration planning: the ordered DDL that carries a
 * database from one model's physical schema to the next, diffed by stable id.
 *
 * Which tables are physical and the model coercion: ./migrationShape.js.
 * Retained columns (Solution stages): ./retainedColumns.js.
 */

'use strict';

const { HttpError } = require('../../http/errors');
const {
    qi,
    isAlterPhysical,
    isStoredComputed,
    uniqueIndexName,
    ddlForTable,
    ddlForStoredComputedColumn,
    dropColumnDdl,
    addColumnDdl,
} = require('./ddl');
const { isPhysical, coerceModelShape } = require('./migrationShape');
const { autonumberBackfillDdl } = require('./autonumber');
const { exprMentions } = require('./fieldConversion.mts');
const { survivingAlterable, pushOp, pushProbe, opBase, rebuildStoredComputed, convertingKeysOf } = require('./migrationRebuild');
const { junctionSteps, dropJunctions, indexSteps } = require('./migrationLinked');
const {
    retireMetaFor, retiredColumnKey, readRetireState, retainConflicts,
    retainOptions, conflictsOf, retiredHadColumn, retireDdl, unretireDdl,
} = require('./retainedColumns');

// ---------------------------------------------------------------------------
// Migration planning — the riskiest piece (property-tested).
//
// Every step below takes the plan context `p` migrationPlan builds:
//   { oldTables, newTables, newKeyById, retain, inScope(id), alterable(id),
//     physical, materialised, dialect, plan }
// and pushes its statements onto p.plan, in the order the header lists.
// ---------------------------------------------------------------------------

/** 1. Table renames (id survives, key changed). */
function renameTables(p) {
    for (const [id, nt] of p.newTables) {
        if (!p.inScope(id) || !p.alterable(id)) continue;
        const ot = p.oldTables.get(id);
        if (ot && ot.key !== nt.key) p.plan.push(`ALTER TABLE ${qi(ot.key)} RENAME TO ${qi(nt.key)}`);
    }
}

/**
 * 1b. Retirements (retainRetired): relax the constraints and move the column
 * aside BEFORE any rename or add, so a field that takes over the retired key in
 * this same plan finds it free.
 */
function retireFields(p) {
    if (!p.retain) return;
    for (const [, nt, ot] of survivingAlterable(p)) {
        const newIds = new Set(nt.fields.map(f => f.id));
        for (const of of ot.fields) if (!newIds.has(of.id)) p.plan.push(...retireDdl(nt, of));
    }
}

/** 2. Column renames within surviving tables (uses the NEW table key). */
function renameColumns(p) {
    for (const [, nt, ot] of survivingAlterable(p)) {
        const oldById = new Map(ot.fields.map(f => [f.id, f]));
        for (const nf of nt.fields) {
            const of = oldById.get(nf.id);
            if (of && of.key !== nf.key && isAlterPhysical(of) && isAlterPhysical(nf)) {
                p.plan.push(`ALTER TABLE ${qi(nt.key)} RENAME COLUMN ${qi(of.key)} TO ${qi(nf.key)}`);
            }
        }
    }
}

/** 3. New tables — and a table that went from linked to own storage, because it never had one. */
function createTables(p) {
    for (const [id, nt] of p.newTables) {
        if (!p.inScope(id) || !p.physical.has(id)) continue;
        if (!p.oldTables.has(id) || p.materialised.has(id)) {
            p.plan.push(ddlForTable(nt, /** @type {Parameters<typeof ddlForTable>[1]} */ ({ tableKeyById: p.newKeyById, dialect: p.dialect })));
        }
    }
}

/** 4. New columns on surviving tables. */
function addColumns(p) {
    for (const [, nt, ot] of survivingAlterable(p)) {
        const oldIds = new Set(ot.fields.map(f => f.id));
        const converting = p.convertingKeys.get(nt.id) || [];
        for (const nf of nt.fields) {
            if (oldIds.has(nf.id)) continue;
            // A retired field coming back: its column never left the table.
            if (p.retain && p.retain.meta.has(nf.id) && retiredHadColumn(p.retain.meta.get(nf.id))) {
                p.plan.push(...unretireDdl(nt, nf, p.retain.meta.get(nf.id), p.newKeyById, p.dialect));
                continue;
            }
            // A stored-computed field IS physical, but addColumnDdl refuses
            // every computed type — it speaks for the ordinary path, where a
            // computed field is read-time and has no column at all. Without
            // this branch the model grew a field the database never did:
            // saveDataModel reported success, every read came back with the
            // key simply missing, and nothing anywhere said so. Step 4b only
            // ever sees fields that already existed, so it could not catch it.
            // The ADD fills every existing row (VIRTUAL on SQLite, see ddl.js).
            if (isStoredComputed(nf)) {
                // One that reads a column converted in this plan waits for the
                // conversion (4b): the column cannot change under it.
                if (converting.some(k => exprMentions(nf.computed.expr, k))) continue;
                const at = p.plan.length;
                const opIndex = pushOp(p, [ddlForStoredComputedColumn(nt.key, nf, p.dialect)], opBase('recompute', 'new', { nt, ot, nf, of: null }));
                pushProbe(p, { tableKey: nt.key, opIndex, at });
                continue;
            }
            p.plan.push(...addColumnDdl(nt.key, nt.id, nf, p.newKeyById, p.dialect));
            // An autonumber numbers the rows that were there (a new row gets its number on insert).
            if (nf.type === 'autonumber') p.plan.push(autonumberBackfillDdl(nt.key, nf.key));
        }
    }
}

/** 5. Unique toggles on surviving fields. */
function toggleUnique(p) {
    for (const [, nt, ot] of survivingAlterable(p)) {
        const oldById = new Map(ot.fields.map(f => [f.id, f]));
        for (const nf of nt.fields) {
            const of = oldById.get(nf.id);
            if (!of || !isAlterPhysical(nf)) continue;
            if (!of.unique && nf.unique) {
                p.plan.push(
                    `CREATE UNIQUE INDEX IF NOT EXISTS ${qi(uniqueIndexName(nt.id, nf.id))} ` +
                    `ON ${qi(nt.key)} (${qi(nf.key)})`
                );
            } else if (of.unique && !nf.unique) {
                p.plan.push(`DROP INDEX IF EXISTS ${qi(uniqueIndexName(nt.id, nf.id))}`);
            }
        }
    }
}

/**
 * 6. Dropped columns on surviving tables (drop unique index first). Never
 * under retainRetired: step 1b retired every one of them.
 */
function dropColumns(p) {
    if (p.retain) return;
    for (const [, nt, ot] of survivingAlterable(p)) {
        const newIds = new Set(nt.fields.map(f => f.id));
        for (const of of ot.fields) {
            if (newIds.has(of.id)) continue;
            // The mirror of step 4: a stored-computed column is physical, so
            // removing the field has to take the column with it or the column
            // outlives the only thing that explained it.
            if (isStoredComputed(of)) { p.plan.push(dropColumnDdl(nt.key, of.key, p.dialect)); continue; }
            if (!isAlterPhysical(of)) continue;
            if (of.unique) p.plan.push(`DROP INDEX IF EXISTS ${qi(uniqueIndexName(nt.id, of.id))}`);
            p.plan.push(dropColumnDdl(nt.key, of.key, p.dialect));
        }
    }
}

/**
 * 7. Dropped tables (last, so nothing references them mid-plan). Only tables
 * that HAD a physical table: a linked table leaving the model leaves nothing
 * behind to drop, and a DROP on its key could hit the same-named table of
 * another kind.
 */
function dropTables(p) {
    // Under retainRetired a table leaving the release is detached, never
    // dropped: a deploy must not destroy data a rollback brings back.
    if (p.retain) return;
    for (const [id, ot] of p.oldTables) {
        if (!p.inScope(id) || !isPhysical(ot)) continue;
        if (!p.newTables.has(id)) p.plan.push(`DROP TABLE IF EXISTS ${qi(ot.key)}`);
    }
}

/**
 * Produce an ORDERED list of DDL strings that migrate a SQLite database from
 * `oldModel`'s physical schema to `newModel`'s. Diffing is by STABLE id, so a
 * key change is a RENAME. Order (each group before the next):
 *
 *   1. table renames            ALTER TABLE … RENAME TO
 *   2. column renames           ALTER TABLE … RENAME COLUMN
 *   3. new tables               CREATE TABLE (+ unique indexes)
 *   4. new columns              ALTER TABLE … ADD COLUMN (+ unique index)
 *   4a. junction tables         CREATE TABLE for a new many relation (migrationLinked.js)
 *   4b. stored-computed rebuilds DROP, type conversions, ADD (see step 4b)
 *   5. unique toggles           CREATE/DROP UNIQUE INDEX on surviving columns
 *   5b. declared indexes        DROP INDEX / CREATE INDEX (table.indexes, migrationLinked.js)
 *   6. dropped columns          DROP INDEX (if unique) then DROP COLUMN
 *   6b. dropped junctions       DROP TABLE of a many relation that left the model
 *   7. dropped tables           DROP TABLE
 *
 * Renames run first so later column ops address the new table name. New tables
 * precede new columns so a relation ADD COLUMN can reference a freshly-created
 * parent. Column drops handle SQLite's "can't DROP an indexed column" rule by
 * dropping the unique index first.
 *
 * Not emitted (documented limitations): a type change outside the safe pairs
 * of fieldConversion.mts, and turning a plain column into a relation FK (both
 * need a table rebuild). The safe pairs convert only with opts.convertTypes.
 * A stored-computed field added to an already-created table IS
 * materialised (step 4): left as a documented gap, it would be silent, and the
 * model would list a field the table
 * never grew.
 *
 * `opts.onlyTableIds` narrows WHICH tables may produce DDL. The diff still runs
 * over the whole model — a relation column's REFERENCES names a target that may
 * sit outside the scope — but a create, a delete or a one-table schema save can
 * then never emit DDL for a table it is not touching. Without it, a plan built
 * from two whole-org model documents carries out whatever else they disagree
 * about, another editor's half-finished DROP COLUMN included.
 *
 * `opts.retainRetired` (Postgres only) is the Solution-stage deploy: a field a
 * release no longer carries is RETIRED, not dropped, so a rollback brings it
 * back with its data. Under the option NO field of a surviving table is ever
 * dropped: every field missing from `new` retires, listed or not, because a
 * forgotten `retired_fields` entry must never turn into an irreversible DROP
 * COLUMN inside a deploy commit. Retiring also moves the column out of the way
 * (retiredColumnKey), so a later field with the same key gets a column of its
 * own instead of landing on the retired one. See retireDdl / unretireDdl for
 * the statements and retireMetaFor for the record a retirement leaves behind.
 *   retiredFieldIds  Set of field ids retired by THIS plan. Informational:
 *                    every missing field retires anyway.
 *   retiredMeta      Map fieldId → retireMetaFor(field, state), recorded when
 *                    the field was retired. The old model's `retired_fields`
 *                    entries count too. A field in `new` that was retired comes
 *                    back: no ADD COLUMN (the column never left), its column
 *                    renamed back and its constraints re-added.
 * A retaining plan the database cannot carry out faithfully (a returning field
 * whose column type changed, a live key that would land on a retired column)
 * throws an HttpError 409 `schema_retain_conflict` with `details.findings`;
 * `retainConflicts` returns the same findings without throwing.
 *
 * `opts.convertTypes` converts a field whose type changed in place when the
 * pair is safe (fieldConversion.mts SAFE_CONVERSIONS); off (the default) a type
 * change emits nothing, as it always did. `opts.onUnconvertible` 'refuse'
 * (default) adds a refusing probe per conversion, 'clear' sets the values that
 * cannot convert to NULL.
 *
 * Returns `{ statements, ops, probes }`:
 *   ops     the report entries: { kind: 'recompute'|'convert'|'unsupported',
 *           reason, tableId, tableKey, oldTableKey, fieldId, fieldKey,
 *           oldFieldKey, from?, to?, action?, first, last } (statement range;
 *           -1 when the op has no statement).
 *   probes  { sql, at, opIndex, refuse, tableKey }: a COUNT the engine runs
 *           right before statement `at` (n rows, bad unconvertible values); a
 *           refusing probe with bad > 0 fails the migration.
 */
function planMigration(oldModel, newModel, opts = {}) {
    // Threaded into every ddl.js emitter: a plan for a Postgres-backed store must
    // not be compiled under the process-global App Studio dialect (engineFlag.js).
    const dialect = opts.dialect;
    // Array.isArray, not `?.length`: an empty list means "touch nothing", and
    // treating it as "no scope given" would widen the plan to the whole model.
    const only = Array.isArray(opts.onlyTableIds) ? new Set(opts.onlyTableIds) : null;
    const inScope = (id) => !only || only.has(id);
    const oldC = coerceModelShape(oldModel);
    const newC = coerceModelShape(newModel);

    const oldTables = new Map(oldC.tables.map(t => [t.id, t]));
    const newTables = new Map(newC.tables.map(t => [t.id, t]));
    const newKeyById = new Map(newC.tables.map(t => [t.id, t.key]));
    const retain = retainOptions(opts, oldC, newC, dialect);
    if (retain) {
        const conflicts = conflictsOf(oldC, newC, retain, inScope);
        if (conflicts.length) {
            throw new HttpError(409, 'schema_retain_conflict',
                'The stage schema cannot keep its retired columns apart from this release', { findings: conflicts });
        }
    }

    // ── The second kind of table ────────────────────────────────────
    // A LINKED table has no physical table: no CREATE, no ALTER, no index, no
    // DROP COLUMN. `physical` is the set of ids that DO have a table in the
    // app database in this migration.
    //
    // Two transitions, and they are not symmetric:
    //   linked → own storage  The physical table does NOT exist; it must
    //     still be created, with all its columns. `materialised` remembers
    //     that, so step 3 creates it and 2/4/4b/5/6 skip it — they would
    //     alter a table that was just laid down complete.
    //   own storage → linked  The physical table DOES exist, with rows in it.
    //     It is not dropped: that would destroy data on a model change. It
    //     stays until someone really deletes the table.
    const physical = new Set([...newTables].filter(([, nt]) => isPhysical(nt)).map(([id]) => id));
    const materialised = new Set(
        [...newTables]
            .filter(([id, nt]) => isPhysical(nt) && oldTables.has(id) && !isPhysical(oldTables.get(id)))
            .map(([id]) => id),
    );
    const p = {
        oldTables, newTables, newKeyById, retain, inScope, physical, materialised, dialect, plan: [],
        alterable: (id) => physical.has(id) && !materialised.has(id),
        convertTypes: opts.convertTypes === true,
        onUnconvertible: /** @type {'refuse' | 'clear'} */ (opts.onUnconvertible === 'clear' ? 'clear' : 'refuse'),
        convertingKeys: new Map(), ops: [], probes: [],
    };
    p.convertingKeys = convertingKeysOf(p);
    renameTables(p);           // 1
    retireFields(p);           // 1b
    renameColumns(p);          // 2
    createTables(p);           // 3
    addColumns(p);             // 4
    junctionSteps(p);          // 4a (many relations, migrationLinked.js)
    rebuildStoredComputed(p);  // 4b (with the type conversions)
    toggleUnique(p);           // 5
    indexSteps(p);             // 5b (declared indexes)
    dropColumns(p);            // 6
    dropJunctions(p);          // 6b
    dropTables(p);             // 7
    return { statements: p.plan, ops: p.ops, probes: p.probes };
}

/**
 * The ordered DDL of planMigration (the ~15 callers that only run the plan).
 * @returns {string[]}
 */
function migrationPlan(oldModel, newModel, opts = {}) {
    return planMigration(oldModel, newModel, opts).statements;
}

module.exports = { migrationPlan, planMigration, retireMetaFor, retiredColumnKey, readRetireState, retainConflicts };

/** @typedef {import('./migrationShape').ModelTable} ModelTable */
/** @typedef {import('./migrationShape').ModelField} ModelField */

/**
 * The plan context every step takes (see below).
 * @typedef {{ oldTables: Map<string, ModelTable>, newTables: Map<string, ModelTable>, newKeyById: Map<string, string>,
 *   retain: ReturnType<typeof retainOptions>, inScope: (id: string) => boolean, alterable: (id: string) => boolean,
 *   physical: Set<string>, materialised: Set<string>, dialect: string, plan: string[] }} PlanContext
 */
