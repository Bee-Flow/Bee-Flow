// @typecheck
'use strict';
/**
 * Column lookup shared by the planner (design time) and the engine (run time),
 * so a name resolves identically in both places.
 */

const { str } = require('./constants');

const fold = (v) => String(v ?? '').normalize('NFKC').trim().toLowerCase();

/**
 * Find a column by name: exact key or label, then case-insensitive on trimmed
 * text, then each alternative (case-insensitive). Returns the column or null.
 * @param {{ key: string, label?: string }[]} columns
 * @param {string} name
 * @param {string[]} [alternatives]
 */
function resolveColumn(columns, name, alternatives = []) {
    if (!Array.isArray(columns)) return null;
    const wanted = str(name);
    if (wanted) {
        const exact = columns.find((c) => c.key === wanted || c.label === wanted);
        if (exact) return exact;
        const f = fold(wanted);
        const ci = columns.find((c) => fold(c.key) === f || fold(c.label) === f);
        if (ci) return ci;
    }
    for (const alt of Array.isArray(alternatives) ? alternatives : []) {
        const a = fold(alt);
        if (!a) continue;
        const hit = columns.find((c) => fold(c.key) === a || fold(c.label) === a);
        if (hit) return hit;
    }
    return null;
}

/** `base`, or `base (2)`, `base (3)` ... the first that is not in `taken` (a Set of keys). */
function uniqueKey(base, taken) {
    const root = String(base || 'Column');
    if (!taken.has(root)) return root;
    for (let i = 2; ; i++) {
        const k = `${root} (${i})`;
        if (!taken.has(k)) return k;
    }
}

/** A new column; `type` defaults to 'mixed'. */
const makeColumn = (key, type = 'mixed', label = key) => ({ key, label, type });

module.exports = { resolveColumn, uniqueKey, makeColumn, fold };
