/**
 * Running a step once per item: `step.repeat = { over: Source, max }`.
 *
 * A repeat is set on purpose, in the step's advanced settings, never as a
 * side effect of a pick. While it is on, a pick of the list it repeats over
 * reads the CURRENT item: its take is `each`, and the run walks the rest of
 * its path inside that item (resolve.mjs, with runState._mappingScope set by
 * execRepeat.js). These functions are the only writers of that link:
 *
 *   toggleRepeat(step, over)  repeat over `over`; picks of it become `each`
 *   toggleRepeatOff(step)     no repeat; its `each` picks become `all`
 *   rebaseLoopRefs(step)      a legacy forEach + `loop.<var>` refs, as a
 *                             repeat + `each` picks, or the reasons it can't
 *   stopForEach(step)         a legacy forEach off; its item refs read the
 *                             whole list again
 *   renameItemVar(step, to)   a forEach's or a loop's item renamed, with
 *                             every `loop.<old>` that reads it
 *
 * All of them are pure: the step handed in is not changed. Literal values are
 * left alone even when they look like a pick (a `{ kind: 'literal' }`
 * wrapper is data).
 */

import { REF_RE, tokenizePath } from './legacy.mjs';
import { STEP_SITES, COMMON_SITES, fieldValue } from './sites.mjs';
import { sourceFromPath, MAPPING_VERSION } from './intent.mjs';
import { isPrefix, isWild, parseLegacyPath, sameSource } from './source.mjs';
import { isCompose, isPick, sourceProblems } from './validate.mjs';

/** The default and the ceiling of `repeat.max`, as for a forEach. */
export const REPEAT_DEFAULT_MAX = 100;
export const REPEAT_MAX = 1000;

const LEGACY_KINDS = new Set(['literal', 'ref', 'template', 'expr']);

// clone, setField and readsLoopItem are shared with upgrade.mjs (not part
// of index.mjs): what rebaseLoopRefs counts as a read of the item, and what
// the upgrade counts as one still left, must be one rule.

/** A deep copy of plain data. */
export function clone(value) {
    if (value === null || typeof value !== 'object') return value;
    try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
}

/**
 * A copy of `value` with every pick (and every pick part of a compose)
 * replaced by `fn(pick)`, and, when `refFn` is given, every legacy ref by
 * `refFn(ref)`. Other legacy wrappers are returned as they are.
 */
function mapPicks(value, fn, refFn = null) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(v => mapPicks(v, fn, refFn));
    if (isPick(value)) return fn(value);
    if (isCompose(value)) return { ...value, parts: value.parts.map(p => (typeof p === 'string' ? p : fn(p))) };
    if (refFn && value.kind === 'ref') return refFn(value);
    if (typeof value.kind === 'string' && LEGACY_KINDS.has(value.kind)) return value;
    const out = {};
    for (const k of Object.keys(value)) out[k] = mapPicks(value[k], fn, refFn);
    return out;
}

/** Set the dotted `field` of `step` (sites.mjs spelling); a missing parent is left alone. */
export function setField(step, field, value) {
    const keys = String(field).split('.');
    let cur = step;
    for (const key of keys.slice(0, -1)) {
        if (cur[key] === null || typeof cur[key] !== 'object') return;
        cur = cur[key];
    }
    cur[keys[keys.length - 1]] = value;
}

/** The fields of a step that may hold picks: its bindings and its texts. */
function pickFields(step) {
    const entry = Object.prototype.hasOwnProperty.call(STEP_SITES, step.type) ? STEP_SITES[step.type] : {};
    return [...COMMON_SITES.bindings, ...(entry.bindings || []), ...(entry.text || []).map(t => t.field)];
}

/**
 * A copy of `step` with `fn` applied to every pick it holds (and `refFn`,
 * when given, to every legacy ref).
 */
export function mapStepPicks(step, fn, refFn = null) {
    const out = clone(step);
    if (!out || typeof out !== 'object') return out;
    for (const field of pickFields(out)) {
        const value = fieldValue(out, field);
        if (value !== undefined) setField(out, field, mapPicks(value, fn, refFn));
    }
    return out;
}

/**
 * The per-item pick a legacy ref becomes when its step starts repeating
 * over `over`, or null when it does not read that list item by item. Only
 * the "every item" spelling counts: `<list>[*]` and what follows it inside
 * one item. The list itself, an index (`<list>[0]`) or another list is not
 * per item and stays as it is.
 */
function liftRefToEach(ref, over) {
    const legacy = typeof ref.path === 'string' ? parseLegacyPath(ref.path.trim()) : null;
    if (!legacy || legacy.root !== over.root || (legacy.id ?? null) !== (over.id ?? null)) return null;
    const n = over.path.length;
    if (legacy.path.length <= n || !isWild(legacy.path[n])) return null;
    if (!isPrefix(over, { ...legacy, path: legacy.path.slice(0, n) })) return null;
    // A deeper `[*]` is what a key on a list does anyway in the v2 walk.
    const inside = legacy.path.slice(n + 1).filter(seg => !isWild(seg));
    return { kind: 'pick', v: MAPPING_VERSION, from: { ...over, path: [...over.path, ...inside] }, take: 'each', as: 'native' };
}

/** How many picks of `step` read the current item of `over`. */
function countEach(step, over) {
    let n = 0;
    mapStepPicks(step, (p) => { if (p.take === 'each' && isPrefix(over, p.from)) n++; return p; });
    return n;
}

/**
 * Repeat `step` over `over`. A pick of that list that takes one value or all
 * of them becomes `each`; first, last and count keep meaning the whole list.
 * A legacy ref that reads every item of the list (`<list>[*].email`) becomes
 * an `each` pick too: turning the repeat on is the user asking for that
 * value per item, and the editor shows the change before it is made.
 * `each` counts the values that read the current item afterwards; zero
 * means the step would do the same thing once per item.
 * Refused (`error`) when the step already repeats over another list, or
 * still carries a legacy forEach.
 * @param {object} step
 * @param {object} over — a v2 Source
 * @param {{ max?: number }} [opts]
 * @returns {{ step: object, each: number } | { error: 'already_repeating'|'legacy_for_each'|'invalid_source' }}
 */
export function toggleRepeat(step, over, { max = REPEAT_DEFAULT_MAX } = {}) {
    if (sourceProblems(over).length) return { error: 'invalid_source' };
    if (step && step.forEach) return { error: 'legacy_for_each' };
    if (step && step.repeat && step.repeat.over && !sameSource(step.repeat.over, over)) return { error: 'already_repeating' };
    const out = mapStepPicks(
        step,
        p => (isPrefix(over, p.from) && (p.take === 'one' || p.take === 'all') ? { ...p, take: 'each' } : p),
        ref => liftRefToEach(ref, over) || ref,
    );
    const cap = Number.isSafeInteger(max) ? Math.min(Math.max(max, 1), REPEAT_MAX) : REPEAT_DEFAULT_MAX;
    out.repeat = { over: clone(over), max: cap };
    return { step: out, each: countEach(out, over) };
}

/**
 * Stop repeating `step`: its `each` picks read the whole list again (`all`).
 * @param {object} step
 * @returns {{ step: object }}
 */
export function toggleRepeatOff(step) {
    const over = step && step.repeat ? step.repeat.over : null;
    const out = mapStepPicks(step, p => (p.take === 'each' && (!over || isPrefix(over, p.from)) ? { ...p, take: 'all' } : p));
    if (out && typeof out === 'object') delete out.repeat;
    return { step: out };
}

function loopRefRe(itemVar) {
    const esc = itemVar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9_$.])loop\\s*(\\.\\s*${esc}\\b|\\[\\s*["']${esc}["']\\s*\\]|\\.\\s*_index\\b)`);
}

/** Does `text` read the forEach item (`loop.<var>`, `loop["<var>"]`) or `loop._index`? */
export function readsLoopItem(text, itemVar) {
    if (typeof text !== 'string' || !text.includes('loop')) return false;
    return loopRefRe(itemVar).test(text);
}

/**
 * A legacy "run once per item" step (forEach + `loop.<itemVar>` refs) as a
 * repeat with `each` picks, when that reads the same: every use of the item
 * must be a plain ref (`loop.row.email`). A template, an expr or a text that
 * reads the item, `loop._index`, or a list the v2 Source cannot name is a
 * reason to refuse, and the step is not changed.
 * @param {object} step
 * @returns {{ step: object } | { refused: string[] }}
 */
export function rebaseLoopRefs(step) {
    const fe = step && step.forEach;
    if (!fe || typeof fe !== 'object' || typeof fe.overRef !== 'string') return { refused: ['no_for_each'] };
    const over = sourceFromPath(fe.overRef);
    if (!over) return { refused: ['over_unreadable'] };
    const itemVar = typeof fe.itemVar === 'string' && fe.itemVar ? fe.itemVar : 'item';
    const uses = loopRefRe(itemVar);
    const refused = new Set();
    const rebase = (value) => {
        if (value === null || typeof value !== 'object') {
            // Only a `{{ }}` text is read by the run; any other string is data.
            if (typeof value === 'string' && value.includes('{{') && uses.test(value)) refused.add('loop_in_text');
            return value;
        }
        if (Array.isArray(value)) return value.map(rebase);
        if (value.kind === 'literal') return value;
        if (value.kind === 'ref') {
            const path = typeof value.path === 'string' ? value.path.trim() : '';
            if (!uses.test(path)) return value;
            const tokens = REF_RE.test(path) ? tokenizePath(path) : null;
            if (!tokens || tokens[1]?.key !== itemVar || tokens.some(t => t.type !== 'prop')) {
                refused.add(tokens && tokens[1]?.key === '_index' ? 'loop_index' : 'loop_ref_unreadable');
                return value;
            }
            return {
                kind: 'pick', v: MAPPING_VERSION,
                from: { ...over, path: [...over.path, ...tokens.slice(2).map(t => t.key)] },
                take: 'each', as: 'native',
            };
        }
        if (value.kind === 'template' || value.kind === 'expr') {
            if (typeof value.value === 'string' && uses.test(value.value)) refused.add(`loop_in_${value.kind}`);
            return value;
        }
        if (isPick(value) || isCompose(value)) return value;
        const out = {};
        for (const k of Object.keys(value)) out[k] = rebase(value[k]);
        return out;
    };
    const out = clone(step);
    for (const field of pickFields(out)) {
        const value = fieldValue(out, field);
        if (value !== undefined) setField(out, field, rebase(value));
    }
    if (refused.size) return { refused: [...refused].sort() };
    const max = Number.isSafeInteger(fe.maxIterations) ? fe.maxIterations : REPEAT_DEFAULT_MAX;
    delete out.forEach;
    out.repeat = { over, max };
    return { step: out };
}

/**
 * A legacy "run once per item" switched off. Its `loop.<itemVar>` refs read
 * the whole list again (each becomes an `all` pick of that list, through
 * rebaseLoopRefs and toggleRepeatOff), so the fields keep a value instead of
 * pointing at an item that no longer exists. When a value cannot be carried
 * over that way (a template or an expression reading the item), the forEach
 * is still removed and `orphaned` names why: those values will be empty, and
 * the editor says so.
 * @param {object} step
 * @returns {{ step: object, orphaned?: string[] }}
 */
export function stopForEach(step) {
    if (!step || typeof step !== 'object' || !step.forEach) return { step: clone(step) };
    const rebased = rebaseLoopRefs(step);
    if (rebased.step) return toggleRepeatOff(rebased.step);
    const out = clone(step);
    delete out.forEach;
    const reasons = rebased.refused.filter(r => r !== 'no_for_each' && r !== 'over_unreadable');
    return reasons.length ? { step: out, orphaned: reasons } : { step: out };
}

// ── Renaming the item of a forEach or a loop ──────────────────────────────

const ITEM_VAR_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `src` (an expression or the inside of a `{{ }}`) with `loop.<from>` read
 * as `loop.<to>`. Quoted text is data and left alone, except the bracket
 * spelling `loop["<from>"]`, whose quotes are part of the path.
 */
function renameInExpr(src, from, to) {
    const bracket = new RegExp(`(^|[^A-Za-z0-9_$.])loop\\s*\\[\\s*(["'])${escapeRe(from)}\\2\\s*\\]`, 'g');
    const dotted = new RegExp(`(^|[^A-Za-z0-9_$.])loop(\\s*\\.\\s*)${escapeRe(from)}(?![A-Za-z0-9_$])`, 'g');
    const s = src.replace(bracket, `$1loop.${to}`);
    let out = '';
    let i = 0;
    while (i < s.length) {
        const q = s.slice(i).search(/["'`]/);
        const end = q === -1 ? s.length : i + q;
        out += s.slice(i, end).replace(dotted, `$1loop$2${to}`);
        if (q === -1) break;
        // Copy the quoted text as it is, escapes included.
        const quote = s[end];
        let j = end + 1;
        while (j < s.length && s[j] !== quote) j += s[j] === '\\' ? 2 : 1;
        out += s.slice(end, j + 1);
        i = j + 1;
    }
    return out;
}

/** A `{{ }}` text with `loop.<from>` read as `loop.<to>` inside its placeholders. */
function renameInTemplate(text, from, to) {
    return text.replace(/\{\{([\s\S]*?)\}\}/g, (m, inner) => `{{${renameInExpr(inner, from, to)}}}`);
}

function renameInSource(src, from, to) {
    return src && src.root === 'loop' && src.id === from ? { ...src, id: to } : src;
}

/**
 * A binding structure (any depth) with its `loop.<from>` reads renamed.
 * `strings`: the site renders a bare string as a `{{ }}` text
 * (STEP_SITES `stringTexts`); anywhere else a bare string is data.
 */
function renameInBinding(value, from, to, strings = false) {
    if (typeof value === 'string' && strings) return renameInTemplate(value, from, to);
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(v => renameInBinding(v, from, to, strings));
    if (isPick(value)) return { ...value, from: renameInSource(value.from, from, to) };
    if (isCompose(value)) {
        return { ...value, parts: value.parts.map(p => (typeof p === 'string' ? p : { ...p, from: renameInSource(p.from, from, to) })) };
    }
    switch (value.kind) {
        case 'literal': return value;
        case 'ref': return typeof value.path === 'string' ? { ...value, path: renameInExpr(value.path, from, to) } : value;
        case 'template': return typeof value.value === 'string' ? { ...value, value: renameInTemplate(value.value, from, to) } : value;
        case 'expr': return typeof value.value === 'string' ? { ...value, value: renameInExpr(value.value, from, to) } : value;
        default: break;
    }
    const out = {};
    for (const k of Object.keys(value)) out[k] = renameInBinding(value[k], from, to, strings);
    return out;
}

/** A text site's value: a `{{ }}` text, or a compose. */
function renameInText(value, from, to) {
    return typeof value === 'string' ? renameInTemplate(value, from, to) : renameInBinding(value, from, to);
}

/**
 * Every value of `step` that is read in the scope `loop.<from>` lives in,
 * renamed. `ownList`: also the list the step itself repeats over, which is
 * read OUTSIDE its own item (false for the step that binds the name).
 */
function renameInStep(step, from, to, { ownList = true } = {}) {
    const out = clone(step);
    const entry = Object.prototype.hasOwnProperty.call(STEP_SITES, out.type) ? STEP_SITES[out.type] : {};
    const update = (field, fn) => {
        const value = fieldValue(out, field);
        if (value !== undefined) setField(out, field, fn(value));
    };
    const stringTexts = new Set(entry.stringTexts || []);
    for (const field of [...COMMON_SITES.bindings, ...(entry.bindings || [])]) {
        update(field, v => renameInBinding(v, from, to, stringTexts.has(field)));
    }
    for (const site of entry.text || []) {
        update(site.field, (v) => {
            if (!site.each || !v || typeof v !== 'object' || Array.isArray(v)) return renameInText(v, from, to);
            return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, renameInText(x, from, to)]));
        });
    }
    const lists = [...(ownList ? COMMON_SITES.lists : []), ...(entry.lists || [])];
    for (const field of lists) update(field, v => (typeof v === 'string' ? renameInExpr(v, from, to) : renameInSource(v, from, to)));
    for (const field of entry.refs || []) update(field, v => (typeof v === 'string' ? renameInExpr(v, from, to) : v));
    for (const field of entry.exprs || []) {
        if (field !== 'cases') { update(field, v => (typeof v === 'string' ? renameInExpr(v, from, to) : v)); continue; }
        update('cases', v => (Array.isArray(v)
            ? v.map(c => (c && typeof c.expr === 'string' ? { ...c, expr: renameInExpr(c.expr, from, to) } : c))
            : v));
    }
    return out;
}

const itemVarOf = (name) => (typeof name === 'string' && name ? name : 'item');

/** Whether `a` and `b` hold the same values (both are plain JSON). */
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The steps of a loop body (or of a parallel branch inside one) with
 * `loop.<from>` renamed, minding a nested rebinding. A scope inside the body
 * that binds `to` itself (a step that runs once per item under that name, or
 * a nested loop) would read a renamed `loop.<to>` as ITS OWN item: when such
 * a scope reads `loop.<from>`, `captured.hit` is set and the caller refuses.
 */
function renameInBody(body, from, to, captured = { hit: false }) {
    if (!Array.isArray(body)) return body;
    return body.map((s) => {
        if (!s || typeof s !== 'object') return s;
        const feVar = s.forEach && typeof s.forEach === 'object' ? itemVarOf(s.forEach.itemVar) : null;
        // A step that runs once per item under the same name sees its own
        // item; only the list it repeats over is read in this scope.
        if (feVar === from) {
            const own = clone(s);
            if (typeof own.forEach.overRef === 'string') own.forEach.overRef = renameInExpr(own.forEach.overRef, from, to);
            return own;
        }
        if (feVar === to && !sameJson(renameInStep(s, from, PROBE, { ownList: false }), s)) captured.hit = true;
        // A nested loop's own list is read in this scope (renameInStep);
        // its body too, unless it binds the same name and hides this item.
        const out = renameInStep(s, from, to, { ownList: true });
        if (out.type === 'loop' && Array.isArray(out.body)) {
            const inner = itemVarOf(s.itemVar);
            if (inner === to && !sameJson(renameInBody(s.body, from, PROBE), s.body)) captured.hit = true;
            if (inner !== from) out.body = renameInBody(out.body, from, to, captured);
        }
        // Parallel branches run with the loop's scope (execFlow.js).
        if (out.type === 'parallel' && Array.isArray(out.branches)) {
            out.branches = out.branches.map(b => renameInBody(b, from, to, captured));
        }
        return out;
    });
}

/**
 * Give the item of a legacy forEach (`step.forEach.itemVar`) or of a loop
 * step (`step.itemVar`) a new name, and rewrite every `loop.<old>` that reads
 * it to match: in the forEach step's own values, or in the loop's body.
 * Refs, templates, expressions, `{{ }}` texts and picks are all rewritten;
 * literals are data and stay. Without this a rename (or a new list, which
 * suggests a new name) left every binding pointing at a name the run no
 * longer binds. A name the same values already read (an outer loop's item)
 * is refused (`name_in_use`): the two would merge, and could not be told
 * apart again. So is a name a scope inside a loop body binds itself (a step
 * that runs once per item, a nested loop) while it reads the old name: the
 * rewritten value would read that scope's own item instead.
 * @param {object} step
 * @param {string} to
 * @returns {{ step: object } | { error: 'invalid_name' | 'no_item' | 'name_in_use' }}
 */
export function renameItemVar(step, to) {
    if (typeof to !== 'string' || !ITEM_VAR_RE.test(to) || to === '_index') return { error: 'invalid_name' };
    if (!step || typeof step !== 'object') return { error: 'no_item' };
    const isLoop = step.type === 'loop';
    const fe = step.forEach;
    if (!isLoop && (!fe || typeof fe !== 'object')) return { error: 'no_item' };
    const from = itemVarOf(isLoop ? step.itemVar : fe.itemVar);
    if (from === to) return { step: clone(step) };
    // The values in the item's scope, renamed from `a` to `b`.
    const scope = (a, b, captured) => (isLoop
        ? { ...clone(step), body: renameInBody(clone(step.body), a, b, captured) }
        : renameInStep(step, a, b, { ownList: false }));
    if (!sameJson(scope(to, PROBE), scope(to, to))) return { error: 'name_in_use' };
    const captured = { hit: false };
    const out = scope(from, to, captured);
    if (captured.hit) return { error: 'name_in_use' };
    if (isLoop) {
        out.itemVar = to;
        if (out.body === undefined) delete out.body;
    } else {
        out.forEach = { ...out.forEach, itemVar: to };
    }
    return { step: out };
}

/** A name no author writes: renaming a name to it shows whether anything reads that name. */
const PROBE = '__bf_rename_probe__';
