// @typecheck
/**
 * A list of ids from whatever a step or a model hands a bulk tool: an array
 * of ids, an array of records that carry an `id` (a search's `results`), a
 * JSON array as text, or ids separated by commas, spaces or new lines. Order
 * kept, blanks and duplicates dropped; a record without an id is an error.
 * Shared by gmail_read_many /
 * gmail_bulk_modify and outlook_read_many, so a binding that works for one
 * works for the others.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function idList(value) {
    /** @type {unknown} */
    let list = value;
    if (typeof list === 'string') {
        const text = list.trim();
        if (text.startsWith('[')) {
            try { list = JSON.parse(text); } catch { list = text; }
        }
        if (typeof list === 'string') list = text.split(/[\s,;]+/);
    }
    const entries = Array.isArray(list) ? list : (list === null || list === undefined ? [] : [list]);
    /** @type {string[]} */
    const out = [];
    const seen = new Set();
    let withoutId = 0;
    for (const entry of entries) {
        const isRecord = !!entry && typeof entry === 'object';
        const raw = isRecord ? (/** @type {any} */ (entry).id ?? /** @type {any} */ (entry).messageId) : entry;
        const id = raw === null || raw === undefined || typeof raw === 'object' ? '' : String(raw).trim();
        if (!id) {
            if (isRecord) withoutId += 1;
            continue;
        }
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    // A record with no id is a binding that points at the wrong thing (a
    // forEach's `results`, whose ids sit under `output`), not an empty list:
    // a bulk change must not go green over "nothing to change".
    if (withoutId > 0) {
        throw new Error(`${withoutId} of the ${entries.length} entries has no id. Bind the ids themselves, e.g. steps.<search>.output.results[*].id.`);
    }
    return out;
}

/** A boolean input, which an automation may hand over as the text "true". */
function isOn(/** @type {unknown} */ value) {
    return value === true || value === 'true' || value === 1 || value === '1';
}

module.exports = { idList, isOn };
