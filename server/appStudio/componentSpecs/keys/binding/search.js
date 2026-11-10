// @typecheck strict
'use strict';

/**
 * `search` on a record or records binding: a free text looked for in some columns. The query
 * compiler has always read it on a read request (one group of LIKE clauses ORed together, ANDed
 * with the filters); this mark lets a binding carry it. An aggregate has no search group, so the
 * key is not marked for it and the canonicalizer drops it there.
 *
 * `value` is the text, or a formula (a search box: `vars.filters.q`) the runtime resolves before
 * the fetch; a value that resolves to no text leaves the search out, so an empty box shows every
 * row. The shape is rebuilt here; whether the value is usable and the fields exist is the
 * validator's to say (validate/bindings.js).
 */

const { LIMITS } = require('../../limits');

const isObject = (/** @type {unknown} */ v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The search text as stored: a formula rebuilt to its two keys, anything else as written. */
function cleanValue(/** @type {unknown} */ value) {
    if (!isObject(value) || /** @type {Record<string, unknown>} */ (value).kind !== 'formula') return value;
    const expr = /** @type {Record<string, unknown>} */ (value).expr;
    return { kind: 'formula', expr: typeof expr === 'string' ? expr.slice(0, LIMITS.MAX_FORMULA_LEN) : expr };
}

module.exports = {
    since: 3,
    kinds: ['record', 'records'],
    shape: '{ value: text | { kind: "formula", expr }, fields: [<field key>] }',
    description: 'Rows where any of the fields contains the text. It ANDs with the filters, and a value that resolves to no text shows every row.',
    clean: (/** @type {unknown} */ value, /** @type {{ path: string, push: (code: string, path: string, message: string) => void }} */ { path, push }) => {
        if (!isObject(value)) {
            push('binding.search_dropped', path, 'search is { value, fields }: dropped it.');
            return undefined;
        }
        const raw = /** @type {Record<string, unknown>} */ (value);
        /** @type {Record<string, unknown>} */
        const out = {};
        if (raw.value !== undefined && raw.value !== null) out.value = cleanValue(raw.value);
        if (raw.fields !== undefined && raw.fields !== null) out.fields = raw.fields;
        return out;
    },
};
