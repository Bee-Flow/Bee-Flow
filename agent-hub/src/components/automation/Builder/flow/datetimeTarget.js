/**
 * The column a list-mode Date & time step writes into.
 *
 * Mirrors `datetimeTargetColumn` in server/core/automationRunner/engine.js — the
 * builder has to predict the column name so the variable picker can offer
 * `items[*].day` before the step has ever run. If the two drift, a downstream
 * binding points at a column the run never produces.
 */
export function datetimeTargetColumn(step) {
    if (typeof step?.target === 'string' && step.target.trim()) return step.target.trim();
    if (step?.op === 'extract' && step.part) return String(step.part);
    if (step?.op === 'diff') return 'diff';
    if (step?.op === 'format') return 'formatted';
    return String(step?.op || 'value');
}

/** True when this step works through a list rather than a single date. */
export function isDateTimeListMode(step) {
    return typeof step?.arrayRef === 'string';
}

/**
 * Split a wildcard column path into the list it walks and the field it reads:
 * `steps.x.output.results[*].updated` → `{ arrayRef, itemPath: 'item.updated' }`.
 *
 * This is what turns "the author dropped a whole column into Input date" into
 * list mode automatically. Without it the array reached `toDate()` whole and
 * the step failed with "did not resolve to a parseable date" (BFSF-375).
 *
 * Returns null when the path carries no `[*]`, so a normal single-date binding
 * is left exactly as it was.
 */
/**
 * What changes when the author puts something in "Input date".
 *
 * Normally just the input. But a `[*]` path is a whole COLUMN, and the only
 * sensible reading of "do this to a column" is "do it to every row" — so the
 * step switches itself into list mode rather than handing an array of 17
 * strings to a single date parse (BFSF-375). Already in list mode, the value
 * is taken as written: the author is addressing the row scope by hand.
 */
export function dateInputPatch(value, { listMode = false } = {}) {
    const split = listMode ? null : splitWildcardPath(value);
    if (!split) return { input: value };
    return { arrayRef: split.arrayRef, input: split.itemPath };
}

export function splitWildcardPath(path) {
    const s = String(path || '');
    const at = s.indexOf('[*]');
    if (at < 0) return null;
    const arrayRef = s.slice(0, at);
    const tail = s.slice(at + 3).replace(/^\./, '');
    if (!arrayRef) return null;
    // A second `[*]` means a list of lists; one column is all this step can add.
    if (tail.includes('[*]')) return null;
    return { arrayRef, itemPath: tail ? `item.${tail}` : 'item' };
}

/**
 * The list mode a step implies when it carries a whole column in "Input date"
 * but no `arrayRef` — saved before `dateInputPatch` existed, imported, or
 * AI-written. The runner reads such a step as list mode (server
 * automation/datetimeListMode.js `impliedListMode`, which this mirrors), so the
 * editor and the variable picker must too. `input2` moves along only when it
 * is a column of the SAME list. Null when nothing is implied.
 */
export function impliedListMode(step) {
    if (!step || (step.arrayRef !== undefined && step.arrayRef !== null)) return null;
    // `now` reads no input date: a stale column in its `input` implies nothing.
    if (step.op === 'now') return null;
    const split = typeof step.input === 'string' ? splitWildcardPath(step.input) : null;
    if (!split) return null;
    const out = { arrayRef: split.arrayRef, input: split.itemPath };
    const split2 = typeof step.input2 === 'string' ? splitWildcardPath(step.input2) : null;
    if (split2 && split2.arrayRef === split.arrayRef) out.input2 = split2.itemPath;
    return out;
}
