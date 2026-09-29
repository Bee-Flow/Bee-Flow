/**
 * App Studio data model — the DDL surface: the per-dialect column-type mapping,
 * the quoting/literal helpers, CREATE TABLE for one table and the ALTER
 * fragments a migration is built from.
 */

'use strict';

// SQL dialect for the emitted DDL (engineFlag requires nothing → no cycle).
// sqlite stays byte-identical to before; 'pg' switches the column types, the
// system-column types, bool literals and ADD COLUMN IF NOT EXISTS — see
// columnType()/sqlLiteral()/ddlForTable()/addColumnDdl().
const { resolveDialect } = require('../engineFlag');
// The only author-written SQL in the model: a stored computed expression.
const { computedExprFor } = require('../computedDialect');

// ---------------------------------------------------------------------------
// SQLite type mapping
// ---------------------------------------------------------------------------

/**
 * Map a field to its SQLite column affinity.
 *   text/richtext → TEXT
 *   number        → INTEGER (subtype 'integer') else REAL
 *   date/datetime → TEXT (ISO-8601 strings)
 *   bool          → INTEGER (0/1)
 *   select        → TEXT
 *   multiselect   → TEXT (JSON array)
 *   relation      → TEXT (the referenced record id)
 *   file          → TEXT (JSON descriptor(s))
 *   computed      → the declared result affinity (computed.type), default TEXT
 */
function sqliteType(field) {
    switch (field.type) {
        case 'number':
            return field.subtype === 'integer' ? 'INTEGER' : 'REAL';
        case 'bool':
            return 'INTEGER';
        case 'computed': {
            const rt = field.computed && field.computed.type;
            if (rt === 'number') return 'REAL';
            if (rt === 'integer') return 'INTEGER';
            return 'TEXT';
        }
        // text, richtext, date, datetime, select, multiselect, relation, file
        default:
            return 'TEXT';
    }
}

/**
 * Map a field to its Postgres column type (the 'pg' dialect analog of
 * sqliteType — same field vocabulary, real PG types):
 *   text/richtext/select/relation → TEXT
 *   number                        → NUMERIC (subtype 'integer' → BIGINT)
 *   date                          → DATE
 *   datetime                      → TIMESTAMPTZ
 *   bool                          → BOOLEAN
 *   multiselect/file              → TEXT holding JSON (deliberately NOT jsonb —
 *                                   the wire format and the compiler treat these
 *                                   as opaque JSON text in both dialects)
 *   computed                      → declared result type (computed.type),
 *                                   default TEXT
 */
function pgType(field) {
    switch (field.type) {
        case 'number':
            return field.subtype === 'integer' ? 'BIGINT' : 'NUMERIC';
        case 'bool':
            return 'BOOLEAN';
        case 'date':
            return 'DATE';
        case 'datetime':
            return 'TIMESTAMPTZ';
        case 'computed': {
            const rt = field.computed && field.computed.type;
            if (rt === 'number') return 'NUMERIC';
            if (rt === 'integer') return 'BIGINT';
            return 'TEXT';
        }
        // text, richtext, select, multiselect, relation, file
        default:
            return 'TEXT';
    }
}

/** The active dialect's column type for a field. */
function columnType(field, dialect) {
    return resolveDialect({ dialect }) === 'pg' ? pgType(field) : sqliteType(field);
}

// A field's expression can only be materialised as a physical STORED column at
// CREATE-TABLE time (see security note). read-time computed fields have no
// column at all.
function isStoredComputed(field) {
    return field.type === 'computed' && field.computed && field.computed.stored === true;
}

// Does this field get a real column when its table is CREATEd?
function isCreatePhysical(field) {
    if (field.type === 'computed') return isStoredComputed(field);
    return true;
}

// Is this field eligible for ADD/DROP COLUMN during a migration? All physical
// fields except computed — a stored-computed only materialises at table create,
// and a read-time computed is never physical.
function isAlterPhysical(field) {
    return field.type !== 'computed';
}

// ---------------------------------------------------------------------------
// DDL helpers
// ---------------------------------------------------------------------------

function qi(name) {
    return '"' + String(name).replace(/"/g, '""') + '"';
}

/** Render a scalar default as a safe SQL literal. */
function sqlLiteral(value, field, dialect) {
    if (value === null || value === undefined) return 'NULL';
    // pg BOOLEAN columns refuse integer defaults, so bools render as TRUE/FALSE
    // there; sqlite keeps 0/1 (it has no boolean literal storage class).
    const [T, F] = resolveDialect({ dialect }) === 'pg' ? ['TRUE', 'FALSE'] : ['1', '0'];
    if (field && (field.type === 'number' || field.type === 'computed')) {
        const n = Number(value);
        return Number.isFinite(n) ? String(n) : 'NULL';
    }
    if (field && field.type === 'bool') return value ? T : F;
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
    if (typeof value === 'boolean') return value ? T : F;
    return `'${String(value).replace(/'/g, "''")}'`;
}

// Deterministic, rename-proof unique-index name from stable ids.
function uniqueIndexName(tableId, fieldId) {
    return `uq_${tableId}_${fieldId}`;
}

// The two indexes that follow from HOW every table is read, rather than from
// anything its author declared. Named off the stable table id, so a rename does
// not orphan them and a replay finds them already there.
function recentIndexName(tableId) {
    return `ix_${tableId}_recent`;
}
function ownerIndexName(tableId) {
    return `ix_${tableId}_owner`;
}

/**
 * Column definition fragment for a CREATE TABLE (no leading comma).
 * Includes inline FK for same-db relations when `tableKeyById` resolves the
 * target. UNIQUE is intentionally NOT inlined — see uniqueIndexName.
 *
 * `relation.fk === false` opts a relation OUT of the FOREIGN KEY (here and in
 * addColumnDdl): a relation whose truth lives outside Postgres — a mirror of a
 * Nextcloud table pointing at the mirror of another — cannot be enforced by
 * Postgres. The source does not enforce it either, its rows may legitimately
 * dangle, and a parent row deleted upstream before its children are re-read
 * would otherwise fail the very refresh that is trying to catch up.
 */
function columnDef(field, tableKeyById, dialect) {
    const parts = [qi(field.key), columnType(field, dialect)];

    if (isStoredComputed(field)) {
        // The one place author-written SQL reaches the database. Templates
        // author the SQLite form; computedDialect translates the known idioms
        // on the way to Postgres (see that module for why this is not a
        // per-dialect authoring choice).
        parts.push(`GENERATED ALWAYS AS (${computedExprFor(field.computed.expr, resolveDialect({ dialect }))}) STORED`);
        return parts.join(' ');
    }

    if (field.type === 'relation' && field.relation && field.relation.fk !== false && tableKeyById) {
        const targetKey = tableKeyById.get(field.relation.table);
        if (targetKey) parts.push(`REFERENCES ${qi(targetKey)}(id)`);
    }

    if (field.required && field.default !== undefined && field.default !== null) {
        parts.push(`NOT NULL DEFAULT ${sqlLiteral(field.default, field, dialect)}`);
    } else if (field.default !== undefined && field.default !== null) {
        parts.push(`DEFAULT ${sqlLiteral(field.default, field, dialect)}`);
    } else if (field.required && field.type !== 'relation') {
        // A required column with no default can still be NOT NULL at create
        // time (inserts must supply it). Relations stay nullable (FK + NOT NULL
        // + no default is contradictory for ALTER parity).
        parts.push('NOT NULL');
    }
    return parts.join(' ');
}

/**
 * Build the CREATE TABLE (+ unique indexes) script for one table. Returns a
 * single semicolon-joined string suitable for better-sqlite3 `db.exec`.
 *
 * Two indexes come from how the table is READ rather than from what its author
 * declared, so nothing surfaces them in the designer:
 *   • (created_at DESC, id DESC) — the default list order AND the keyset
 *     pagination tiebreak, on EVERY table. Without it a 100k-row table sorts
 *     its whole contents to answer "the 50 most recent".
 *   • (created_by, created_at DESC) — only when `ctx.rowScope === 'own'`, where
 *     the access filter ANDs `created_by = ?` into every single statement.
 * Both are CREATE INDEX IF NOT EXISTS, so re-emitting them on an existing table
 * (a schema save, the repair button) is a no-op.
 *
 * @param {object} table
 * @param {{ tableKeyById?: Map<string,string>, rowScope?: 'all'|'own' }} [ctx]
 *   id→key map so same-db relations resolve to a real FOREIGN KEY (omit for a
 *   standalone, FK-less table), plus the table's row scope.
 */
function ddlForTable(table, ctx = {}) {
    const dialect = resolveDialect(ctx);
    const tableKeyById = ctx.tableKeyById || null;
    // System columns per dialect. Same five names/order in both; pg gives the
    // timestamps a real type (the compiler binds ISO strings, PG casts them).
    const cols = dialect === 'pg'
        ? [
            'id TEXT PRIMARY KEY',
            'created_at TIMESTAMPTZ',
            'updated_at TIMESTAMPTZ',
            'created_by TEXT',
            'org_id TEXT',
        ]
        : [
            'id TEXT PRIMARY KEY',
            'created_at TEXT',
            'updated_at TEXT',
            'created_by TEXT',
            'org_id TEXT',
        ];
    const physical = (table.fields || []).filter(isCreatePhysical);
    for (const f of physical) cols.push(columnDef(f, tableKeyById, dialect));

    const stmts = [`CREATE TABLE IF NOT EXISTS ${qi(table.key)} (\n  ${cols.join(',\n  ')}\n)`];

    stmts.push(
        `CREATE INDEX IF NOT EXISTS ${qi(recentIndexName(table.id))} `
        + `ON ${qi(table.key)} ("created_at" DESC, "id" DESC)`,
    );
    if (ctx.rowScope === 'own') {
        stmts.push(
            `CREATE INDEX IF NOT EXISTS ${qi(ownerIndexName(table.id))} `
            + `ON ${qi(table.key)} ("created_by", "created_at" DESC)`,
        );
    }

    for (const f of (table.fields || [])) {
        if (f.unique && isAlterPhysical(f)) {
            stmts.push(
                `CREATE UNIQUE INDEX IF NOT EXISTS ${qi(uniqueIndexName(table.id, f.id))} ` +
                `ON ${qi(table.key)} (${qi(f.key)})`
            );
        }
    }
    return stmts.join(';\n') + ';';
}

/**
 * DDL statements to add one field to an existing table. Returns an array
 * because a unique field needs a follow-up CREATE UNIQUE INDEX (SQLite ADD
 * COLUMN can't carry UNIQUE inline).
 */
// ADD COLUMN for a stored-computed field — the migration-time twin of the
// GENERATED ALWAYS branch in ddlForTable, sharing the same dialect translation
// so a column added later cannot mean something different from the same field
// created up front.
function ddlForStoredComputedColumn(tableKey, field, dialectOpt) {
    const dialect = resolveDialect({ dialect: dialectOpt });
    const addClause = dialect === 'pg' ? 'ADD COLUMN IF NOT EXISTS' : 'ADD COLUMN';
    return `ALTER TABLE ${qi(tableKey)} ${addClause} ${qi(field.key)} ${columnType(field, dialect)} `
        + `GENERATED ALWAYS AS (${computedExprFor(field.computed.expr, dialect)}) STORED`;
}

/**
 * DROP for a physical column.
 *
 * `IF EXISTS` on pg because the column may legitimately be absent: a
 * stored-computed field added before this file emitted DDL for one exists in
 * the model and nowhere else, and a plan that dies on it can never repair
 * itself. SQLite has no such clause, so it keeps the bare form — which is also
 * what the migration tests pin.
 */
function dropColumnDdl(tableKey, key, dialect) {
    const dropClause = resolveDialect({ dialect }) === 'pg' ? 'DROP COLUMN IF EXISTS' : 'DROP COLUMN';
    return `ALTER TABLE ${qi(tableKey)} ${dropClause} ${qi(key)}`;
}

function addColumnDdl(tableKey, tableId, field, tableKeyById, dialectOpt) {
    const dialect = resolveDialect({ dialect: dialectOpt });
    if (!isAlterPhysical(field)) return []; // computed → read-time, no column
    // pg has native ADD COLUMN IF NOT EXISTS, so a replayed plan is a no-op
    // there without the tolerant-executor's duplicate-column parsing.
    const addClause = dialect === 'pg' ? 'ADD COLUMN IF NOT EXISTS' : 'ADD COLUMN';
    const parts = [`ALTER TABLE ${qi(tableKey)} ${addClause} ${qi(field.key)} ${columnType(field, dialect)}`];

    if (field.type === 'relation' && field.relation && field.relation.fk !== false && tableKeyById) {
        const targetKey = tableKeyById.get(field.relation.table);
        // ADD COLUMN … REFERENCES is allowed only with a NULL default, so a
        // relation column is always added nullable (requiredness is app-level).
        if (targetKey) parts.push(`REFERENCES ${qi(targetKey)}(id)`);
    } else if (field.required && field.default !== undefined && field.default !== null) {
        parts.push(`NOT NULL DEFAULT ${sqlLiteral(field.default, field, dialect)}`);
    } else if (field.default !== undefined && field.default !== null) {
        parts.push(`DEFAULT ${sqlLiteral(field.default, field, dialect)}`);
    }
    // NOTE: a NOT NULL column with no default cannot be added to a populated
    // table in SQLite, so we deliberately omit NOT NULL on the add path.

    const out = [parts.join(' ')];
    if (field.unique) {
        out.push(
            `CREATE UNIQUE INDEX IF NOT EXISTS ${qi(uniqueIndexName(tableId, field.id))} ` +
            `ON ${qi(tableKey)} (${qi(field.key)})`
        );
    }
    return out;
}

module.exports = {
    sqliteType,
    pgType,
    columnType,
    isStoredComputed,
    isCreatePhysical,
    isAlterPhysical,
    qi,
    sqlLiteral,
    uniqueIndexName,
    recentIndexName,
    ownerIndexName,
    columnDef,
    ddlForTable,
    ddlForStoredComputedColumn,
    dropColumnDdl,
    addColumnDdl,
};
