// @typecheck strict
'use strict';

const { scanTemplate } = require('../expr');
const { normalizeAiPath } = require('./aiPaths');

/**
 * Every `loop.<var>` a set of canonical bindings reads — ref paths and the
 * {{…}} placeholders inside templates — with the var name.
 */
function loopVarsReadBy(/** @type {LoopVal} */ value, /** @type {{ v: string, path: string }[]} */ out = [], depth = 0) {
    if (depth > 12 || value === null || value === undefined) return out;
    if (Array.isArray(value)) { for (const v of value) loopVarsReadBy(v, out, depth + 1); return out; }
    if (typeof value === 'string') {
        const t = normalizeAiPath(value, { trimDebris: false }).tokens;
        if (t && t[0].key === 'loop' && t[1] && t[1].type === 'prop') out.push({ v: String(t[1].key), path: value.trim() });
        return out;
    }
    if (typeof value !== 'object') return out;
    if (value.kind === 'ref' && typeof value.path === 'string') return loopVarsReadBy(value.path, out, depth + 1);
    if (value.kind === 'template' && typeof value.value === 'string') {
        for (const p of scanTemplate(value.value)) if (p.type === 'ref') loopVarsReadBy(p.inner, out, depth + 1);
        return out;
    }
    if (value.kind === 'literal' || value.kind === 'expr') return out;
    for (const v of Object.values(value)) loopVarsReadBy(v, out, depth + 1);
    return out;
}

module.exports = { loopVarsReadBy };

/** @typedef {string | number | boolean | null | undefined | LoopVal[] | { kind?: string, path?: string, value?: LoopVal, [k: string]: LoopVal }} LoopVal */
