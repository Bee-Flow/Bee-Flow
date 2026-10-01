/**
 * What a definition READS through its v2 bindings, for the code that lists
 * the values a step uses rather than resolving them: which steps a step
 * depends on, which fields of an AI step's answer a later step reads, which
 * `loop.<var>` a step needs bound, what a summary shows.
 *
 * Those readers were written for the legacy kinds and scan paths as text
 * (`steps.<id>.output.<field>`, the `{{ }}` of a template). A pick holds its
 * path as data and a compose holds its parts as objects, so a text scan sees
 * neither. This file hands them over in the spelling the readers already
 * know: each pick's Source as its legacy path (describeSource), and a text
 * field as `{{ }}` text. Never for rendering: a compose renders through
 * render.mjs, where a list becomes readable text instead of JSON.
 *
 * What counts as a pick is what resolve.mjs resolves: a valid pick, and the
 * value parts of a valid compose, at any depth of a bare structure. A legacy
 * binding is not looked into (a literal's value is data), and an object that
 * only says `kind: 'pick'` without validating is a literal object, whose
 * members are looked into, as resolveDeep does.
 */

import { describeSource, isCompose, isPick, sourceProblems } from './validate.mjs';

const LEGACY_KINDS = new Set(['literal', 'ref', 'template', 'expr']);
const MAX_DEPTH = 32;

function collect(value, out, depth) {
    if (value === null || typeof value !== 'object' || depth > MAX_DEPTH) return;
    if (Array.isArray(value)) {
        for (const v of value) collect(v, out, depth + 1);
        return;
    }
    if (isPick(value)) { out.push(value); return; }
    if (isCompose(value)) {
        for (const part of value.parts) if (typeof part !== 'string') out.push(part);
        return;
    }
    if (typeof value.kind === 'string' && LEGACY_KINDS.has(value.kind)) return;
    for (const k of Object.keys(value)) collect(value[k], out, depth + 1);
}

/**
 * Every pick a value holds, in order: pick bindings, and the value parts of
 * compose bindings (`{ from, take, as, join?, label? }`, no kind).
 * @param {unknown} value — a binding, a step, any structure
 * @returns {Array<{ from: object, take: string, as: string, join?: string, label?: string }>}
 */
export function picksIn(value) {
    const out = [];
    collect(value, out, 0);
    return out;
}

/**
 * The legacy path every pick in a value reads (`steps.s1.output.items.sku`,
 * `loop.r.output.name`, `trigger.firedAt` for a run key), in order. A Source
 * the legacy grammar cannot spell is left out.
 * @param {unknown} value
 * @returns {string[]}
 */
export function pickPaths(value) {
    return picksIn(value).map(p => describeSource(p.from)).filter(Boolean);
}

/**
 * Every path a step reads through the v2 mapping: its picks (in any field),
 * the list its `repeat` goes over, and a loop's `over` (a Source, or a pick).
 * @param {unknown} step
 * @returns {string[]}
 */
export function stepReadPaths(step) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return [];
    const out = pickPaths(step);
    const repeat = step.repeat;
    if (repeat && typeof repeat === 'object' && repeat.over) {
        const p = describeSource(repeat.over);
        if (p) out.push(p);
    }
    if (step.type === 'loop' && step.over && typeof step.over === 'object' && !isPick(step.over)) {
        const p = describeSource(step.over);
        if (p) out.push(p);
    }
    return out;
}

function addStepId(source, ids) {
    if (source && source.root === 'steps' && sourceProblems(source).length === 0) ids.add(source.id);
}

function collectStepIds(value, ids, depth) {
    if (value === null || typeof value !== 'object' || depth > MAX_DEPTH) return;
    if (Array.isArray(value)) {
        for (const v of value) collectStepIds(v, ids, depth + 1);
        return;
    }
    if (isPick(value)) { addStepId(value.from, ids); return; }
    if (isCompose(value)) {
        for (const part of value.parts) if (typeof part !== 'string') addStepId(part.from, ids);
        return;
    }
    if (typeof value.kind === 'string' && LEGACY_KINDS.has(value.kind)) return;
    // A step's repeat and a loop's `over` hold a bare Source, not a pick.
    if (value.repeat && typeof value.repeat === 'object') addStepId(value.repeat.over, ids);
    if (value.type === 'loop') addStepId(value.over, ids);
    for (const k of Object.keys(value)) collectStepIds(value[k], ids, depth + 1);
}

/**
 * The ids of the steps a value reads through the v2 mapping, at any depth:
 * every pick and compose part from `steps`, and the list of every `repeat`
 * and loop `over` in it (the steps of a loop body included). For the
 * readers that ask "does this read step X" by scanning `steps.<id>` text,
 * which a pick does not hold; a Source no legacy path can spell counts too.
 * @param {unknown} value — a step, a binding, any structure
 * @returns {string[]}
 */
export function stepIdsRead(value) {
    const ids = new Set();
    collectStepIds(value, ids, 0);
    return [...ids];
}

function placeholder(from) {
    const p = describeSource(from);
    return p ? `{{${p}}}` : '';
}

/**
 * A text field as `{{ }}` text: a string as it is, a compose with each value
 * part written as the placeholder of the path it reads, a pick as its one
 * placeholder, anything else ''. For readers that look for the paths a text
 * reads, and for a summary a model reads; the run renders a compose itself.
 * @param {unknown} value
 * @returns {string}
 */
export function textAsTemplate(value) {
    if (typeof value === 'string') return value;
    if (isPick(value)) return placeholder(value.from);
    if (isCompose(value)) return value.parts.map(p => (typeof p === 'string' ? p : placeholder(p.from))).join('');
    return '';
}
