/**
 * Binding resolution for automation step inputs: the four legacy kinds.
 *
 * Each step input is one of:
 *   { kind: 'literal',  value: <any> }
 *   { kind: 'ref',      path:  'steps.s1.output.items[0].subject' }
 *   { kind: 'template', value: 'Found {{steps.s1.output.count}} invoices' }
 *   { kind: 'expr',     value: 'steps.s1.output.amount > 1000 ? "high" : "low"' }
 *
 * Bare values (numbers/strings/booleans/arrays/objects without a `kind` field)
 * are treated as literals — this is a tolerance for hand-authored definitions
 * and AI-generated bindings that skip the wrapper.
 *
 * Roots available in runState:
 *   trigger.output, steps.<id>.output, loop.<itemVar>, vars, secrets
 *   (`secrets` is hidden unless the caller passes allowSecrets.)
 *
 * The expression engine is INJECTED rather than imported: this directory is
 * copied byte for byte to agent-hub and to mobile's vendor/, and a relative
 * import of ../expr would point somewhere else in each copy. bind.js passes
 * the server's evaluate; a preview passes its own copy of the same engine.
 */

import { cloneLiteral, interpolateTemplate as interpolate, walkPath } from './legacy.mjs';

const LEGACY_KINDS = ['literal', 'ref', 'template', 'expr'];

/**
 * Build the resolver around an expression engine.
 *
 * @param {object} deps
 * @param {(src: string, scope: object) => unknown} deps.evaluate — the
 *   restricted expression evaluator (shared/expr); it may throw, an `expr`
 *   binding that throws resolves to undefined.
 * @param {(path: string) => void} [deps.onUnresolved] — called for every
 *   `{{ path }}` that resolves to undefined (after it is recorded on
 *   `runState._templateWarnings`).
 */
export function createLegacyResolver({ evaluate, onUnresolved } = {}) {
    if (typeof evaluate !== 'function') throw new TypeError('createLegacyResolver needs an evaluate function');

    function interpolateTemplate(template, runState, opts = {}) {
        return interpolate(template, runState, opts, onUnresolved);
    }

    /**
     * Resolve a single binding object against the runState.
     * @param {*} binding — { kind, ... } or a raw literal
     * @param {object} runState — { trigger, steps, loop, vars, secrets }
     * @param {object} opts
     * @param {boolean} opts.allowSecrets — when false, secrets root is replaced
     *                  with an empty object so user-visible templates can't
     *                  echo secrets back to the chat or notification body.
     */
    function resolveValue(binding, runState, opts = {}) {
        const { allowSecrets = false } = opts;
        const safeState = allowSecrets ? runState : { ...runState, secrets: {} };

        if (binding == null || typeof binding !== 'object' || Array.isArray(binding) || !binding.kind) {
            // Bare literal — but recursively resolve nested objects/arrays so
            // hand-built inputs like { to: 'a@b', body: { kind: 'ref', ... } }
            // still work.
            return resolveDeep(binding, runState, opts);
        }

        switch (binding.kind) {
            case 'literal':
                return cloneLiteral(binding.value);
            case 'ref':
                return walkPath(binding.path, safeState);
            case 'template':
                return interpolateTemplate(binding.value || '', safeState);
            case 'expr':
                try { return evaluate(binding.value, safeState); }
                catch { return undefined; }
            default:
                return undefined;
        }
    }

    /**
     * Resolve every binding inside a structure (objects, arrays).
     */
    function resolveDeep(structure, runState, opts = {}) {
        if (structure == null) return structure;
        if (Array.isArray(structure)) return structure.map(s => resolveDeep(s, runState, opts));
        if (typeof structure === 'object') {
            // If this object is itself a binding wrapper, resolve it.
            if (typeof structure.kind === 'string' && LEGACY_KINDS.includes(structure.kind)) {
                return resolveValue(structure, runState, opts);
            }
            const out = {};
            for (const k of Object.keys(structure)) out[k] = resolveDeep(structure[k], runState, opts);
            return out;
        }
        return structure;
    }

    /**
     * Resolve a step's `inputs` map. Returns plain object with concrete values.
     */
    function resolveInputs(inputs, runState, opts = {}) {
        if (!inputs || typeof inputs !== 'object') return {};
        const out = {};
        for (const k of Object.keys(inputs)) out[k] = resolveValue(inputs[k], runState, opts);
        return out;
    }

    return { resolveValue, resolveDeep, resolveInputs, interpolateTemplate };
}
