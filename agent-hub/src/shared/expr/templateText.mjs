/**
 * How a value reads inside human text: the `{{path}}` of a template binding
 * (notification, e-mail and chat bodies, document fills).
 *
 * One function for the runtime (server/automation/bind.js interpolateTemplate)
 * and the editor's "Here's how it looks" preview, so the two cannot drift:
 *
 *   - nothing (undefined / null)  -> '' (never the word "null")
 *   - text, number, yes/no        -> as written
 *   - a list of plain values      -> "red, green, blue"; empty entries are
 *                                    skipped, an empty list is ''
 *   - a record                    -> "name: Acme BV, city: Utrecht" (a
 *                                    record inside reads "(…)"), keys in the
 *                                    order the step returned them
 *   - a list of records (a table) -> one record per line
 *
 * A slot that carries DATA rather than prose (an http_request body, a prompt,
 * a code step's inputs, a datatable cell) asks for `lists: 'json'` and gets
 * compact JSON for every list and record, as before.
 *
 * Only for text. A binding that maps a WHOLE field (kind 'ref') never goes
 * through here: it keeps its typed value.
 */

const SCALAR = new Set(['string', 'number', 'boolean']);

/** @param {unknown} v */
export function isScalarList(v) {
    return Array.isArray(v) && v.every((x) => x == null || SCALAR.has(typeof x));
}

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** One value inside a record or a list, on one line. */
function inline(v, depth) {
    if (v === undefined || v === null) return '';
    if (SCALAR.has(typeof v)) return String(v);
    if (depth > 4) {
        try { return JSON.stringify(v) ?? ''; } catch { return ''; }
    }
    if (Array.isArray(v)) return v.filter((x) => x != null).map((x) => (isRecord(x) ? `(${record(x, depth + 1)})` : inline(x, depth + 1))).join(', ');
    if (isRecord(v)) return `(${record(v, depth + 1)})`;
    return String(v);
}

/** A record as "key: value, key: value"; empty values are left out. */
function record(obj, depth = 0) {
    return Object.entries(obj)
        .filter(([, x]) => x !== undefined && x !== null && x !== '')
        .map(([k, x]) => `${k}: ${inline(x, depth)}`)
        .join(', ');
}

/**
 * @param {unknown} v
 * @param {{ lists?: 'join' | 'json' }} [opts] `lists: 'json'` keeps lists and
 *   records as JSON, for the slots that carry data rather than prose.
 * @returns {string}
 */
export function templateText(v, { lists = 'join' } = {}) {
    if (v === undefined || v === null) return '';
    if (typeof v === 'string') return v;
    if (typeof v !== 'object') return String(v);
    if (lists === 'json') {
        try { return JSON.stringify(v) ?? ''; } catch { return String(v); }
    }
    if (isScalarList(v)) return v.filter((x) => x != null).map(String).join(', ');
    if (Array.isArray(v)) {
        // A table: one row per line. A mixed list reads each entry inline.
        return v.filter((x) => x != null)
            .map((x) => (isRecord(x) ? record(x) : inline(x, 1)))
            .join('\n');
    }
    return record(v);
}
