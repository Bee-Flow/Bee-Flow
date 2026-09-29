// @typecheck
// Shared user-store helpers: the dynamic-UPDATE builder and tolerant JSON
// parsing. `parseJSON` is re-exported so the eight user-store modules that
// already import it from here keep one import line.
const { parseJSONObject: parseJSON } = require('../lib/json');
const { buildUpdate } = require('../lib/sqlBuilder');

// ── Dynamic UPDATE helper ─────────────────────────────
// PG has no COALESCE(?, col) trick so we build SET clauses dynamically.
// The eight user-store modules call this by its own name; the building itself
// is stores/lib/sqlBuilder.js, which this signature was the blueprint for.
function dynamicUpdate(table, id, updates, columnMapping, whereCol = 'id') {
    return buildUpdate({
        table,
        updates,
        columnMap: columnMapping,
        where: [{ col: whereCol, value: id }],
        quoteCols: true,
    });
}


module.exports = { dynamicUpdate, parseJSON };
