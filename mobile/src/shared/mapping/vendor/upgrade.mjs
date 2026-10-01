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
 *
 * lowerPick goes the other way, for the places that can only hold the legacy
 * spelling: a condition's operands (they become one expression string), the
 * list a collection step works through (`arrayRef`, a path string) and the
 * formula editor. It writes the binding liftLegacy lifts back to the same
 * pick: `first(p)`, `join(p, "\n")`, a ref with `[*]` where the data (or the
 * path the user picked) shows a list on the way.
 */

import { REF_RE, tokenizePath, walkPath } from './legacy.mjs';
import { REFUSED_KEYS, sourceBase } from './walk.mjs';
import { WILD, formatSegment, isWild, parseLegacyPath } from './source.mjs';
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

// ── Lowering: a pick in the legacy spelling ─────────────────────────────

/** How each root is written as a legacy path, before its own segments. */
function legacyHead(source) {
    switch (source.root) {
        case 'steps': return typeof source.id === 'string' && source.id ? ['steps', source.id, 'output'] : null;
        case 'loop': return typeof source.id === 'string' && source.id ? ['loop', source.id] : null;
        case 'trigger': return ['trigger', 'output'];
        case 'run': return ['trigger'];
        case 'vars': return ['vars'];
        case 'item': return ['item'];
        default: return null;
    }
}

/**
 * Where a legacy path the user clicked or dropped has a `[*]`, as indexes
 * into the Source's own path (a `[*]` before `path[i]`). Only the part of the
 * hint that names the same keys as the Source counts: `rows[*].email` still
 * says `rows` is a list when the Source became `rows.name` (another column).
 * A hint for another root or step says nothing.
 */
function hintedWilds(source, hint) {
    const out = new Set();
    const parsed = typeof hint === 'string' ? parseLegacyPath(hint.trim()) : null;
    if (!parsed || parsed.root !== source.root || parsed.id !== source.id) return out;
    let i = 0;
    for (const seg of parsed.path) {
        if (isWild(seg)) { out.add(i); continue; }
        if (i >= source.path.length || seg !== source.path[i]) break;
        i += 1;
    }
    return out;
}

/**
 * The segments of a Source with a legacy `[*]` before every key that is read
 * off a list. The legacy walker does not map a key over a list by itself (a
 * pick does), so a column of a table is `rows[*].email`, not `rows.email`.
 * A list is known from the data (the sample) or from the path the user
 * picked (`hint`, which has its `[*]` where the source panel saw a list); a
 * WILD segment in the Source is one as well. Where neither says anything (no
 * sample yet, a key it lacks, no hint) no `[*]` is added: the path is then
 * written as the Source spells it.
 */
function legacySegments(source, sample, hint) {
    const path = Array.isArray(source.path) ? source.path : [];
    const hinted = hintedWilds(source, hint);
    let values = sample && typeof sample === 'object' ? [sourceBase(source, sample)] : [];
    const flatten = () => { values = values.flatMap(v => (Array.isArray(v) ? v : [v])); };
    const out = [];
    for (let i = 0; i < path.length; i++) {
        const seg = path[i];
        if (isWild(seg)) {
            out.push(WILD);
            flatten();
            continue;
        }
        // A hinted [*] goes before a key only: `[*][0]` would index each item.
        if (typeof seg === 'string' && (hinted.has(i) || values.some(Array.isArray))) {
            out.push(WILD);
            flatten();
        }
        out.push(seg);
        values = values
            .filter(v => v !== null && typeof v === 'object')
            .map(v => (Object.prototype.hasOwnProperty.call(v, seg) ? v[seg] : undefined))
            .filter(v => v !== undefined);
    }
    return out;
}

/**
 * A Source written as the legacy path the runtime walks, `[*]` included where
 * the sample shows a list on the way, or null when a key cannot be written
 * (source.mjs formatSegment). Every v2 root has a legacy spelling: `run` is
 * `trigger.<key>`, `item` is `item.<key>`.
 * @param {unknown} source
 * @param {object | null | undefined} [sample] — the runState the data is read from
 * @param {string | null} [hint] — the legacy path the user picked, whose `[*]` are kept
 * @returns {string | null}
 */
export function legacyPathOf(source, sample, hint) {
    if (!source || typeof source !== 'object' || !Array.isArray(source.path)) return null;
    const head = legacyHead(source);
    if (!head) return null;
    let out = head[0];
    for (const seg of [...head.slice(1), ...legacySegments(source, sample, hint)]) {
        const text = formatSegment(seg);
        if (text === null) return null;
        out += text;
    }
    return REF_RE.test(out) ? out : null;
}

/** join()'s separator per pick join, as an expression string literal. */
const JOIN_LITERALS = Object.freeze({ lines: '"\\n"', comma: '", "' });

/**
 * A pick as the legacy binding that gives the same value, or null when there
 * is none (a bulleted text, a per-item value). `take: 'all'` into a text is
 * `join(p, sep)`; into anything else the list itself (a ref). first, last and
 * count are the expression functions of the same name; one is a ref.
 * @param {unknown} pick — a pick binding or a compose part
 * @param {object | null | undefined} [sample]
 * @param {string | null} [hint] — the legacy path the user picked (legacyPathOf)
 * @returns {{ kind: 'ref', path: string } | { kind: 'expr', value: string } | null}
 */
export function lowerPick(pick, sample, hint) {
    if (!pick || typeof pick !== 'object' || !pick.from) return null;
    const path = legacyPathOf(pick.from, sample, hint);
    if (!path) return null;
    switch (pick.take) {
        case undefined:
        case 'one':
            return { kind: 'ref', path };
        case 'all': {
            if (pick.as !== 'text') return { kind: 'ref', path };
            const sep = JOIN_LITERALS[pick.join || 'lines'];
            return sep ? { kind: 'expr', value: `join(${path}, ${sep})` } : null;
        }
        case 'first':
        case 'last':
        case 'count':
            return { kind: 'expr', value: `${pick.take}(${path})` };
        default:
            return null;
    }
}
