/** @typedef {import('./queryCompiler').TableMeta} TableMeta */
/** @typedef {import('./queryCompiler').AccessFilter} AccessFilter */
// @typecheck
/**
 * The shared base of the SQL compilers, as one import.
 *
 * The code lives by concern: the primitives (limits, errors, quoting, the
 * field resolver, value binding, the page-size rule) in queryCompilerCore.js,
 * the filter tree (clauses, `{ any: [...] }` groups, `match`, search) in
 * queryCompilerFilter.mts. This module re-exports both under the names every
 * compiler and test already imports, so nothing that requires it changed.
 */
const core = require('./queryCompilerCore');
const { MATCH_MODES, compileWhere } = require('./queryCompilerFilter.mts');

/**
 * Build a WHERE clause combining the (validated) client filters with the RLS
 * access predicate; see compileWhere in queryCompilerFilter.mts.
 * @param {TableMeta} tableMeta
 * @param {Map<string, unknown>} fm
 * @param {unknown} filters
 * @param {AccessFilter} accessFilter
 * @param {string} dialect
 * @param {unknown} [match]
 * @param {unknown} [search]
 * @param {Record<string, { tableMeta: TableMeta, accessFilter: AccessFilter }>} [related]  for `<relation>.<column>` filters
 * @returns {{ where: string, params: unknown[] }}
 */
function buildWhere(tableMeta, fm, filters, accessFilter, dialect, match = 'all', search = null, related = undefined) {
    return compileWhere({ tableMeta, fm, filters, accessFilter, dialect, match, search, related });
}

module.exports = {
    MAX_FILTERS: core.MAX_FILTERS,
    MAX_RESULT_ROWS: core.MAX_RESULT_ROWS,
    DEFAULT_LIMIT: core.DEFAULT_LIMIT,
    MAX_KEY_INDEX_KEYS: core.MAX_KEY_INDEX_KEYS,
    MAX_GROUP_BY: core.MAX_GROUP_BY,
    MAX_AGGREGATES: core.MAX_AGGREGATES,
    ALIAS_RE: core.ALIAS_RE,
    CompileError: core.CompileError,
    RowsLockedError: core.RowsLockedError,
    assertRowsWritable: core.assertRowsWritable,
    qi: core.qi,
    assertTableMeta: core.assertTableMeta,
    fieldMap: core.fieldMap,
    resolveColumn: core.resolveColumn,
    scalar: core.scalar,
    coerceValue: core.coerceValue,
    assertRecordId: core.assertRecordId,
    assertAccessFilter: core.assertAccessFilter,
    MATCH_MODES,
    buildWhere,
    clampLimit: core.clampLimit,
};
