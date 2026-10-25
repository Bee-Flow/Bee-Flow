// @typecheck
const { SYSTEM_COLUMNS } = require('./dataModel/vocabulary');
const { newRecordId } = require('./dataModel/ids');
const { resolveDialect } = require('./engineFlag');
const { CompileError, assertRowsWritable, qi, assertTableMeta, fieldMap, coerceValue, assertRecordId, assertAccessFilter } = require('./queryCompilerBase');

/**
 * INSERT a record. System columns are stamped from the server-supplied args
 * (createdBy/orgId) plus a fresh record id and timestamps — a client can NEVER
 * set id/created_at/updated_at/created_by/org_id (those keys are dropped).
 * Returns { sql, params, id, createdAt } (createdAt: the stamp written to
 * created_at and updated_at).
 * @param {*} tableMeta
 * @param {*} values
 * @param {import('./queryCompiler.types').WriteOpts} [opts]
 */
function compileInsert(tableMeta, values, {
    createdBy = null, orgId = null, dialect: dialectOpt, id: idOpt, allowLockedRows = false,
} = {}) {
    const dialect = resolveDialect({ dialect: dialectOpt });
    assertTableMeta(tableMeta);
    assertRowsWritable(tableMeta, { allowLockedRows });
    const fm = fieldMap(tableMeta);
    // `id` is a SERVER-ONLY option, never read from `values` (a client's
    // `values.id` is still dropped below with the other system columns). A
    // mirror of an external table stores its rows under the SOURCE's row id,
    // so a relation value there — the target's row id — IS the target row's
    // `id`, and a push event can address the row it is about.
    const id = idOpt === undefined ? newRecordId() : assertRecordId(idOpt);
    const now = new Date().toISOString();
    const cols = ['id', 'created_at', 'updated_at', 'created_by', 'org_id'];
    const params = [id, now, now, createdBy, orgId];

    const vals = (values && typeof values === 'object' && !Array.isArray(values)) ? values : {};
    for (const [k, v] of Object.entries(vals)) {
        if (SYSTEM_COLUMNS.includes(k)) continue; // clients cannot set system columns
        if (!fm.has(k)) throw new CompileError(`unknown field: ${k}`);
        const f = fm.get(k);
        if (f.type === 'computed') continue; // computed columns are derived, never written
        cols.push(f.key);
        params.push(coerceValue(v, f, dialect));
    }
    const sql = `INSERT INTO ${qi(tableMeta.key)} (${cols.map(qi).join(', ')}) `
        + `VALUES (${cols.map(() => '?').join(', ')})`;
    return { sql, params, id, createdAt: now };
}

/**
 * UPDATE a record by id, access-scoped. The WHERE is `id = ? AND (accessFilter)`
 * so a viewer updating a row they can't see changes 0 rows → the route answers
 * 404. updated_at is always bumped server-side; system columns are never
 * settable by the client.
 *
 * OPTIMISTIC CONCURRENCY (opt-in): pass `expectedUpdatedAt` — the updated_at
 * the caller read — and it is ANDed into the WHERE. A row someone else has
 * written since carries a different stamp, so the update matches 0 rows and the
 * caller can tell "gone/out of scope" from "changed under me" by re-reading.
 * updated_at is already server-stamped on every write and returned on every
 * read, so this needs NO new column and works identically in both dialects
 * (SQLite TEXT ISO, Postgres TIMESTAMPTZ — the ms-precision ISO string the
 * writer stamps round-trips exactly through both).
 *
 * Deliberately opt-in: action sequences (update_record steps) stay
 * last-write-wins because they are server-authoritative flows with no user
 * holding a stale copy; the record API + inline grid edits pass the token.
 * @param {*} tableMeta
 * @param {*} id
 * @param {*} values
 * @param {*} accessFilter
 * @param {import('./queryCompiler.types').WriteOpts} [opts]
 */
function compileUpdate(tableMeta, id, values, accessFilter, {
    expectedUpdatedAt = null, dialect: dialectOpt, allowLockedRows = false,
} = {}) {
    const dialect = resolveDialect({ dialect: dialectOpt });
    assertTableMeta(tableMeta);
    assertRowsWritable(tableMeta, { allowLockedRows });
    assertAccessFilter(accessFilter);
    if (typeof id !== 'string' || !id) throw new CompileError('record id is required');
    const fm = fieldMap(tableMeta);
    const vals = (values && typeof values === 'object' && !Array.isArray(values)) ? values : {};

    const sets = [`${qi('updated_at')} = ?`];
    const params = [new Date().toISOString()];
    for (const [k, v] of Object.entries(vals)) {
        if (SYSTEM_COLUMNS.includes(k)) continue; // system columns are server-owned
        if (!fm.has(k)) throw new CompileError(`unknown field: ${k}`);
        const f = fm.get(k);
        if (f.type === 'computed') continue;
        sets.push(`${qi(f.key)} = ?`);
        params.push(coerceValue(v, f, dialect));
    }

    const guard = [];
    const guardParams = [];
    if (expectedUpdatedAt !== null && expectedUpdatedAt !== undefined) {
        if (typeof expectedUpdatedAt !== 'string' || !expectedUpdatedAt) {
            throw new CompileError('expectedUpdatedAt must be a non-empty ISO timestamp string');
        }
        guard.push(` AND ${qi('updated_at')} = ?`);
        guardParams.push(expectedUpdatedAt);
    }

    const sql = `UPDATE ${qi(tableMeta.key)} SET ${sets.join(', ')} `
        + `WHERE ${qi('id')} = ? AND (${accessFilter.where})${guard.join('')}`;
    return { sql, params: [...params, id, ...accessFilter.params, ...guardParams], updatedAt: params[0] };
}

/**
 * DELETE a record by id, access-scoped. Same 0-rows-changed = 404 semantics as
 * update.
 */
function compileDelete(tableMeta, id, accessFilter, opts = {}) {
    resolveDialect(opts);
    assertTableMeta(tableMeta);
    assertRowsWritable(tableMeta, opts);
    assertAccessFilter(accessFilter);
    if (typeof id !== 'string' || !id) throw new CompileError('record id is required');
    return {
        sql: `DELETE FROM ${qi(tableMeta.key)} WHERE ${qi('id')} = ? AND (${accessFilter.where})`,
        params: [id, ...accessFilter.params],
    };
}

/**
 * INSERT … ON CONFLICT (<unique key column>) DO UPDATE — one statement, no
 * probe, no duplicate.
 *
 * `execDatatable`'s own `save_row` deliberately does NOT do this: it looks the
 * row up first, because an upsert compiled as INSERT-on-conflict needs a unique
 * index the AUTHOR may never have declared, and a missing one turns the
 * statement into a runtime error rather than an append. That reasoning does not
 * apply to a MANAGED table (dataModel/managedTables.js), whose column contract
 * declares the key unique — which is exactly why this exists here and is not
 * offered to the ordinary datatable step.
 *
 * So the unique declaration is CHECKED, not assumed: without it Postgres
 * answers "no unique or exclusion constraint matching the ON CONFLICT
 * specification", which is a 500 from inside somebody's nightly automation.
 *
 * THE ACCESS FILTER GUARDS THE UPDATE HALF. `ON CONFLICT … DO UPDATE … WHERE`
 * takes a predicate over the EXISTING row, so a row the caller may not write is
 * left exactly as it is (and, the insert having conflicted, nothing is written
 * at all). Without it this would be the one write on this path that can change
 * a row the caller could not have reached with compileUpdate — precisely the
 * hole `row_scope: 'own'` exists to close.
 *
 * Postgres only. SQLite spells the upsert differently enough that a
 * one-dialect-tested statement would be a guess, and the only storage this is
 * reachable from is a datatable, which is always Postgres.
 * @param {*} tableMeta
 * @param {string | number} keyFieldName
 * @param {*} values
 * @param {*} accessFilter
 * @param {import('./queryCompiler.types').WriteOpts} [opts]
 */
function compileUpsertByKey(tableMeta, keyFieldName, values, accessFilter, {
    createdBy = null, orgId = null, dialect: dialectOpt, allowLockedRows = false,
} = {}) {
    const dialect = resolveDialect({ dialect: dialectOpt });
    if (dialect !== 'pg') throw new CompileError('compileUpsertByKey is Postgres-only');
    assertTableMeta(tableMeta);
    assertRowsWritable(tableMeta, { allowLockedRows });
    assertAccessFilter(accessFilter);
    const fm = fieldMap(tableMeta);
    const keyField = fm.get(keyFieldName);
    if (!keyField) throw new CompileError(`unknown field: ${keyFieldName}`);
    if (keyField.unique !== true) {
        throw new CompileError(`compileUpsertByKey needs "${keyFieldName}" to be a unique column`);
    }
    const vals = (values && typeof values === 'object' && !Array.isArray(values)) ? values : {};
    if (vals[keyFieldName] === undefined || vals[keyFieldName] === null || vals[keyFieldName] === '') {
        throw new CompileError(`compileUpsertByKey requires a value for "${keyFieldName}"`);
    }

    const id = newRecordId();
    const now = new Date().toISOString();
    const cols = ['id', 'created_at', 'updated_at', 'created_by', 'org_id'];
    const params = [id, now, now, createdBy, orgId];
    // Only the caller's own columns are refreshed on a conflict. id,
    // created_at and created_by stay whatever the row already had: the row IS
    // the same answer, re-fetched, and rewriting its identity would break
    // anything keyed on it (and lie about who first stored it).
    const updates = [`${qi('updated_at')} = EXCLUDED.${qi('updated_at')}`];
    for (const [k, v] of Object.entries(vals)) {
        if (SYSTEM_COLUMNS.includes(k)) continue;
        if (!fm.has(k)) throw new CompileError(`unknown field: ${k}`);
        const f = fm.get(k);
        if (f.type === 'computed') continue;
        cols.push(f.key);
        params.push(coerceValue(v, f, dialect));
        // The conflict column itself is not re-assigned: it is what matched.
        if (f.key !== keyField.key) updates.push(`${qi(f.key)} = EXCLUDED.${qi(f.key)}`);
    }

    const sql = `INSERT INTO ${qi(tableMeta.key)} (${cols.map(qi).join(', ')}) `
        + `VALUES (${cols.map(() => '?').join(', ')}) `
        + `ON CONFLICT (${qi(keyField.key)}) DO UPDATE SET ${updates.join(', ')} `
        + `WHERE ${accessFilter.where}`;
    return { sql, params: [...params, ...accessFilter.params], id };
}

/**
 * INSERT … ON CONFLICT ("id") DO UPDATE — the write a MIRROR of an external
 * table makes for every row it fetches, keyed on the id it already knows.
 *
 * Unlike compileUpsertByKey there is no unique-column question: `id` is the
 * primary key of every table. What IS different is the second half of the
 * WHERE. `(cols) IS DISTINCT FROM (EXCLUDED.cols)` makes an UNCHANGED row a
 * no-op — `updated_at` stays what it was. Without that guard every scheduled
 * pass would stamp every row, and every editor holding an `expectedUpdatedAt`
 * from a minute ago would be told a colleague changed the row (row_conflict)
 * when nobody did. It is also what lets a push event's patch and our own
 * write-through's echo of the same row land twice without a second version
 * bump. With no data columns at all the guard is `1=0`: nothing to change.
 *
 * The access filter guards the update half exactly as in compileUpsertByKey.
 * Postgres only, for the same reason.
 * @param {*} tableMeta
 * @param {*} id
 * @param {*} values
 * @param {*} accessFilter
 * @param {import('./queryCompiler.types').WriteOpts} [opts]
 */
function compileUpsertById(tableMeta, id, values, accessFilter, {
    createdBy = null, orgId = null, dialect: dialectOpt, allowLockedRows = false,
} = {}) {
    const dialect = resolveDialect({ dialect: dialectOpt });
    if (dialect !== 'pg') throw new CompileError('compileUpsertById is Postgres-only');
    assertTableMeta(tableMeta);
    assertRowsWritable(tableMeta, { allowLockedRows });
    assertAccessFilter(accessFilter);
    assertRecordId(id);
    const fm = fieldMap(tableMeta);
    const vals = (values && typeof values === 'object' && !Array.isArray(values)) ? values : {};

    const now = new Date().toISOString();
    const cols = ['id', 'created_at', 'updated_at', 'created_by', 'org_id'];
    const params = [id, now, now, createdBy, orgId];
    const updates = [`${qi('updated_at')} = EXCLUDED.${qi('updated_at')}`];
    const dataCols = [];
    for (const [k, v] of Object.entries(vals)) {
        if (SYSTEM_COLUMNS.includes(k)) continue;
        if (!fm.has(k)) throw new CompileError(`unknown field: ${k}`);
        const f = fm.get(k);
        if (f.type === 'computed') continue;
        cols.push(f.key);
        dataCols.push(f.key);
        params.push(coerceValue(v, f, dialect));
        updates.push(`${qi(f.key)} = EXCLUDED.${qi(f.key)}`);
    }
    // The EXISTING row's columns are qualified with the table name: inside
    // ON CONFLICT DO UPDATE a bare column name is ambiguous between the table
    // and EXCLUDED, and Postgres says so (42702) rather than guessing.
    const t = qi(tableMeta.key);
    const changed = dataCols.length
        ? `(${dataCols.map(c => `${t}.${qi(c)}`).join(', ')}) IS DISTINCT FROM (${dataCols.map(c => `EXCLUDED.${qi(c)}`).join(', ')})`
        : '1=0';

    const sql = `INSERT INTO ${qi(tableMeta.key)} (${cols.map(qi).join(', ')}) `
        + `VALUES (${cols.map(() => '?').join(', ')}) `
        + `ON CONFLICT (${qi('id')}) DO UPDATE SET ${updates.join(', ')} `
        + `WHERE (${accessFilter.where}) AND ${changed}`;
    return { sql, params: [...params, ...accessFilter.params] };
}

module.exports = { compileInsert, compileUpdate, compileDelete, compileUpsertByKey, compileUpsertById };
