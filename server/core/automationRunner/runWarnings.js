/**
 * The warnings a run collected, as the run row records them.
 *
 * Everything that wants to tell the author "this run did something you
 * probably did not mean" pushes onto `runState._templateWarnings` (one array,
 * shared by reference with every loop body, branch and fan-out of the run):
 *
 *   - a `{{ }}` placeholder that resolved to nothing (legacy.mjs pushes the
 *     bare path, e.g. `steps.s1.output.total`; that format is pinned by the
 *     binding corpus, so it is wrapped here, as `template_missing`);
 *   - a ref, expr, pick or compose that gave no value or a doubtful one
 *     (bind.js, from the resolver's BindingWarning);
 *   - a branch that had no edge, a guard finding with nowhere to go (runDag),
 *     an ignored return_to_app effect (execControl).
 *
 * Every producer but legacy.mjs pushes a structured warning, the shape the
 * run's `outcome` has: `{ code, params, text }`. The run view words it by
 * `code` through t('mapping.run_warning.<code>', …) with `params`, so a Dutch
 * UI can say "'E-mail van klant' was leeg"; `text` is the English sentence,
 * the fallback for a code the client does not know. The run row returns this
 * list from the API, so the codes and params are a contract: add codes, never
 * rename one.
 *
 * Params are copied from an allow-list, never spread from a source object,
 * and hold only paths, labels, input names, step ids and counts, never a
 * value from the run.
 */

/** At most this many warnings are recorded per run; the rest are counted. */
const MAX_RUN_WARNINGS = 50;
/** And each text (and each text param) is cut to this many characters. */
const MAX_WARNING_CHARS = 300;

/** The params a warning may carry; anything else is dropped. */
const PARAM_KEYS = ['input', 'label', 'path', 'expr', 'message', 'kind', 'count', 'as', 'stepType', 'step', 'branch', 'field', 'reason'];

function cut(text) {
    const s = String(text);
    return s.length > MAX_WARNING_CHARS ? `${s.slice(0, MAX_WARNING_CHARS - 1)}…` : s;
}

/**
 * A run warning in its stored form. Params from the allow-list only: strings
 * cut, finite numbers kept, everything else dropped.
 * @param {string} code
 * @param {Record<string, unknown>} params
 * @param {string} text — the English sentence, the fallback
 * @returns {{ code: string, params: Record<string, string|number>, text: string }}
 */
function runWarning(code, params, text) {
    const out = {};
    for (const key of PARAM_KEYS) {
        const v = params ? params[key] : undefined;
        if (typeof v === 'string') out[key] = cut(v);
        else if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
    }
    return { code: String(code), params: out, text: cut(text) };
}

function keyOf(w) {
    return `${w.code}\u0000${JSON.stringify(w.params)}`;
}

/**
 * Push a warning onto the run's list, once: loop bodies and fan-outs share
 * the list by reference, and resolve the same binding once per item.
 * @param {object} runState
 * @param {{ code: string, params: object, text: string }} warning
 */
function pushRunWarning(runState, warning) {
    const list = runState && runState._templateWarnings;
    if (!Array.isArray(list)) return;
    const key = keyOf(warning);
    if (list.some(w => w !== null && typeof w === 'object' && keyOf(w) === key)) return;
    list.push(warning);
}

/** One collected entry in its stored form, or null when there is nothing in it. */
function stored(entry) {
    if (entry === null || entry === undefined || entry === '') return null;
    // legacy.mjs pushes the bare path of a `{{ }}` placeholder.
    if (typeof entry === 'string') return runWarning('template_missing', { path: entry }, `{{${entry}}} resolved to nothing`);
    if (typeof entry === 'object' && typeof entry.code === 'string' && entry.code) {
        return runWarning(entry.code, entry.params, typeof entry.text === 'string' ? entry.text : entry.code);
    }
    return null;
}

/**
 * The run's warnings as the run row stores them: `{ code, params, text }`,
 * each once, in the order they happened, capped (the tail is one `more`
 * warning with the count). An empty list when there were none.
 * @param {unknown} collected — runState._templateWarnings
 * @returns {{ code: string, params: Record<string, string|number>, text: string }[]}
 */
function recordedRunWarnings(collected) {
    if (!Array.isArray(collected)) return [];
    const out = [];
    const seen = new Set();
    for (const entry of collected) {
        const w = stored(entry);
        if (!w) continue;
        const key = keyOf(w);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(w);
    }
    if (out.length > MAX_RUN_WARNINGS) {
        const more = out.length - MAX_RUN_WARNINGS;
        return [...out.slice(0, MAX_RUN_WARNINGS), runWarning('more', { count: more }, `…and ${more} more warning(s)`)];
    }
    return out;
}

module.exports = { recordedRunWarnings, pushRunWarning, runWarning, MAX_RUN_WARNINGS, MAX_WARNING_CHARS };
