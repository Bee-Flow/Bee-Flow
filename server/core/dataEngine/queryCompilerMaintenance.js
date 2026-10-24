// @typecheck
const { resolveDialect } = require('./engineFlag');
const { CompileError, assertRowsWritable, qi, assertTableMeta, resolveColumn, assertAccessFilter, clampLimit } = require('./queryCompilerBase');

/**
 * Every id a scope can see — the snapshot a mirror takes BEFORE it fetches, so
 * that "rows the source no longer has" is computed against what existed when
 * the pass began and never against rows written while it ran.
 *
 * No LIMIT: the only caller is the mirror engine, whose tables are bounded by
 * its own row cap (far below MAX_ROWS_PER_TABLE), and a partial snapshot would
 * be worse than none — every id it missed would be swept as "gone".
 */
function compileIdList(tableMeta, accessFilter, opts = {}) {
    resolveDialect(opts);
    assertTableMeta(tableMeta);
    assertAccessFilter(accessFilter);
    return {
        sql: `SELECT ${qi('id')} FROM ${qi(tableMeta.key)} WHERE ${accessFilter.where}`,
        params: [...accessFilter.params],
    };
}

/**
 * (id, value) for ONE column over the whole table, NULLs left out — the index
 * a mirror builds over its RELATION TARGET to turn "the row whose <column>
 * equals this value" into a row id, and the (id → label) map it fills a
 * relation's label column from. The whole-table twin of compileKeyIndex; the
 * same row-cap argument as compileIdList is what bounds it.
 */
function compileKeyValues(tableMeta, fieldName, accessFilter, opts = {}) {
    resolveDialect(opts);
    assertTableMeta(tableMeta);
    assertAccessFilter(accessFilter);
    const column = resolveColumn(tableMeta, fieldName);
    return {
        sql: `SELECT ${qi('id')} AS ${qi('id')}, ${column} AS ${qi('k')} FROM ${qi(tableMeta.key)} `
            + `WHERE (${accessFilter.where}) AND ${column} IS NOT NULL`,
        params: [...accessFilter.params],
    };
}

/**
 * DELETE every row a scope can see. Only 'replace'-mode connector syncs use
 * this: a source with no stable per-row identity can only be refreshed by
 * emptying the table and refilling it. Access-scoped, so it can never delete
 * beyond what the caller may already see.
 */
function compileDeleteAll(tableMeta, accessFilter, opts = {}) {
    resolveDialect(opts);
    assertTableMeta(tableMeta);
    assertRowsWritable(tableMeta, opts);
    assertAccessFilter(accessFilter);
    return {
        sql: `DELETE FROM ${qi(tableMeta.key)} WHERE ${accessFilter.where}`,
        params: [...accessFilter.params],
    };
}

/**
 * "Rows of this table older than the cutoff" — the predicate itself.
 *
 * ONE definition, shared by the DELETE below and by the SELECT that finds the
 * ids it is about to remove. Two hand-written copies would be two places to
 * forget the NOT NULL guard, and the copy that forgot it would silently eat
 * every undated row in the table.
 */
function olderThanWhere(tableMeta, accessFilter, { field, cutoffIso }) {
    assertTableMeta(tableMeta);
    assertAccessFilter(accessFilter);
    const column = resolveColumn(tableMeta, field);
    if (typeof cutoffIso !== 'string' || !cutoffIso) {
        throw new CompileError('retention cutoff must be an ISO timestamp');
    }
    // NOT NULL guard: a row with no timestamp has no age, and deleting it
    // would silently eat data the connector never dated.
    return {
        column,
        where: `${accessFilter.where} AND ${column} IS NOT NULL AND ${column} < ?`,
        params: [...accessFilter.params, cutoffIso],
    };
}

/**
 * Delete rows whose timestamp column is older than a cutoff.
 *
 * Backs a connector's `retentionDays`. Ingesting mail copies customer personal
 * data into the app's database, and an unbounded copy is not defensible — so
 * the retention setting has to actually delete something. The column goes
 * through resolveColumn, so an unknown or unstored field is a CompileError
 * rather than an injection point.
 */
function compileDeleteOlderThan(tableMeta, accessFilter, { field, cutoffIso, dialect: dialectOpt, allowLockedRows = false }) {
    resolveDialect({ dialect: dialectOpt });
    assertTableMeta(tableMeta);
    assertRowsWritable(tableMeta, { allowLockedRows });
    const { where, params } = olderThanWhere(tableMeta, accessFilter, { field, cutoffIso });
    return {
        sql: `DELETE FROM ${qi(tableMeta.key)} WHERE ${where}`,
        params,
        // Handed back so a caller can SELECT exactly the rows this is about to
        // delete (the file blobs they point at have to be collected first).
        // Returned rather than rebuilt by the caller so there is one definition
        // of "doomed", not two that can drift.
        where,
        whereParams: params,
    };
}

/**
 * The ids of the rows compileDeleteOlderThan would delete, OLDEST FIRST and
 * capped.
 *
 * Postgres has no `DELETE … LIMIT`, so a retention sweep that must not
 * monopolise one pass has to name the rows before it removes them. Oldest
 * first is not cosmetic: with a per-pass cap, an arbitrary slice would let the
 * same middle of a large backlog be re-read for ever while the genuinely
 * expired head never drains.
 *
 * Only `id` is selected. A retention pass has no business reading the personal
 * data it is about to delete, and the rows it names go straight back into
 * compileDelete.
 */
function compileSelectOlderThan(tableMeta, accessFilter, { field, cutoffIso, limit, dialect: dialectOpt }) {
    resolveDialect({ dialect: dialectOpt });
    const { column, where, params } = olderThanWhere(tableMeta, accessFilter, { field, cutoffIso });
    return {
        sql: `SELECT ${qi('id')} FROM ${qi(tableMeta.key)} WHERE ${where} `
            + `ORDER BY ${column} ASC, ${qi('id')} ASC LIMIT ?`,
        params: [...params, clampLimit(limit)],
    };
}

/**
 * Delete child rows whose parent record is gone.
 *
 * This is how retention reaches a child table that carries no date of its own.
 * An email attachment has no timestamp — its age IS its message's age — so the
 * only honest rule is "when the message goes, the attachment goes". Run after
 * the parent purge, this turns the parent's cutoff into the child's.
 *
 * A NULL relation is swept too — but only for connector-WRITTEN children
 * (`sweepNull` true, the default): the sync always stamps the parent id, so a
 * NULL one is a row whose parent was never written. Left alone it would sit in
 * a table with a stated retention policy and never age out.
 *
 * Dependents are the opposite case: the connector never writes them, the app's
 * users do, and relation columns are always created nullable — so a row whose
 * relation is (still) empty is legitimate user data with no parent to inherit
 * an age from. Callers pass `sweepNull: false` there, and only rows that point
 * AT a vanished parent are collected.
 */
function compileDeleteOrphans(tableMeta, accessFilter, {
    relationField, parentTableMeta, sweepNull = true, dialect: dialectOpt, allowLockedRows = false,
}) {
    resolveDialect({ dialect: dialectOpt });
    assertTableMeta(tableMeta);
    assertRowsWritable(tableMeta, { allowLockedRows });
    assertTableMeta(parentTableMeta);
    assertAccessFilter(accessFilter);
    const column = resolveColumn(tableMeta, relationField);
    const orphanTest = sweepNull
        ? `(${column} IS NULL OR ${column} NOT IN (SELECT "id" FROM ${qi(parentTableMeta.key)}))`
        : `(${column} IS NOT NULL AND ${column} NOT IN (SELECT "id" FROM ${qi(parentTableMeta.key)}))`;
    const where = `${accessFilter.where} AND ${orphanTest}`;
    return {
        sql: `DELETE FROM ${qi(tableMeta.key)} WHERE ${where}`,
        params: [...accessFilter.params],
        where,
        whereParams: [...accessFilter.params],
    };
}

module.exports = { compileIdList, compileKeyValues, compileDeleteAll, compileDeleteOlderThan, compileSelectOlderThan, compileDeleteOrphans };
