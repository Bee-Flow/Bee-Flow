/**
 * App Studio data model — migration planning: the ordered DDL that carries a
 * database from one model's physical schema to the next, diffed by stable id.
 */

'use strict';

const { isPlainObject } = require('./shared');
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

// ---------------------------------------------------------------------------
// Migration planning — the riskiest piece (property-tested).
// ---------------------------------------------------------------------------

/**
 * Heeft deze modeltabel een FYSIEKE tabel in de app-database?
 *
 * Nee zodra ze een `source` draagt: haar rijen staan in een Studio-datatabel,
 * buiten de app (core/dataEngine/dataModel/vocabulary.js). Elke waarde behalve
 * null/undefined telt als "gekoppeld" — precies zoals
 * appStudio/datatableSource.isDatatableBacked het leest — want een kapotte
 * `source` stil als eigen opslag behandelen is hoe er een tabel ontstaat die
 * niemand vult en niemand leest.
 *
 * WAAROM DIT HIER STAAT. Zonder deze vraag kreeg een gekoppelde tabel gewoon
 * een CREATE TABLE, en die schaduwtabel was niet alleen dood gewicht: hij was
 * de landingsplaats die een schrijving naar de verkeerde opslag STIL maakte.
 * Zonder de tabel geeft zo'n schrijving een SQL-fout; mét de tabel slaagt de
 * INSERT en verdwijnt de rij zonder spoor. De opslagkant is inmiddels dicht
 * (actionExecutor/records.js); dit is de andere helft van diezelfde golf.
 */
function isPhysical(table) {
    const src = table ? table.source : null;
    return src === undefined || src === null;
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
 *   5. unique toggles           CREATE/DROP UNIQUE INDEX on surviving columns
 *   6. dropped columns          DROP INDEX (if unique) then DROP COLUMN
 *   7. dropped tables           DROP TABLE
 *
 * Renames run first so later column ops address the new table name. New tables
 * precede new columns so a relation ADD COLUMN can reference a freshly-created
 * parent. Column drops handle SQLite's "can't DROP an indexed column" rule by
 * dropping the unique index first.
 *
 * Not emitted in v1 (documented limitations): converting an existing column's
 * type or turning a plain column into a relation FK (both need a table
 * rebuild). SQLite is dynamically typed, so a field type change needs no DDL
 * for storage. A stored-computed field added to an already-created table IS
 * materialised now (step 4) — it used to be the documented gap here, and the
 * silence when it hit was the problem: the model listed a field the table
 * never grew.
 *
 * `opts.onlyTableIds` narrows WHICH tables may produce DDL. The diff still runs
 * over the whole model — a relation column's REFERENCES names a target that may
 * sit outside the scope — but a create, a delete or a one-table schema save can
 * then never emit DDL for a table it is not touching. Without it, a plan built
 * from two whole-org model documents carries out whatever else they disagree
 * about, another editor's half-finished DROP COLUMN included.
 */
function migrationPlan(oldModel, newModel, opts = {}) {
    // Threaded into every ddl.js emitter: a plan for a Postgres-backed store must
    // not be compiled under the process-global App Studio dialect (engineFlag.js).
    const dialect = opts.dialect;
    // Array.isArray, not `?.length`: an empty list means "touch nothing", and
    // treating it as "no scope given" would widen the plan to the whole model.
    const only = Array.isArray(opts.onlyTableIds) ? new Set(opts.onlyTableIds) : null;
    const inScope = (id) => !only || only.has(id);
    const oldC = coerceModelShape(oldModel);
    const newC = coerceModelShape(newModel);
    const plan = [];

    const oldTables = new Map(oldC.tables.map(t => [t.id, t]));
    const newTables = new Map(newC.tables.map(t => [t.id, t]));
    const newKeyById = new Map(newC.tables.map(t => [t.id, t.key]));

    // ── De tweede tabelsoort ────────────────────────────────────────
    // Een GEKOPPELDE tabel heeft geen fysieke tabel: geen CREATE, geen ALTER,
    // geen index, geen DROP COLUMN. `physical` is de verzameling ids die in
    // deze migratie wél een tabel in de app-database heeft.
    //
    // Twee overgangen, en ze zijn niet symmetrisch:
    //   gekoppeld → eigen opslag  De fysieke tabel bestaat NIET; hij moet
    //     alsnog worden aangemaakt, mét al zijn kolommen. `materialised`
    //     onthoudt dat, zodat stap 3 hem maakt en 2/4/4b/5/6 hem overslaan —
    //     die zouden een tabel altereren die net compleet is neergezet.
    //   eigen opslag → gekoppeld  De fysieke tabel bestaat WÉL, met rijen erin.
    //     Hij wordt niet gedropt: dat zou gegevens vernietigen op een
    //     modelwijziging. Hij blijft staan tot iemand de tabel echt verwijdert.
    const physical = new Set([...newTables].filter(([, nt]) => isPhysical(nt)).map(([id]) => id));
    const materialised = new Set(
        [...newTables]
            .filter(([id, nt]) => isPhysical(nt) && oldTables.has(id) && !isPhysical(oldTables.get(id)))
            .map(([id]) => id),
    );
    const alterable = (id) => physical.has(id) && !materialised.has(id);

    // 1. Table renames (id survives, key changed).
    for (const [id, nt] of newTables) {
        if (!inScope(id) || !alterable(id)) continue;
        const ot = oldTables.get(id);
        if (ot && ot.key !== nt.key) {
            plan.push(`ALTER TABLE ${qi(ot.key)} RENAME TO ${qi(nt.key)}`);
        }
    }

    // 2. Column renames within surviving tables (uses the NEW table key).
    for (const [id, nt] of newTables) {
        if (!inScope(id) || !alterable(id)) continue;
        const ot = oldTables.get(id);
        if (!ot) continue;
        const oldById = new Map(ot.fields.map(f => [f.id, f]));
        for (const nf of nt.fields) {
            const of = oldById.get(nf.id);
            if (of && of.key !== nf.key && isAlterPhysical(of) && isAlterPhysical(nf)) {
                plan.push(`ALTER TABLE ${qi(nt.key)} RENAME COLUMN ${qi(of.key)} TO ${qi(nf.key)}`);
            }
        }
    }

    // 3. New tables — en een tabel die van gekoppeld naar eigen opslag ging,
    //    want die heeft er nog nooit een gehad.
    for (const [id, nt] of newTables) {
        if (!inScope(id) || !physical.has(id)) continue;
        if (!oldTables.has(id) || materialised.has(id)) {
            plan.push(ddlForTable(nt, { tableKeyById: newKeyById, dialect }));
        }
    }

    // 4. New columns on surviving tables.
    for (const [id, nt] of newTables) {
        if (!inScope(id) || !alterable(id)) continue;
        const ot = oldTables.get(id);
        if (!ot) continue;
        const oldIds = new Set(ot.fields.map(f => f.id));
        for (const nf of nt.fields) {
            if (oldIds.has(nf.id)) continue;
            // A stored-computed field IS physical, but addColumnDdl refuses
            // every computed type — it speaks for the ordinary path, where a
            // computed field is read-time and has no column at all. Without
            // this branch the model grew a field the database never did:
            // saveDataModel reported success, every read came back with the
            // key simply missing, and nothing anywhere said so. Step 4b only
            // ever sees fields that already existed, so it could not catch it.
            if (isStoredComputed(nf)) {
                plan.push(ddlForStoredComputedColumn(nt.key, nf, dialect));
                continue;
            }
            plan.push(...addColumnDdl(nt.key, nt.id, nf, newKeyById, dialect));
        }
    }

    // 4b. Stored-computed fields whose RULE changed on a surviving table.
    //
    // The value in a GENERATED ALWAYS column is decided by the expression
    // baked into the column at CREATE time, so editing `computed.expr` in the
    // model used to change nothing at all: the model said one thing, every row
    // kept answering with the old rule, and no error was raised anywhere. A
    // "Controle" column went on reporting "ok" for lines its own definition
    // called doubtful.
    //
    // Rebuilding is safe in a way it never is for a normal column: the data is
    // entirely derived, so DROP + ADD recomputes it from the surviving columns
    // rather than losing anything. That is also what makes read-time ⇄ stored
    // transitions expressible here — a materialise is just an ADD.
    //
    // The expression itself passed computedExprError (no ";", no comment
    // sequences, bounded) during validateDataModel on this very save, the same
    // guard CREATE TABLE relies on.
    for (const [id, nt] of newTables) {
        if (!inScope(id) || !alterable(id)) continue;
        const ot = oldTables.get(id);
        if (!ot) continue;
        const oldById = new Map(ot.fields.map(f => [f.id, f]));
        for (const nf of nt.fields) {
            const of = oldById.get(nf.id);
            if (!of) continue; // brand-new field: handled by step 4 / create
            const wasStored = isStoredComputed(of);
            const nowStored = isStoredComputed(nf);
            if (!wasStored && !nowStored) continue;
            const sameRule = wasStored && nowStored
                && of.computed.expr === nf.computed.expr
                && (of.computed.type || 'text') === (nf.computed.type || 'text')
                && of.key === nf.key;
            if (sameRule) continue;
            // Drop under the OLD key — step 2 renames run before this, so a
            // renamed column already answers to the new name.
            if (wasStored) plan.push(dropColumnDdl(nt.key, nf.key, dialect));
            if (nowStored) plan.push(ddlForStoredComputedColumn(nt.key, nf, dialect));
        }
    }

    // 5. Unique toggles on surviving fields.
    for (const [id, nt] of newTables) {
        if (!inScope(id) || !alterable(id)) continue;
        const ot = oldTables.get(id);
        if (!ot) continue;
        const oldById = new Map(ot.fields.map(f => [f.id, f]));
        for (const nf of nt.fields) {
            const of = oldById.get(nf.id);
            if (!of || !isAlterPhysical(nf)) continue;
            if (!of.unique && nf.unique) {
                plan.push(
                    `CREATE UNIQUE INDEX IF NOT EXISTS ${qi(uniqueIndexName(nt.id, nf.id))} ` +
                    `ON ${qi(nt.key)} (${qi(nf.key)})`
                );
            } else if (of.unique && !nf.unique) {
                plan.push(`DROP INDEX IF EXISTS ${qi(uniqueIndexName(nt.id, nf.id))}`);
            }
        }
    }

    // 6. Dropped columns on surviving tables (drop unique index first).
    for (const [id, nt] of newTables) {
        if (!inScope(id) || !alterable(id)) continue;
        const ot = oldTables.get(id);
        if (!ot) continue;
        const newIds = new Set(nt.fields.map(f => f.id));
        for (const of of ot.fields) {
            if (newIds.has(of.id)) continue;
            // The mirror of step 4: a stored-computed column is physical, so
            // removing the field has to take the column with it or the column
            // outlives the only thing that explained it.
            if (isStoredComputed(of)) { plan.push(dropColumnDdl(nt.key, of.key, dialect)); continue; }
            if (!isAlterPhysical(of)) continue;
            if (of.unique) plan.push(`DROP INDEX IF EXISTS ${qi(uniqueIndexName(nt.id, of.id))}`);
            plan.push(dropColumnDdl(nt.key, of.key, dialect));
        }
    }

    // 7. Dropped tables (last, so nothing references them mid-plan). Alleen
    //    tabellen die een fysieke tabel HADDEN: een gekoppelde tabel die uit het
    //    model verdwijnt laat niets achter om te droppen, en een DROP op haar
    //    key zou de gelijknamige tabel van een andere soort kunnen raken.
    for (const [id, ot] of oldTables) {
        if (!inScope(id) || !isPhysical(ot)) continue;
        if (!newTables.has(id)) plan.push(`DROP TABLE IF EXISTS ${qi(ot.key)}`);
    }

    return plan;
}

// A minimal, non-throwing coercion used by migrationPlan so it can diff even a
// partly-shaped model (tables/fields arrays with id+key present). Unlike
// canonicalizeDataModel it doesn't invent ids — migration needs the caller's
// stable ids to be authoritative.
function coerceModelShape(model) {
    const src = isPlainObject(model) ? model : {};
    const tables = (Array.isArray(src.tables) ? src.tables : [])
        .filter(t => isPlainObject(t) && typeof t.id === 'string' && typeof t.key === 'string')
        .map(t => ({
            id: t.id,
            key: t.key,
            // `source` overleeft de coercie, anders ziet de planner elke tabel
            // als eigen opslag en is de vraag hierboven per definitie 'ja'.
            source: t.source ?? null,
            fields: (Array.isArray(t.fields) ? t.fields : [])
                .filter(f => isPlainObject(f) && typeof f.id === 'string' && typeof f.key === 'string'),
        }));
    return { tables };
}

module.exports = { migrationPlan };
