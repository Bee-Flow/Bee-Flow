/**
 * Lifting a legacy binding to a pick, for display.
 *
 * A stored automation keeps its refs and exprs as they are: nothing here
 * rewrites a definition. The editor asks liftLegacy whether a legacy binding
 * can be SHOWN as a chip; when it can, the chip is the pick it lifts to, and
 * the binding is only rewritten (to that pick) when the user changes the
 * field, with the new result previewed first. When it cannot, the answer is
 * null and the field shows the grey "Formula" chip, which keeps the binding
 * exactly as stored.
 *
 *   ref without [*]                      → pick take 'one', as 'native'
 *   ref with [*]                         → pick take 'all', as 'native'
 *   join(p, "\n") / join(p, ", ")        → pick take 'all', as 'text', join lines / comma
 *   first(p) / last(p) / count(p)        → pick take 'first' / 'last' / 'count', as 'native'
 *   anything else                        → null ("Formula")
 *
 * A lift is a claim that the chip gives what the run gives today, so it is
 * checked against the data at hand: the design-time sample and, when there
 * is one, the last real run (both runState-shaped: `{ trigger: { output },
 * steps: { <id>: { output } }, vars, loop }`). In each of them the lifted pick
 * must resolve to what the legacy binding resolves to (deep equality). The one
 * difference allowed is a legacy value that was undefined: a ref the old
 * walker could not read (a key on a list, a path into a JSON text) gets a
 * value from a pick, which is the repair M2 made on purpose.
 *
 * A plain ref of keys only needs no evidence: one without [*] or an index
 * reads what a pick of the same Source reads, whatever the data. An index
 * does not: on a text the legacy walker reads a character (`note[0]` of
 * 'abc' is 'a', `body[0]` of a JSON text is '['), where a pick reads nothing
 * or indexes the parsed JSON. A [*] ref and the four functions do not either
 * (a nested list flattens differently, count() of a text is its length,
 * join() writes a record as "Key: value" pairs). These lift only when at
 * least one of the given runStates actually holds data under the path and
 * every comparison agrees. No data, no lift: the chip would be a guess.
 *
 * The expression engine is injected (as in resolve.mjs, since this directory
 * is copied to the clients): without `evaluate`, no expr lifts.
 *
 * Templates are not lifted here. How a `{{ }}` renders depends on the field
 * (leaveUnresolved in prompts, listAsMarkdown on form pages), so lifting one
 * to a compose belongs to the text-field editor that knows the field.
 */

import { REF_RE, tokenizePath, walkPath } from './legacy.mjs';
import { REFUSED_KEYS } from './walk.mjs';
import { MAPPING_VERSION, sourceFromPath } from './intent.mjs';
import { isPick } from './validate.mjs';
import { createResolver } from './resolve.mjs';

/** The functions an expr may call to lift, with the take each one is. */
const FUNCTION_TAKES = Object.freeze({ first: 'first', last: 'last', count: 'count', join: 'all' });

/** The join() separators that have a pick equivalent. */
const JOIN_SEPARATORS = Object.freeze({ '\n': 'lines', ', ': 'comma' });

// One call of a liftable function on one argument path, with an optional
// quoted separator: `join(steps.s1.output.items[*].name, ", ")`. The path
// itself is checked with REF_RE below; this only splits the call.
const CALL_RE = /^\s*([A-Za-z]+)\s*\(\s*([^,()"']+?)\s*(?:,\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))?\s*\)\s*$/;

function noEvaluate() {
    throw new Error('no expression engine');
}

/** The separator a quoted expr string literal holds, or null for one we do not read. */
function unquote(literal) {
    if (typeof literal !== 'string' || literal.length < 2) return null;
    const body = literal.slice(1, -1);
    // Only the escapes a separator uses; anything else is not liftable.
    if (/\\[^n\\"']/.test(body)) return null;
    return body.replace(/\\(n|\\|"|')/g, (_, c) => (c === 'n' ? '\n' : c));
}

/**
 * The tokens of a legacy ref path that a pick can read the same way, or null.
 * Refused: a path REF_RE rejects (the run reads nothing there, and a chip
 * would claim it does), a key the v2 walk never reads (`length`, …), and an
 * index after a `[*]` (`items[*][0]` indexes each item; the pick would index
 * the list).
 */
function liftableTokens(path) {
    if (typeof path !== 'string' || !REF_RE.test(path)) return null;
    const tokens = tokenizePath(path);
    if (!tokens) return null;
    let wild = false;
    for (const tok of tokens) {
        if (tok.type === 'wild') { wild = true; continue; }
        if (typeof tok.key === 'string' && REFUSED_KEYS.includes(tok.key)) return null;
        if (wild && typeof tok.key === 'number') return null;
    }
    return { tokens, wild };
}

function pickOf(path, intent) {
    const from = sourceFromPath(path);
    if (!from) return null;
    const pick = { kind: 'pick', v: MAPPING_VERSION, from, ...intent };
    return isPick(pick) ? pick : null;
}

function isEmptyData(value) {
    return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
}

/** Structural equality of plain run data (JSON values, undefined included). */
function sameValue(a, b) {
    if (Object.is(a, b)) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && sameValue(a[k], b[k]));
}

/**
 * The pick a legacy binding is shown as, or null when it is shown as a
 * Formula. A binding that already is a valid pick is returned as it is.
 *
 * @param {unknown} binding — a stored binding ({ kind: 'ref', path } etc.)
 * @param {object | null | undefined} sample — the design-time runState
 * @param {object | null | undefined} [lastRun] — the last real run's runState
 * @param {{ evaluate?: (src: string, scope: object) => unknown, parse?: object }} [deps]
 * @returns {object | null}
 */
export function liftLegacy(binding, sample, lastRun, { evaluate, parse } = {}) {
    if (isPick(binding)) return binding;
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return null;

    let pick = null;
    let argPath = null;
    let needsEvidence = false;
    if (binding.kind === 'ref') {
        const lift = liftableTokens(binding.path);
        if (!lift) return null;
        pick = pickOf(binding.path, { take: lift.wild ? 'all' : 'one', as: 'native' });
        argPath = binding.path;
        // An index may land on a text, which the two walkers read differently.
        needsEvidence = lift.wild || lift.tokens.some(t => typeof t.key === 'number');
    } else if (binding.kind === 'expr') {
        if (typeof evaluate !== 'function' || typeof binding.value !== 'string') return null;
        const m = CALL_RE.exec(binding.value);
        if (!m || !Object.prototype.hasOwnProperty.call(FUNCTION_TAKES, m[1])) return null;
        const [, fn, path, sepLiteral] = m;
        if (!liftableTokens(path)) return null;
        if (fn === 'join') {
            const join = JOIN_SEPARATORS[unquote(sepLiteral)];
            if (!join) return null;
            pick = pickOf(path, { take: 'all', as: 'text', join });
        } else {
            if (sepLiteral !== undefined) return null;
            pick = pickOf(path, { take: FUNCTION_TAKES[fn], as: 'native' });
        }
        argPath = path;
        needsEvidence = true;
    }
    if (!pick) return null;

    const resolver = createResolver({ evaluate: typeof evaluate === 'function' ? evaluate : noEvaluate, parse });
    const states = [sample, lastRun].filter(s => s !== null && typeof s === 'object');
    let evidence = false;
    for (const state of states) {
        const before = resolver.resolveValue(binding, state, { silent: true });
        const after = resolver.resolveValue(pick, state, { silent: true });
        if (!isEmptyData(walkPath(argPath, state))) evidence = true;
        if (before === undefined && !needsEvidence) continue;
        if (!sameValue(before, after)) return null;
    }
    if (needsEvidence && !evidence) return null;
    return pick;
}
