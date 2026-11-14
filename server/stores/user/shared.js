// @typecheck strict
// Shared user-store helpers: the dynamic-UPDATE builder and tolerant JSON
// parsing. `parseJSON` is re-exported so the eight user-store modules that
// already import it from here keep one import line.
const { parseJSONObject: parseJSON } = require('../lib/json');
const { buildUpdate } = require('../lib/sqlBuilder');

// ── Dynamic UPDATE helper ─────────────────────────────
// PG has no COALESCE(?, col) trick so we build SET clauses dynamically.
// The eight user-store modules call this by its own name; the building itself
// is stores/lib/sqlBuilder.js, which this signature was the blueprint for.
/**
 * @param {string} table
 * @param {string} id
 * @param {Record<string, unknown>} updates
 * @param {Record<string, import('../lib/sqlBuilder').ColumnSpec>} columnMapping
 * @param {string} [whereCol]
 */
function dynamicUpdate(table, id, updates, columnMapping, whereCol = 'id') {
    return buildUpdate({
        table,
        updates,
        columnMap: columnMapping,
        where: [{ col: whereCol, value: id }],
        quoteCols: true,
    });
}


/**
 * A literal for a LIKE pattern: `_` and `%` in an org id are wildcards unless
 * escaped, and org ids are slugs, so `org_acme_%` also matched `org_acme-corp_…`.
 * @param {string} text
 * @returns {string}
 */
function escapeLike(text) {
    return String(text).replace(/[\\%_]/g, '\\$&');
}

module.exports = { dynamicUpdate, parseJSON, escapeLike };
