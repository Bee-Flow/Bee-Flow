// @typecheck
/**
 * Retained columns (Solution stages, design 3.2 steps 2-4), for
 * ./migrationPlan.js: a field leaving a stage's release keeps its column,
 * moved aside under a retired key, and a field coming back gets it returned.
 * The statements (retireDdl / unretireDdl), the record a retirement leaves
 * (retireMetaFor / readRetireState), the plan options (retainOptions) and the
 * findings a database cannot carry out (conflictsOf / retainConflicts).
 */

'use strict';

const crypto = require('crypto');
const { isPlainObject } = require('./shared');
const { resolveDialect } = require('../engineFlag');
const {
    qi,
    pgType,
    isAlterPhysical,
    isStoredComputed,
    uniqueIndexName,
    ddlForStoredComputedColumn,
    dropColumnDdl,
} = require('./ddl');
const { isPhysical, coerceModelShape } = require('./migrationShape');
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
    /**
     * @param {string} name
     */
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

/**
 * @param {string} v
 */
const sqlText = (v) => `'${String(v).replace(/'/g, "''")}'`;

/** Name of the FOREIGN KEY an unretire adds back, from stable ids. */
function retainedFkName(tableId, fieldId) {
    return `fk_${tableId}_${fieldId}`;
}

/**
 * SQL that is true when `table` has a live column named `column`.
 * @param {string} tableKey
 * @param {string} columnKey
 */
function columnExists(tableKey, columnKey) {
    return `EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass(${sqlText(qi(tableKey))}) `
        + `AND attname = ${sqlText(columnKey)} AND attnum > 0 AND NOT attisdropped)`;
}

/**
 * Every FOREIGN KEY on `table.column`, dropped — found in pg_constraint, since
 * the inline REFERENCES of a CREATE TABLE got a name Postgres chose. to_regclass
 * and %I resolve through the migration's search_path (the scope's schema).
 * @param {string} tableKey
 * @param {string} columnKey
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
    /** @type {string[]} */
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
    /** @type {string[]} */
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

module.exports = {
    retireMetaFor, retiredColumnKey, readRetireState, retainConflicts,
    retainOptions, conflictsOf, retiredHadColumn, retireDdl, unretireDdl,
};

/** @typedef {import('./migrationShape').ModelField} ModelField */

/** @typedef {import('./migrationShape').RetiredEntry} RetiredEntry */

/** @typedef {import('./migrationShape').ModelShape} ModelShape */

/** @typedef {import('./migrationShape').MigrationPlanOpts} MigrationPlanOpts */
