// @typecheck
/**
 * Pure helper utilities for automation definition validation (§WS5).
 *
 * Extracted from validate.js so the orchestrator (validateGraph/validateDefinition)
 * stays focused on the rules rather than the graph/string plumbing. These are all
 * pure functions with no shared state — they take their inputs and return a value
 * or push onto a caller-supplied array.
 */

const { refHead, templateRefs, hasPlaceholder } = require('./refPaths');

function isObject(x) { return x && typeof x === 'object' && !Array.isArray(x); }

/**
 * Optional canvas position (`{ x, y }`) — written by the drag-and-drop
 * builder, ignored by the runner. We reject only malformed shapes so a
 * typo on the UI side surfaces fast instead of silently round-tripping
 * garbage through the JSONB blob.
 * @param {(value: { code: string; severity: string; path: string; message: string; hint: string; }) => void} push
 */
function validatePosition(pos, at, push) {
    if (pos === undefined || pos === null) return;
    if (!isObject(pos)) {
        push({ code: 'position.shape', severity: 'error', path: at + '.position', message: 'position must be an object { x, y }.', hint: 'Pass { x: number, y: number } or omit the field entirely.' });
        return;
    }
    for (const k of ['x', 'y']) {
        const v = pos[k];
        if (typeof v !== 'number' || !Number.isFinite(v)) {
            push({ code: 'position.coord', severity: 'error', path: at + `.position.${k}`, message: `position.${k} must be a finite number.`, hint: 'Use canvas coordinates from the visual editor.' });
        }
    }
}

function topoOrder(nodes, edges) {
    const inDeg = new Map();
    const adj = new Map();
    for (const n of nodes) { inDeg.set(n, 0); adj.set(n, []); }
    for (const e of edges) {
        if (!adj.has(e.from)) { adj.set(e.from, []); inDeg.set(e.from, inDeg.get(e.from) || 0); }
        if (!inDeg.has(e.to)) { inDeg.set(e.to, 0); adj.set(e.to, []); }
        adj.get(e.from).push(e.to);
        inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1);
    }
    const q = [];
    for (const [k, v] of inDeg) if (v === 0) q.push(k);
    const order = [];
    while (q.length) {
        const cur = q.shift();
        order.push(cur);
        for (const next of (adj.get(cur) || [])) {
            inDeg.set(next, inDeg.get(next) - 1);
            if (inDeg.get(next) === 0) q.push(next);
        }
    }
    if (order.length !== inDeg.size) return null; // cycle
    return order;
}

/**
 * Gather every reference a value carries: binding wrappers at any depth
 * (`{kind:'ref'}` paths, the placeholders of `{kind:'template'}`, the source
 * of `{kind:'expr'}`). Placeholders are found with the runner's quote-aware
 * scanner, so `{{ x["a}b"] }}` is one placeholder here exactly as at run time.
 *
 * Each entry says WHERE it was found (`where`, a dotted field path below the
 * value, `''` for the value itself) so a finding can name the field:
 *   { kind: 'ref', path, where, template? }   { kind: 'expr', src, where, binding }
 * Callers that only read `kind`/`path`/`src` see the same shape as before.
 * @param {string} [where]
 */
function collectRefPaths(value, out, where = '') {
    if (value == null) return;
    if (Array.isArray(value)) { value.forEach((v, i) => collectRefPaths(v, out, `${where}[${i}]`)); return; }
    if (typeof value !== 'object') return;
    if (typeof value.kind === 'string') {
        if (value.kind === 'ref' && typeof value.path === 'string') out.push({ kind: 'ref', path: value.path, where });
        if (value.kind === 'template' && typeof value.value === 'string') {
            for (const inner of templateRefs(value.value)) out.push({ kind: 'ref', path: inner, where, template: true });
        }
        if (value.kind === 'expr' && typeof value.value === 'string') {
            out.push({ kind: 'expr', src: value.value, where, binding: true });
        }
        // literal: nothing
        return;
    }
    for (const k of Object.keys(value)) collectRefPaths(value[k], out, where ? `${where}.${k}` : k);
}

/**
 * Collect `kind:'literal'` string values that contain `{{…}}` placeholders.
 * Only `kind:'template'` values are interpolated at runtime (see bind.js), so
 * a literal carrying `{{…}}` ships the braces verbatim — almost always a
 * mistake. Pushes the offending strings onto `out`.
 */
function collectLiteralBraces(value, out) {
    if (value == null) return;
    if (Array.isArray(value)) { value.forEach(v => collectLiteralBraces(v, out)); return; }
    if (typeof value !== 'object') return;
    if (typeof value.kind === 'string') {
        if (value.kind === 'literal' && typeof value.value === 'string' && hasPlaceholder(value.value)) {
            out.push(value.value);
        }
        return;
    }
    for (const k of Object.keys(value)) collectLiteralBraces(value[k], out);
}

/**
 * The root of a reference path (`steps`, `trigger`, …), read by the runner's grammar.
 * @param {string} path
 */
function rootOf(path) {
    return refHead(String(path)).root;
}

/**
 * The key after the root — the step id of `steps.<id>` AND of `steps["<id>"]`
 * (the bracket form must not read as "no step id"), the item variable of
 * `loop.<var>`. Read from the longest valid head, so a path with a broken
 * tail still names its step.
 */
function secondSegment(path) {
    return refHead(String(path)).second;
}

module.exports = {
    isObject,
    validatePosition,
    topoOrder,
    collectRefPaths,
    collectLiteralBraces,
    rootOf,
    secondSegment,
};

/**
 * @typedef {Record<string, any>} StepDef  one step (or trigger) of a stored definition: JSON authored by a person or an LLM
 * @typedef {Record<string, any>} GraphDoc  the root definition or a layer/Step mini-definition, as stored
 * @typedef {(finding: Finding) => void} PushFinding  a finding sink (pushE / pushW)
 * @typedef {Record<string, { title?: string, params?: Array<{ name?: string, required?: boolean }> }>} AvailableBlocks  the callable-Steps catalog, by block id
 * @typedef {Record<string, { trigger?: { params?: Array<{ name?: string, required?: boolean }> } }>} LayersMap  the `layers` of a definition, by key
 * @typedef ValidateCatalogs  the optional catalogs a caller hands the validator (see validateDefinition)
 * @property {Set<string> | null} [availableTools]
 * @property {Record<string, string[]> | null} [toolRequiredParams]
 * @property {Record<string, Set<string>> | null} [deliverableEvents]
 * @property {AvailableBlocks | null} [availableBlocks]
 * @property {Set<string> | null} [knownConnectionIds]
 * @property {Set<string> | null} [knownVarNames]
 * @property {Set<string> | null} [availableAgents]
 * @property {boolean | null} [topicClassifier]
 * @typedef {ValidateCatalogs & { scope?: string, stage?: string }} ValidateOptions  the options of validateDefinition
 * @typedef GraphCtx  what validateGraph hands to every rule group of one graph
 * @property {GraphDoc} graph
 * @property {string} pathPrefix
 * @property {string} scope
 * @property {(s: string) => string} p  prefixes a path with the graph's own prefix
 * @property {PushFinding} pushE
 * @property {PushFinding} pushW
 * @property {boolean} isContractScope
 * @property {string} contractNoun
 * @property {StepDef} trigger
 * @property {typeof import('./stepRules').checkPinnedOutput} checkPinnedOutput
 * @property {typeof import('./stepRules').createStepChecker} createStepChecker
 */

/**
 * @typedef {{ code: string, severity: string, path: string, message: string, hint?: string, ref?: string, kind?: string, targetRef?: Record<string, any> }} Finding  one validation finding
 * @typedef {string | number | boolean | null | undefined | Json[] | { [key: string]: Json }} Json  loose JSON, as a definition is stored
 * @typedef {{ kind: string, path?: string, src?: string, where: string, template?: boolean, binding?: boolean, host?: string, parse?: boolean }} RefEntry  one reference found by collectRefPaths
 */
