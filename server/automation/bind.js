/**
 * Binding resolver for automation step inputs.
 *
 * Each step input is one of:
 *   { kind: 'literal',  value: <any> }
 *   { kind: 'ref',      path:  'steps.s1.output.items[0].subject' }
 *   { kind: 'template', value: 'Found {{steps.s1.output.count}} invoices' }
 *   { kind: 'expr',     value: 'steps.s1.output.amount > 1000 ? "high" : "low"' }
 *   { kind: 'pick',     v: 1, from: <Source>, take, as, join?, label? }
 *   { kind: 'compose',  v: 1, parts: [...] }      (text fields too)
 *
 * The implementation lives in the SHARED, isomorphic module `shared/mapping/`
 * (legacy.mjs: the path grammar and walker; resolve.mjs: every kind), so
 * the runtime and the builder previews on the web and the phone resolve a
 * path identically. A golden corpus (shared/mapping/corpus.mjs), recorded
 * from this file before the code moved, pins all three. This file is a thin
 * CommonJS facade with the same exports as before, so every caller keeps
 * `const { resolveInputs, interpolateTemplate, ... } = require('./bind')`.
 *
 * It adds the server-only pieces the shared module cannot import: the
 * expression engine (./expr, for `expr` bindings), the number and date
 * readers (shared/expr/parse.mjs, for picks `as: 'number' | 'date'`), the
 * debug log on a path that resolves to undefined
 * (`AUTOMATION_DEBUG_BINDINGS=1`), and the run warning for a binding that
 * gave no value or a doubtful one (bindingRunWarning).
 *
 * Requires Node >= 22.12 for require(ESM), like automation/expr.js.
 */

const { evaluate } = require('./expr');
const log = require('../telemetry/log');
const mapping = require('../shared/mapping/index.mjs');
const parse = require('../shared/expr/parse.mjs');
const { runWarning, pushRunWarning } = require('../core/automationRunner/runWarnings');

const MAX_EXPR_IN_WARNING = 80;

const AS_WORD = { number: 'number', date: 'date', yesno: 'yes or no' };

/**
 * What a pick warning names: the label the user saw on the chip, else the
 * path it reads. Never a value from the run.
 */
function pickName(w) {
    return w.label ? `"${w.label}"` : (w.path || 'a mapped value');
}

function pickWarningText(w) {
    const who = pickName(w);
    switch (w.code) {
        case 'missing': return `${who} was empty`;
        case 'missing_required': return `${who} was empty, and the step needs it`;
        case 'many_for_one': return `${who} held ${w.count} values; only the first was used`;
        case 'holes_dropped': return `${who}: ${w.count} item(s) without this field were left out`;
        case 'parse_failed': return `${who} could not be read as a ${AS_WORD[w.as] || w.as}`;
        case 'each_outside_repeat': return `${who} reads the current item, but this step does not repeat over that list`;
        case 'mapping_invalid': return `a ${w.kind} binding${w.path ? ` on ${w.path}` : ''} is not valid and gave no value`;
        default: return `${who}: ${w.code}`;
    }
}

/**
 * The run warning for a binding that gave no value (or a doubtful one). A
 * template has always put the bare path it missed on
 * `runState._templateWarnings`; a ref or an expr said nothing, so a tool
 * received a missing argument and the run never said why. This names the
 * input, and the label, the path or the expression, never a value.
 */
function bindingWarningText(w) {
    const where = w.input === undefined ? '' : `input "${w.input}": `;
    if (w.kind === 'pick' || w.kind === 'compose') return `${where}${pickWarningText(w)}`;
    if (w.kind === 'ref') return `${where}${w.path || '(empty path)'} resolved to nothing`;
    const src = w.expr.length > MAX_EXPR_IN_WARNING ? `${w.expr.slice(0, MAX_EXPR_IN_WARNING)}…` : w.expr;
    return w.code === 'expr_error'
        ? `${where}expression "${src}" failed: ${w.message}`
        : `${where}expression "${src}" resolved to nothing`;
}

/**
 * The run warning (runWarnings.js, `{ code, params, text }`) for a
 * BindingWarning: a code per kind of miss, the params the run view words it
 * with, and bindingWarningText as the English fallback.
 *
 *   ref_missing        input, path
 *   expr_missing       input, expr
 *   expr_error         input, expr, message
 *   mapping_invalid    input, kind, path
 *   pick_<code>        input, label, path, count, as (pick and compose part)
 */
function bindingRunWarning(w) {
    const text = bindingWarningText(w);
    const input = w.input === undefined ? undefined : String(w.input);
    if (w.kind === 'ref') return runWarning('ref_missing', { input, path: w.path || '' }, text);
    if (w.kind === 'expr') {
        const expr = w.expr.length > MAX_EXPR_IN_WARNING ? `${w.expr.slice(0, MAX_EXPR_IN_WARNING)}…` : w.expr;
        return w.code === 'expr_error'
            ? runWarning('expr_error', { input, expr, message: w.message }, text)
            : runWarning('expr_missing', { input, expr }, text);
    }
    if (w.code === 'mapping_invalid') return runWarning('mapping_invalid', { input, kind: w.kind, path: w.path }, text);
    return runWarning(`pick_${w.code}`, { input, label: w.label, path: w.path, count: w.count, as: w.as }, text);
}

const { resolveValue, resolveDeep, resolveInputs, interpolateTemplate } = mapping.createResolver({
    evaluate,
    parse,
    onUnresolved(path) {
        if (process.env.AUTOMATION_DEBUG_BINDINGS) {
            log.warn(`[bind] template path "${path}" resolved to undefined`);
        }
    },
    onWarning(warning, runState) {
        const w = bindingRunWarning(warning);
        if (process.env.AUTOMATION_DEBUG_BINDINGS) log.warn(`[bind] ${w.text}`);
        // Once per binding: a fan-out or a list-mode set resolves the same
        // binding once per item.
        pushRunWarning(runState, w);
    },
});

/**
 * Is this a value a text field can hold: a `{{ }}` string, or a compose
 * binding? For the executors that check a field before rendering it.
 */
function isTextValue(v) {
    return typeof v === 'string' || mapping.isCompose(v);
}

module.exports = {
    resolveValue,
    resolveDeep,
    resolveInputs,
    walkPath: mapping.walkPath,
    walkRelativePath: mapping.walkRelativePath,
    interpolateTemplate,
    cloneLiteral: mapping.cloneLiteral,
    isTextValue,
    bindingWarningText,
    bindingRunWarning,
};
