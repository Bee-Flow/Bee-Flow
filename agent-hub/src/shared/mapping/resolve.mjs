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
 *
 * A value a binding did not get is reported through the injected
 * `onWarning`: a ref that resolves to undefined, an expr that resolves to
 * undefined, an expr that throws. The value itself is unchanged (undefined,
 * as it always was); only the silence is gone. bind.js turns each report into
 * a run warning.
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
 * @param {(warning: object, runState: object) => void} [deps.onWarning] —
 *   called when a ref or expr gives no value: `{code:'missing', kind:'ref',
 *   path}`, `{code:'missing', kind:'expr', expr}` or `{code:'expr_error',
 *   kind:'expr', expr, message}`, plus `input` (the key in resolveInputs).
 *   Not called for a call made with `opts.silent`.
 */
export function createLegacyResolver({ evaluate, onUnresolved, onWarning } = {}) {
    if (typeof evaluate !== 'function') throw new TypeError('createLegacyResolver needs an evaluate function');

    function warn(warning, runState, opts) {
        if (typeof onWarning !== 'function' || opts.silent) return;
        onWarning(opts.input === undefined ? warning : { ...warning, input: opts.input }, runState);
    }

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
     * @param {boolean} [opts.silent] — report no warnings (see onWarning).
     * @param {string} [opts.input] — the input this binding fills, for warnings.
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
            case 'ref': {
                const value = walkPath(binding.path, safeState);
                if (value === undefined) warn({ code: 'missing', kind: 'ref', path: String(binding.path ?? '') }, runState, opts);
                return value;
            }
            case 'template':
                return interpolateTemplate(binding.value || '', safeState);
            case 'expr': {
                let value;
                try { value = evaluate(binding.value, safeState); }
                catch (e) {
                    warn({ code: 'expr_error', kind: 'expr', expr: String(binding.value ?? ''), message: (e && e.message) || String(e) }, runState, opts);
                    return undefined;
                }
                if (value === undefined) warn({ code: 'missing', kind: 'expr', expr: String(binding.value ?? '') }, runState, opts);
                return value;
            }
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
        for (const k of Object.keys(inputs)) out[k] = resolveValue(inputs[k], runState, opts.input === undefined ? { ...opts, input: k } : opts);
        return out;
    }

    return { resolveValue, resolveDeep, resolveInputs, interpolateTemplate };
}
