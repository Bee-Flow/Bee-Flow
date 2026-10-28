// @typecheck strict
/**
 * stores/lib/sqlBuilder.js (M6) — buildUpdate: the generalized dynamic UPDATE
 * builder behind userStore.dynamicUpdate and ~30 hand-rolled setClause blocks.
 *
 * [SEC] Column names come ONLY from the caller's hardcoded `columnMap` / `where`
 * literals — NEVER from `updates` keys. A key in `updates` that is not present
 * in `columnMap` is silently ignored, so untrusted input can never inject a
 * column name. Adopting buildUpdate at a site that previously derived columns
 * from arbitrary keys (importStore/mcpStore) is therefore a security fix.
 */

/**
 * Build a parameterized UPDATE.
 *
 * @param {{
 *   table: string, updates?: Record<string, unknown>, columnMap?: Record<string, ColumnSpec>,
 *   where?: Array<{ col: string, value: unknown }>, extraSet?: Array<string>, quoteCols?: boolean,
 *   returning?: string | null, startIdx?: number,
 * }} p
 *   table: Table name (a literal from the call site).
 *   updates: jsKey → value; only keys present in columnMap are used.
 *   columnMap: jsKey → 'db_col' | { col, cast?:'jsonb', transform?:(v)=>v }.
 *   where: AND-joined; cols are call-site literals.
 *   extraSet: verbatim SET fragments (e.g. 'updated_at = NOW()', 'version = version + 1'). Only appended when ≥1
 *     mapped column changed.
 *   quoteCols: double-quote SET/WHERE column identifiers (userStore family).
 *   returning: RETURNING clause body (e.g. '*'). startIdx: first placeholder index (default 1).
 * @returns {{ sql: string, params: unknown[] } | null}  null when no mapped column changed.
 */
function buildUpdate({ table, updates = {}, columnMap = {}, where = [], extraSet = [], quoteCols = false, returning = null, startIdx = 1 }) {
    /** @type {string[]} */
    const setParts = [];
    /** @type {unknown[]} */
    const params = [];
    let idx = startIdx;

    for (const [jsKey, spec] of Object.entries(columnMap)) {
        if (updates[jsKey] === undefined) continue;
        const isObj = spec && typeof spec === 'object';
        const col = isObj ? spec.col : spec;
        const cast = (isObj && spec.cast) ? `::${spec.cast}` : '';
        const transform = (isObj && spec.transform) ? spec.transform : null;
        const colToken = quoteCols ? `"${col}"` : col;
        setParts.push(`${colToken} = $${idx++}${cast}`);
        params.push(transform ? transform(updates[jsKey]) : updates[jsKey]);
    }

    // No real field changed → null (matches userStore.dynamicUpdate). extraSet
    // (e.g. updated_at bump / version increment) is only appended alongside an
    // actual data change, never on its own.
    if (setParts.length === 0) return null;

    for (const frag of extraSet) setParts.push(frag);

    /** @type {string[]} */
    const whereParts = [];
    for (const w of where) {
        const colToken = quoteCols ? `"${w.col}"` : w.col;
        whereParts.push(`${colToken} = $${idx++}`);
        params.push(w.value);
    }

    let sql = `UPDATE ${table} SET ${setParts.join(', ')}`;
    if (whereParts.length > 0) sql += ` WHERE ${whereParts.join(' AND ')}`;
    if (returning) sql += ` RETURNING ${returning}`;

    return { sql, params };
}

module.exports = { buildUpdate };

/** @typedef {string | { col: string, cast?: string, transform?: ((value: unknown) => unknown) | null }} ColumnSpec */
