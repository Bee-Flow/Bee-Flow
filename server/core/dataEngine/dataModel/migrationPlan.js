/**
 * App Studio data model — migration planning: the ordered DDL that carries a
 * database from one model's physical schema to the next, diffed by stable id.
 */

'use strict';

const crypto = require('crypto');
const { isPlainObject } = require('./shared');
const { resolveDialect } = require('../engineFlag');
const { HttpError } = require('../../http/errors');
const {
    qi,
    pgType,
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
    const retain = retainOptions(opts, oldC, newC, dialect);
    if (retain) {
        const conflicts = conflictsOf(oldC, newC, retain, inScope);
        if (conflicts.length) {
            throw new HttpError(409, 'schema_retain_conflict',
                'The stage schema cannot keep its retired columns apart from this release', { findings: conflicts });
        }
    }

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

    // 1b. Retirements (retainRetired): relax the constraints and move the
    //     column aside BEFORE any rename or add, so a field that takes over
    //     the retired key in this same plan finds it free.
    if (retain) {
        for (const [id, nt] of newTables) {
            if (!inScope(id) || !alterable(id)) continue;
            const ot = oldTables.get(id);
            if (!ot) continue;
            const newIds = new Set(nt.fields.map(f => f.id));
            for (const of of ot.fields) if (!newIds.has(of.id)) plan.push(...retireDdl(nt, of));
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
            // A retired field coming back: its column never left the table.
            if (retain && retain.meta.has(nf.id) && retiredHadColumn(retain.meta.get(nf.id))) {
                plan.push(...unretireDdl(nt, nf, retain.meta.get(nf.id), newKeyById, dialect));
                continue;
            }
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

    // 6. Dropped columns on surviving tables (drop unique index first). Never
    //    under retainRetired: step 1b retired every one of them.
    for (const [id, nt] of newTables) {
        if (retain || !inScope(id) || !alterable(id)) continue;
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
        // Under retainRetired a table leaving the release is detached, never
        // dropped: a deploy must not destroy data a rollback brings back.
        if (retain || !inScope(id) || !isPhysical(ot)) continue;
        if (!newTables.has(id)) plan.push(`DROP TABLE IF EXISTS ${qi(ot.key)}`);
    }

    return plan;
}

// ---------------------------------------------------------------------------
// Retained columns (Solution stages, design 3.2 steps 2-4).
// ---------------------------------------------------------------------------

/** Postgres truncates identifiers past 63 bytes; a retired key never gets there. */
const MAX_IDENT = 63;
const RETIRED_PREFIX = '_r_';

/**
 * Where a retired field's column lives: `_r_<fieldId>`. A field key matches
 * vocabulary KEY_RE (it starts with a letter), so no live field can ever be
 * given this name, and it depends on the stable id alone. An id that is not a
 * plain identifier, or too long, is hashed.
 */
function retiredColumnKey(fieldId) {
    const id = String(fieldId);
    const plain = /^[a-z0-9_]+$/.test(id) && RETIRED_PREFIX.length + id.length <= MAX_IDENT;
    return RETIRED_PREFIX + (plain ? id : crypto.createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 40));
}

/** Does this field have a column in the table at all? */
function hasColumn(field) {
    return isAlterPhysical(field) || isStoredComputed(field);
}

function relationTableOf(field) {
    return field.type === 'relation' && isPlainObject(field.relation) && typeof field.relation.table === 'string'
        ? field.relation.table : null;
}

/**
 * The `retired_fields` entry a retirement leaves behind, so an unretire can put
 * the column back as it was:
 *   key           where the column lives now (retiredColumnKey), fieldKey the
 *                 key it had;
 *   type, columnType, stored, expr, relationTable
 *                 what the column IS, so a returning field of another type or
 *                 another relation target is a `schema.type_change`, never a
 *                 column silently kept in its old type;
 *   notNull, unique, fk
 *                 the constraints the retirement relaxed.
 *
 * `state` is the column's PHYSICAL state (readRetireState), and the caller
 * should always pass it: the descriptor cannot tell a required column created
 * NOT NULL by CREATE TABLE from one added nullable by ALTER (ddl.js
 * addColumnDdl omits NOT NULL), and an unretire that restores a NOT NULL the
 * column never had fails on rows that predate it. Without `state` the entry
 * falls back to what CREATE TABLE would have made (columnDef) and says so with
 * `verified: false`.
 */
function retireMetaFor(field, state) {
    const f = isPlainObject(field) ? field : {};
    const column = hasColumn(f);
    const stored = isStoredComputed(f);
    const relationTable = relationTableOf(f);
    const fkTarget = relationTable && f.relation.fk !== false ? relationTable : null;
    const ph = isPlainObject(state) ? state : null;
    const hasDefault = f.default !== undefined && f.default !== null;
    const guessNotNull = !!f.required && isAlterPhysical(f) && (f.type !== 'relation' || hasDefault);
    const guessUnique = !!f.unique && isAlterPhysical(f);
    return {
        id: f.id,
        key: column && typeof f.id === 'string' ? retiredColumnKey(f.id) : null,
        fieldKey: f.key,
        type: f.type,
        columnType: column ? pgType(f) : null,
        stored,
        expr: stored ? f.computed.expr : null,
        relationTable,
        notNull: isAlterPhysical(f) && (ph ? !!ph.notNull : guessNotNull),
        unique: isAlterPhysical(f) && (ph ? !!ph.unique : guessUnique),
        fk: fkTarget && (ph ? !!ph.fk : true) ? { table: fkTarget } : null,
        verified: !!ph,
    };
}

/**
 * The physical constraints of one live column, read before it retires:
 * `{notNull, unique, fk}`, or null when the column does not exist. `schema`
 * qualifies the names; without it they resolve through the search path.
 */
async function readRetireState(client, { tableKey, tableId, field, schema = null }) {
    const qualify = (name) => (schema ? `${qi(schema)}.${qi(name)}` : qi(name));
    const r = await client.query(
        `SELECT a.attnotnull AS not_null,
                EXISTS (SELECT 1 FROM pg_constraint c
                         WHERE c.contype = 'f' AND c.conrelid = a.attrelid AND a.attnum = ANY (c.conkey)) AS has_fk,
                to_regclass($3::text) IS NOT NULL AS has_unique
           FROM pg_attribute a
          WHERE a.attrelid = to_regclass($1::text) AND a.attname = $2 AND a.attnum > 0 AND NOT a.attisdropped`,
        [qualify(tableKey), field.key, qualify(uniqueIndexName(tableId, field.id))],
    );
    const row = r && Array.isArray(r.rows) ? r.rows[0] : null;
    if (!row) return null;
    return { notNull: !!row.not_null, unique: !!row.has_unique, fk: !!row.has_fk };
}

/** The option set a retaining plan works from, or null for the default plan. */
function retainOptions(opts, oldC, newC, dialect) {
    if (!opts.retainRetired) return null;
    // ALTER COLUMN and the pg_constraint lookup exist only in Postgres, and the
    // only caller (an org's datatables) is always Postgres.
    if (resolveDialect({ dialect }) !== 'pg') {
        throw new Error('migrationPlan: retainRetired is Postgres-only');
    }
    const retiredIds = new Set(opts.retiredFieldIds instanceof Set ? opts.retiredFieldIds : []);
    for (const t of newC.tables) for (const r of t.retired) retiredIds.add(r.id);
    const meta = new Map();
    for (const t of oldC.tables) for (const r of t.retired) meta.set(r.id, r);
    if (opts.retiredMeta instanceof Map) {
        for (const [id, m] of opts.retiredMeta) if (isPlainObject(m)) meta.set(id, { id, ...m });
    }
    // A field live in the new model is returning, whatever a stale
    // retired_fields entry or retiredFieldIds says: dropping its meta would
    // send it down the plain add path, an empty column beside its own data.
    for (const t of newC.tables) for (const fl of t.fields) retiredIds.delete(fl.id);
    // A field cannot be leaving and returning in the same plan.
    for (const id of retiredIds) meta.delete(id);
    return { retiredIds, meta };
}

/**
 * Why a retaining plan cannot be carried out, as blocking findings:
 *   schema.type_change          a returning field whose column type, stored
 *                               computed-ness or relation target differs from
 *                               the retired column (the planner emits no type
 *                               change, design 3.2 step 4);
 *   schema.retired_key_conflict a live field whose key is the key a retired
 *                               column still occupies (an entry recorded
 *                               before retiredColumnKey, or a hand-made one).
 */
function conflictsOf(oldC, newC, retain, inScope) {
    const findings = [];
    const oldTables = new Map(oldC.tables.map(t => [t.id, t]));
    for (const nt of newC.tables) {
        const ot = oldTables.get(nt.id);
        if (!ot || !inScope(nt.id) || !isPhysical(nt) || !isPhysical(ot)) continue;
        const oldIds = new Set(ot.fields.map(f => f.id));
        const liveIds = new Set(nt.fields.map(f => f.id));
        // Every column that stays retired after this plan, by the key it occupies.
        const occupied = new Map();
        for (const r of [...ot.retired, ...nt.retired]) {
            if (!liveIds.has(r.id) && typeof r.key === 'string' && r.key) occupied.set(r.key, r.id);
        }
        for (const nf of nt.fields) {
            const holder = occupied.get(nf.key);
            if (holder !== undefined && holder !== nf.id) {
                findings.push({ code: 'schema.retired_key_conflict', severity: 'blocking', tableId: nt.id, fieldId: nf.id, key: nf.key, retiredFieldId: holder });
            }
            const m = !oldIds.has(nf.id) ? retain.meta.get(nf.id) : null;
            const reason = m ? typeChange(m, nf) : null;
            if (reason) {
                findings.push({ code: 'schema.type_change', severity: 'blocking', tableId: nt.id, fieldId: nf.id, key: nf.key, reason });
            }
        }
    }
    return findings;
}

/**
 * Did the retired field leave a column behind? `columnType: null` is a
 * read-time computed field, which never had one, so a physical field returning
 * under its id is a plain add. An entry without `columnType` (or without
 * `key`: retiredMeta may carry only the constraints) predates the type record;
 * unretireDdl finds the column where retireDdl put it, and adds one if none.
 */
function retiredHadColumn(meta) {
    return meta.columnType !== null;
}

/** How a returning field differs from its retired column, or null. */
function typeChange(meta, field) {
    if (!hasColumn(field) || typeof meta.columnType !== 'string') return null; // no column, or a pre-type entry
    if (meta.columnType !== pgType(field)) return 'column_type';
    if (!!meta.stored !== isStoredComputed(field)) return 'stored_computed';
    const target = relationTableOf(field);
    if (meta.relationTable && target && meta.relationTable !== target) return 'relation_target';
    return null;
}

/** `retainConflicts(oldModel, newModel, opts)`: conflictsOf without throwing. */
function retainConflicts(oldModel, newModel, opts = {}) {
    const oldC = coerceModelShape(oldModel);
    const newC = coerceModelShape(newModel);
    const retain = retainOptions({ ...opts, retainRetired: true }, oldC, newC, opts.dialect || 'pg');
    const only = Array.isArray(opts.onlyTableIds) ? new Set(opts.onlyTableIds) : null;
    return conflictsOf(oldC, newC, retain, (id) => !only || only.has(id));
}

const sqlText = (v) => `'${String(v).replace(/'/g, "''")}'`;

/** Name of the FOREIGN KEY an unretire adds back, from stable ids. */
function retainedFkName(tableId, fieldId) {
    return `fk_${tableId}_${fieldId}`;
}

/** SQL that is true when `table` has a live column named `column`. */
function columnExists(tableKey, columnKey) {
    return `EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass(${sqlText(qi(tableKey))}) `
        + `AND attname = ${sqlText(columnKey)} AND attnum > 0 AND NOT attisdropped)`;
}

/**
 * Every FOREIGN KEY on `table.column`, dropped — found in pg_constraint, since
 * the inline REFERENCES of a CREATE TABLE got a name Postgres chose. to_regclass
 * and %I resolve through the migration's search_path (the scope's schema).
 */
function dropFkDdl(tableKey, columnKey) {
    return `DO $$ DECLARE c record; BEGIN `
        + `FOR c IN SELECT con.conname FROM pg_constraint con `
        + `JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey) `
        + `WHERE con.contype = 'f' AND con.conrelid = to_regclass(${sqlText(qi(tableKey))}) `
        + `AND a.attname = ${sqlText(columnKey)} LOOP `
        + `EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', ${sqlText(tableKey)}, c.conname); `
        + `END LOOP; END $$`;
}

/**
 * Retiring keeps the column but stops writing it, so every constraint that
 * makes an insert without it fail goes: the unique index, the FK and NOT NULL.
 * The column moves to retiredColumnKey first, so a field that takes over the
 * key gets a column of its own. Every statement is idempotent: the rename only
 * runs while the old name exists and the retired one does not, and the rest
 * address the retired name.
 */
function retireDdl(table, field) {
    if (!hasColumn(field)) return []; // a read-time computed field has no column
    const to = retiredColumnKey(field.id);
    const out = [];
    if (field.unique && isAlterPhysical(field)) out.push(`DROP INDEX IF EXISTS ${qi(uniqueIndexName(table.id, field.id))}`);
    out.push(
        `DO $$ BEGIN IF ${columnExists(table.key, field.key)} AND NOT ${columnExists(table.key, to)} THEN `
        + `ALTER TABLE ${qi(table.key)} RENAME COLUMN ${qi(field.key)} TO ${qi(to)}; END IF; END $$`
    );
    if (field.type === 'relation') out.push(dropFkDdl(table.key, to));
    if (field.required && isAlterPhysical(field)) out.push(`ALTER TABLE ${qi(table.key)} ALTER COLUMN ${qi(to)} DROP NOT NULL`);
    return out;
}

/**
 * A retired field coming back. The column is still there, so: put it back
 * under the field's key, then put back what the retirement took — but only
 * what the column really had AND the returning descriptor still asks for, so a
 * release that no longer declares a constraint never gets it re-added. A type
 * change never gets here (conflictsOf).
 *
 * The column is looked for where retireDdl actually put it,
 * retiredColumnKey(field.id), whatever the entry says: an entry carries a
 * `key` only when retireMetaFor wrote it, and a hand-made or legacy one may
 * name the field's own key. Only when that column is absent does the entry's
 * `key` count. Should neither exist, the column is added (nullable, as
 * addColumnDdl does), so the returning field never ends up without one.
 */
function unretireDdl(table, field, meta, newKeyById, dialect) {
    if (!hasColumn(field)) return [];
    const out = [];
    const stored = isStoredComputed(field);
    const aside = retiredColumnKey(field.id);
    const absent = `NOT ${columnExists(table.key, field.key)}`;
    const branches = [
        `IF ${columnExists(table.key, aside)} AND ${absent} THEN `
        + `ALTER TABLE ${qi(table.key)} RENAME COLUMN ${qi(aside)} TO ${qi(field.key)};`,
    ];
    if (typeof meta.key === 'string' && meta.key && meta.key !== field.key && meta.key !== aside) {
        branches.push(
            `ELSIF ${columnExists(table.key, meta.key)} AND ${absent} THEN `
            + `ALTER TABLE ${qi(table.key)} RENAME COLUMN ${qi(meta.key)} TO ${qi(field.key)};`
        );
    }
    if (!stored) {
        branches.push(`ELSIF ${absent} THEN ALTER TABLE ${qi(table.key)} ADD COLUMN ${qi(field.key)} ${pgType(field)};`);
    }
    out.push(`DO $$ BEGIN ${branches.join(' ')} END IF; END $$`);
    if (stored) {
        // A generated column carries its rule: one that changed while retired
        // is rebuilt, exactly like step 4b does for a live one. The add is
        // IF NOT EXISTS, so with the rule unchanged it only fills a column
        // that went missing.
        if (meta.expr !== field.computed.expr) out.push(dropColumnDdl(table.key, field.key, dialect));
        out.push(ddlForStoredComputedColumn(table.key, field, dialect));
        return out;
    }
    const want = retireMetaFor(field);
    if (meta.notNull && want.notNull) {
        out.push(`ALTER TABLE ${qi(table.key)} ALTER COLUMN ${qi(field.key)} SET NOT NULL`);
    }
    if (meta.unique && want.unique) {
        out.push(
            `CREATE UNIQUE INDEX IF NOT EXISTS ${qi(uniqueIndexName(table.id, field.id))} `
            + `ON ${qi(table.key)} (${qi(field.key)})`
        );
    }
    const targetKey = meta.fk && want.fk ? newKeyById.get(want.fk.table) : null;
    if (targetKey) {
        const name = retainedFkName(table.id, field.id);
        out.push(
            `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = ${sqlText(name)} `
            + `AND conrelid = to_regclass(${sqlText(qi(table.key))})) THEN `
            + `ALTER TABLE ${qi(table.key)} ADD CONSTRAINT ${qi(name)} `
            + `FOREIGN KEY (${qi(field.key)}) REFERENCES ${qi(targetKey)}(id); END IF; END $$`
        );
    }
    return out;
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
            // A stage table's retired columns (retainRetired). Ignored otherwise.
            retired: (Array.isArray(t.retired_fields) ? t.retired_fields : [])
                .filter(r => isPlainObject(r) && typeof r.id === 'string'),
        }));
    return { tables };
}

module.exports = { migrationPlan, retireMetaFor, retiredColumnKey, readRetireState, retainConflicts };
