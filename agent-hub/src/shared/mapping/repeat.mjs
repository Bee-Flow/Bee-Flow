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
 *
 * All three are pure: the step handed in is not changed. Literal values are
 * left alone even when they look like a pick (a `{ kind: 'literal' }`
 * wrapper is data).
 */

import { REF_RE, tokenizePath } from './legacy.mjs';
import { STEP_SITES, COMMON_SITES, fieldValue } from './sites.mjs';
import { sourceFromPath, MAPPING_VERSION } from './intent.mjs';
import { isPrefix, sameSource } from './source.mjs';
import { isCompose, isPick, sourceProblems } from './validate.mjs';

/** The default and the ceiling of `repeat.max`, as for a forEach. */
export const REPEAT_DEFAULT_MAX = 100;
export const REPEAT_MAX = 1000;

const LEGACY_KINDS = new Set(['literal', 'ref', 'template', 'expr']);

function clone(value) {
    if (value === null || typeof value !== 'object') return value;
    try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
}

/**
 * A copy of `value` with every pick (and every pick part of a compose)
 * replaced by `fn(pick)`. Legacy wrappers are returned as they are.
 */
function mapPicks(value, fn) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(v => mapPicks(v, fn));
    if (isPick(value)) return fn(value);
    if (isCompose(value)) return { ...value, parts: value.parts.map(p => (typeof p === 'string' ? p : fn(p))) };
    if (typeof value.kind === 'string' && LEGACY_KINDS.has(value.kind)) return value;
    const out = {};
    for (const k of Object.keys(value)) out[k] = mapPicks(value[k], fn);
    return out;
}

function setField(step, field, value) {
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

/** A copy of `step` with `fn` applied to every pick it holds. */
export function mapStepPicks(step, fn) {
    const out = clone(step);
    if (!out || typeof out !== 'object') return out;
    for (const field of pickFields(out)) {
        const value = fieldValue(out, field);
        if (value !== undefined) setField(out, field, mapPicks(value, fn));
    }
    return out;
}

/**
 * Repeat `step` over `over`. A pick of that list that takes one value or all
 * of them becomes `each`; first, last and count keep meaning the whole list.
 * Refused (`error`) when the step already repeats over another list, or
 * still carries a legacy forEach.
 * @param {object} step
 * @param {object} over — a v2 Source
 * @param {{ max?: number }} [opts]
 * @returns {{ step: object } | { error: 'already_repeating'|'legacy_for_each'|'invalid_source' }}
 */
export function toggleRepeat(step, over, { max = REPEAT_DEFAULT_MAX } = {}) {
    if (sourceProblems(over).length) return { error: 'invalid_source' };
    if (step && step.forEach) return { error: 'legacy_for_each' };
    if (step && step.repeat && step.repeat.over && !sameSource(step.repeat.over, over)) return { error: 'already_repeating' };
    const out = mapStepPicks(step, p => (isPrefix(over, p.from) && (p.take === 'one' || p.take === 'all') ? { ...p, take: 'each' } : p));
    const cap = Number.isSafeInteger(max) ? Math.min(Math.max(max, 1), REPEAT_MAX) : REPEAT_DEFAULT_MAX;
    out.repeat = { over: clone(over), max: cap };
    return { step: out };
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
