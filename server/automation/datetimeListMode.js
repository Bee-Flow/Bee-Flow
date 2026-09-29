'use strict';

/**
 * A whole COLUMN in a Date & time step's "Input date", read as list mode.
 *
 * Since BFSF-375 the builder turns a dropped column
 * (`steps.x.output.results[*].updated`) into list mode as the author picks it:
 * `arrayRef: 'steps.x.output.results'`, `input: 'item.updated'`. But that
 * happens only in the field's onChange. A step saved before that fix — or
 * imported, or written by the AI builder or an MCP client — still carries the
 * `[*]` path in `input` with no `arrayRef`, and ran in single mode: the whole
 * array reached one date parse and the step failed with "did not resolve to a
 * parseable date".
 *
 * The runner, the validator and the builder all read such a step as the list
 * mode it stands for. Such a step always failed before, so nothing downstream
 * can depend on its single-date output.
 */

/**
 * Split a wildcard column path into the list it walks and the field it reads:
 * `steps.x.output.results[*].updated` → `{ arrayRef, itemPath: 'item.updated' }`.
 * Null when there is no `[*]`, no list before it, or a second `[*]` (a list of
 * lists — one column is all this step can add).
 *
 * Server copy of `splitWildcardPath` in
 * agent-hub/src/components/automation/Builder/flow/datetimeTarget.js; keep the
 * two in step.
 */
function splitWildcardPath(path) {
    const s = String(path || '');
    const at = s.indexOf('[*]');
    if (at < 0) return null;
    const arrayRef = s.slice(0, at);
    const tail = s.slice(at + 3).replace(/^\./, '');
    if (!arrayRef) return null;
    if (tail.includes('[*]')) return null;
    return { arrayRef, itemPath: tail ? `item.${tail}` : 'item' };
}

/**
 * The list-mode fields a datetime step without `arrayRef` implies, or null.
 *
 * `{ arrayRef, input }`, plus `input2` when the second date is a column of the
 * SAME list (a "time between two dates" over two columns of one table). A
 * step that already has an `arrayRef` key is taken as written. `now` reads no
 * input date at all, so a stale column left in its `input` ran fine in single
 * mode and implies nothing.
 */
function impliedListMode(step) {
    if (!step || (step.arrayRef !== undefined && step.arrayRef !== null)) return null;
    if (step.op === 'now') return null;
    const split = typeof step.input === 'string' ? splitWildcardPath(step.input) : null;
    if (!split) return null;
    const out = { arrayRef: split.arrayRef, input: split.itemPath };
    const split2 = typeof step.input2 === 'string' ? splitWildcardPath(step.input2) : null;
    if (split2 && split2.arrayRef === split.arrayRef) out.input2 = split2.itemPath;
    return out;
}

module.exports = { splitWildcardPath, impliedListMode };
