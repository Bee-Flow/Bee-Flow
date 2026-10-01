/**
 * Binding resolution for automation step inputs.
 *
 * Each step input is one of:
 *   { kind: 'literal',  value: <any> }
 *   { kind: 'ref',      path:  'steps.s1.output.items[0].subject' }
 *   { kind: 'template', value: 'Found {{steps.s1.output.count}} invoices' }
 *   { kind: 'expr',     value: 'steps.s1.output.amount > 1000 ? "high" : "low"' }
 *   { kind: 'pick',     v: 1, from: <Source>, take, as, join?, label? }
 *   { kind: 'compose',  v: 1, parts: ['Beste ', { from, take, as }, …] }
 *
 * The four legacy kinds resolve exactly as they always have (legacy.mjs,
 * pinned by corpus.mjs). pick and compose are the v2 mapping (intent.mjs,
 * fit.mjs, render.mjs): where the value comes from as data, and what the
 * user chose to do with it, carried out on whatever shape the run holds.
 * They are recognised ONLY when `v === 1` and the structure validates
 * (validate.mjs isPick / isCompose): a stored literal object that happens
 * to carry `kind: 'pick'` is still a literal, as it was before v2 existed.
 *
 * Bare values (numbers/strings/booleans/arrays/objects without a `kind` field)
 * are treated as literals — this is a tolerance for hand-authored definitions
 * and AI-generated bindings that skip the wrapper.
 *
 * Roots available in runState:
 *   trigger.output, steps.<id>.output, loop.<itemVar>, vars, secrets
 *   (`secrets` is hidden unless the caller passes allowSecrets; a pick has
 *   no secrets root at all). Two more are read by picks: `_mappingScope`
 *   ({ over, item, index }, the item a repeated step runs for; see
 *   execRepeat.js) and `_mappingMemo` (a Map the run keeps so a JSON text is
 *   parsed once; see walk.mjs).
 *
 * The expression engine and the number/date readers are INJECTED rather than
 * imported: this directory is copied byte for byte to agent-hub and to
 * mobile's vendor/, and a relative import of ../expr would point somewhere
 * else in each copy. bind.js passes the server's evaluate and parse; a
 * preview passes its own copy of the same engine.
 *
 * A value a binding did not get is reported through the injected
 * `onWarning`: a ref that resolves to undefined, an expr that resolves to
 * undefined, an expr that throws, and for picks every code fit.mjs reports.
 * The value of a legacy binding is unchanged (undefined, as it always was);
 * only the silence is gone. bind.js turns each report into a run warning.
 */

import { cloneLiteral, interpolateTemplate as interpolate, walkPath } from './legacy.mjs';
import { isPrefix } from './source.mjs';
import { walkMany, walkSource } from './walk.mjs';
import { fit } from './fit.mjs';
import { renderCompose } from './render.mjs';
import { MAPPING_VERSION } from './intent.mjs';
import { describeSource, isCompose, isPick } from './validate.mjs';

const LEGACY_KINDS = ['literal', 'ref', 'template', 'expr'];

/**
 * Build the resolver around an expression engine.
 *
 * @param {object} deps
 * @param {(src: string, scope: object) => unknown} deps.evaluate — the
 *   restricted expression evaluator (shared/expr); it may throw, an `expr`
 *   binding that throws resolves to undefined.
 * @param {{ parseLocaleNumber?: Function, parseDate?: Function }} [deps.parse]
 *   — shared/expr/parse.mjs, for picks `as: 'number'` and `as: 'date'`.
 * @param {(path: string) => void} [deps.onUnresolved] — called for every
 *   `{{ path }}` that resolves to undefined (after it is recorded on
 *   `runState._templateWarnings`).
 * @param {(warning: object, runState: object) => void} [deps.onWarning] —
 *   called when a binding gives no (or a doubtful) value: `{code:'missing',
 *   kind:'ref', path}`, `{code:'missing', kind:'expr', expr}`,
 *   `{code:'expr_error', kind:'expr', expr, message}`, and for a pick or a
 *   compose part `{code, kind:'pick'|'compose', path, label?, count?}` with
 *   code missing, missing_required, many_for_one, holes_dropped,
 *   parse_failed, each_outside_repeat or mapping_invalid. Plus `input` (the
 *   key in resolveInputs). Not called for a call made with `opts.silent`.
 */
export function createResolver({ evaluate, parse, onUnresolved, onWarning } = {}) {
    if (typeof evaluate !== 'function') throw new TypeError('createResolver needs an evaluate function');

    function warn(warning, runState, opts) {
        if (typeof onWarning !== 'function' || opts.silent) return;
        onWarning(opts.input === undefined ? warning : { ...warning, input: opts.input }, runState);
    }

    function isRequired(pick, opts) {
        if (pick.required === true) return true;
        const req = opts.required;
        if (opts.input === undefined || !req) return false;
        return req instanceof Set ? req.has(opts.input) : Array.isArray(req) && req.includes(opts.input);
    }

    /**
     * One pick (or compose part), carried out. `kind` names what a warning
     * comes from: the pick itself, or the compose it is a part of.
     */
    function resolvePick(pick, runState, opts, kind) {
        const memo = runState && runState._mappingMemo instanceof Map ? runState._mappingMemo : undefined;
        const report = { kind, path: describeSource(pick.from), ...(typeof pick.label === 'string' && pick.label ? { label: pick.label } : {}) };
        let result;
        let take = pick.take;
        if (take === 'each') {
            const scope = runState && runState._mappingScope;
            if (!scope || !isPrefix(scope.over, pick.from)) {
                warn({ code: 'each_outside_repeat', ...report }, runState, opts);
                return fit(undefined, { take: 'one', as: pick.as, join: pick.join }, { parse }).value;
            }
            result = walkMany(scope.item, pick.from.path.slice(scope.over.path.length), { memo });
            // Inside one item: a list there is all of it for a text or a list
            // field, and one value for any other.
            take = pick.as === 'list' || pick.as === 'text' ? 'all' : 'one';
        } else {
            result = walkSource(pick.from, runState, { memo });
        }
        const { value, warnings } = fit(result, { take, as: pick.as, join: pick.join }, { parse });
        for (const w of warnings) {
            const code = w.code === 'missing' && isRequired(pick, opts) ? 'missing_required' : w.code;
            warn({ ...w, code, ...report }, runState, opts);
        }
        return value;
    }

    function resolveCompose(compose, runState, opts) {
        return renderCompose(compose, (part) => resolvePick(part, runState, opts, 'compose'));
    }

    /**
     * Render a text field: a `{{ }}` template string (legacy.mjs, unchanged)
     * or a compose binding. Every executor renders its text fields through
     * this, so a compose works wherever a template string did.
     */
    function interpolateTemplate(template, runState, opts = {}) {
        if (isCompose(template)) return resolveCompose(template, runState, opts);
        // A compose that does not validate renders as nothing, not as the
        // "[object Object]" String() would make of it.
        if (template !== null && typeof template === 'object' && template.kind === 'compose') {
            if (template.v === MAPPING_VERSION) warn({ code: 'mapping_invalid', kind: 'compose', path: '' }, runState, opts);
            return '';
        }
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
     * @param {string[]|Set<string>} [opts.required] — inputs that must get a
     *   value: a pick that gives none there reports missing_required.
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
                return interpolate(binding.value || '', safeState, {}, onUnresolved);
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
            case 'pick':
            case 'compose':
                if (isPick(binding)) return resolvePick(binding, runState, opts, 'pick');
                if (isCompose(binding)) return resolveCompose(binding, runState, opts);
                // A pick or compose that does not validate is what any other
                // unknown kind has always been: no value. Only one that says it
                // is v2 (v: 1) is worth a warning; an older stored object with
                // this kind is left as quiet as it always was.
                if (binding.v === MAPPING_VERSION) warn({ code: 'mapping_invalid', kind: binding.kind, path: describeSource(binding.from) }, runState, opts);
                return undefined;
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
            // If this object is itself a binding wrapper, resolve it. A pick or
            // a compose only when it is a valid one: anything else with that
            // kind is a literal object, resolved member by member as before.
            if (typeof structure.kind === 'string'
                && (LEGACY_KINDS.includes(structure.kind) || isPick(structure) || isCompose(structure))) {
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
     * Every key stays, with the value undefined when its binding gives none,
     * whatever the binding's kind. A pick must not differ from the legacy ref
     * it replaces here: in a datatable's `values` a key with undefined writes
     * NULL on save_row and a missing key leaves the column as it was, so a
     * dropped key would make an upgraded routine write differently from the
     * one the upgrade checked it against (upgrade.mjs compares resolveValue).
     */
    function resolveInputs(inputs, runState, opts = {}) {
        if (!inputs || typeof inputs !== 'object') return {};
        const out = {};
        for (const k of Object.keys(inputs)) {
            out[k] = resolveValue(inputs[k], runState, opts.input === undefined ? { ...opts, input: k } : opts);
        }
        return out;
    }

    return { resolveValue, resolveDeep, resolveInputs, interpolateTemplate };
}

/**
 * The name the resolver had while it only knew the four legacy kinds. Kept so
 * every caller (bind.js, the previews, the corpus tests) keeps working.
 */
export const createLegacyResolver = createResolver;
