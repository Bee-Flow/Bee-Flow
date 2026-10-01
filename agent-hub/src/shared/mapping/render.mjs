/**
 * Values as text a person reads: never JSON, never "[object Object]".
 *
 *   'Stoel'                          → Stoel
 *   ['a', 'b']            (lines)    → a⏎b         (comma) a, b   (bullets) - a⏎- b
 *   [{product:'Stoel', n:2, prijs:'€40'}, …]  → Stoel · 2 · €40, one line per row
 *   [[1, 2], [3]]                    → 1, 2⏎3     (one line per outer item)
 *   {naam:'Jan', plaats:'Utrecht'}   → naam: Jan⏎plaats: Utrecht
 *   null / undefined                 → ''
 *
 * The rendering goes by the value the RUN holds, not by what the design-time
 * sample looked like: a list that was empty in the sample and holds records
 * at run time renders its records as rows (the "[object Object]" bug of
 * join() on an unknown list).
 *
 * The legacy `{{ }}` rendering (JSON for objects, listAsMarkdown) is
 * interpolateTemplate in legacy.mjs, frozen; this is what a pick with
 * `as: 'text'` and a compose binding render with.
 */

const NL = '\n';

function isRecord(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** One value on one line: a row's values joined by ' · ', a list's by ', '. */
export function inlineText(value) {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return value.map(inlineText).filter(s => s !== '').join(', ');
    if (isRecord(value)) return Object.values(value).map(inlineText).filter(s => s !== '').join(' · ');
    return String(value);
}

function joinLines(lines, join) {
    if (join === 'comma') return lines.join(', ');
    if (join === 'bullets') return lines.map(l => `- ${l}`).join(NL);
    return lines.join(NL);
}

/**
 * A value as readable text. A list gives one entry per item (empty items left
 * out), laid out by `join` (default 'lines'); a record gives one "key: value"
 * entry per field.
 * @param {unknown} value
 * @param {{ join?: 'lines'|'comma'|'bullets' }} [opts]
 */
export function renderText(value, { join = 'lines' } = {}) {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return joinLines(value.map(inlineText).filter(s => s !== ''), join);
    if (isRecord(value)) {
        const lines = Object.keys(value)
            .map(k => [k, inlineText(value[k])])
            .filter(([, v]) => v !== '')
            .map(([k, v]) => `${k}: ${v}`);
        return joinLines(lines, join);
    }
    return String(value);
}

/**
 * A compose binding as text: its literal parts as they are, each value part
 * as `resolvePart(part)` gives it (a string, or a value rendered here).
 * A part `as: 'json'` that is not a string is written as JSON, the one place
 * JSON is asked for.
 * @param {{ parts: Array<string|object> }} compose
 * @param {(part: object) => unknown} resolvePart
 */
export function renderCompose(compose, resolvePart) {
    const parts = compose && Array.isArray(compose.parts) ? compose.parts : [];
    let out = '';
    for (const part of parts) {
        if (typeof part === 'string') { out += part; continue; }
        const value = resolvePart(part);
        if (typeof value === 'string') out += value;
        else if (value === undefined || value === null) out += '';
        else if (part.as === 'json') out += JSON.stringify(value);
        else out += renderText(value, { join: part.join });
    }
    return out;
}
