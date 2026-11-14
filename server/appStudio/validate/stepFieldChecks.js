// @typecheck strict
/**
 * App Studio validator — one field of a step (or of an action validated per
 * field), against its STEP_SPECS / ACTION_SPECS field spec. actions.js runs
 * them: first the reference fields, which own their own null semantics, then
 * the required check, then the check for the field's type from the table
 * below (a type it does not list goes to aiReliability.mts).
 */

'use strict';

const { LIMITS, FORMULA_SCOPE_ROOTS } = require('../componentSpecs');
const { pickClosestId } = require('../../utils/closestId.mts');
const { isObject } = require('./shared');
const { validateFormula } = require('./formulas');
const {
    checkTableRef, checkTableSource, checkTableWritable, checkAutomationRef, checkModalRef,
    validateNavigateParams, validateInputMapping,
} = require('./refs');
const { validateBinding } = require('./bindings');
const { validateContextSources } = require('./contextSources.mts');
const { validateStepBranches } = require('./stepKindChecks');
const { validateCallParams } = require('./callChecks.mts');
const { validateTierChoice } = require('./tierChoice.mts');
const { validateEnvelopeField } = require('./stepEnvelope.mts');

/**
 * The step kinds that CHANGE ROWS — the only ones for which `mode:'read'` is an error and not
 * merely a property. The kinds flagged `writesRecords` in the step catalogue, not `mutatesData`: that flag is ALSO on
 * run_automation and request_approval, which do not write a `tableId` but CAN NAME one.
 */
const RECORD_WRITE_STEP_KINDS = new Set(require('../componentSpecs/stepRegistry').STEP_POLICY_LISTS.recordWriteKinds);

/**
 * @typedef {{ type: string, required?: boolean, nullable?: boolean, maxLen?: number, min?: number, max?: number,
 *   values?: unknown[], errorScope?: boolean }} FieldSpec
 * @typedef {{ n: number; reported: boolean; top?: unknown; }} StepCounter
 * @typedef {import('./shared').ValidationCtx} ValidateCtx
 * The walker of a nested step list (actions.js validateActionSteps); the envelope checks hand it their own ctx shape.
 * @typedef {(steps: unknown, path: string, depth: number, counter: StepCounter, ctx: any) => void} ValidateSteps
 * @typedef {{ kind: string, field: string, fs: FieldSpec, value: any, path: string, depth: number, counter: StepCounter,
 *   ctx: ValidateCtx, label: string, validateSteps: ValidateSteps }} FieldCheck
 * @typedef {Pick<FieldCheck, 'kind' | 'field' | 'fs' | 'value' | 'path' | 'ctx' | 'label'>} RefField
 */

/**
 * @param {FieldCheck} a
 * @param {string} message
 * @param {string} hint
 */
const invalid = ({ ctx, path }, message, hint) => ctx.pushE({ code: 'action.step_field_invalid', severity: 'error', path, message, hint });

/**
 * An optional tableId that was left out is not "unset", it is absent by
 * design (refresh with no table means "reload everything"); only the required
 * variants get the unset warning. A set one is checked three ways: the table
 * exists, its source (a linked Studio table) still exists, and a write step
 * may write there — each of these surfaced only when running otherwise.
 * @param {RefField} a
 */
function checkTableField({ kind, fs, value, path, ctx, label }) {
    if (!fs.required && (value === undefined || value === null)) return;
    checkTableRef(value, path, ctx, label, 'step');
    checkTableSource(value, path, ctx, label, { codePrefix: 'step' });
    if (RECORD_WRITE_STEP_KINDS.has(kind)) {
        checkTableWritable(value, path, ctx, label, { codePrefix: 'step' });
    }
}

/**
 * The cross-cutting reference fields own their own null/undefined semantics
 * (an unset table/automation is a soft warning, not a "required" error), so
 * they run BEFORE the generic missing/required check. Answers whether the
 * field was one of them.
 * @param {RefField} a
 */
function checkReferenceField(a) {
    const { field, value, path, ctx, label } = a;
    if (field === 'automationId') { checkAutomationRef(value, path, ctx, label); return true; }
    if (field === 'tableId') { checkTableField(a); return true; }
    if (field === 'modalId') { checkModalRef(value, path, ctx, label); return true; }
    if (field !== 'screenId') return false;
    if (typeof value !== 'string' || !ctx.screenIds.has(value)) {
        const suggestion = pickClosestId(value, Array.from(ctx.screenIds));
        ctx.pushE({ code: 'action.step_navigate_unresolved', severity: 'error', path, message: `${label} navigates to unknown screen ${JSON.stringify(value)}.`, hint: suggestion ? `Did you mean "${suggestion}"?` : 'Use a screen id from definition.screens.' });
    }
    return true;
}

/** @param {FieldCheck} a */
function checkString(a) {
    const { field, fs, value } = a;
    if (typeof value !== 'string') { invalid(a, `\`${field}\` must be a string.`, 'Pass a plain string.'); return; }
    if (fs.maxLen && value.length > fs.maxLen) invalid(a, `\`${field}\` is ${value.length} chars — the maximum is ${fs.maxLen}.`, 'Shorten it.');
    if (fs.type === 'url') {
        let ok = false; try { ok = new URL(value).protocol === 'https:'; } catch { ok = false; }
        if (!ok) invalid(a, `\`${field}\` must be an https:// URL.`, 'Only https URLs are allowed.');
    }
}

/** @param {FieldCheck} a */
function checkEnum(a) {
    const values = /** @type {unknown[]} */ (a.fs.values);
    if (!values.includes(a.value)) invalid(a, `\`${a.field}\` ${JSON.stringify(a.value)} is not legal.`, `Use one of: ${values.join(', ')}.`);
}

/** @param {FieldCheck} a */
function checkBoolean(a) {
    if (typeof a.value !== 'boolean') invalid(a, `\`${a.field}\` must be a boolean.`, 'Use true or false.');
}

/** @param {FieldCheck} a */
function checkInt(a) {
    const { field, fs, value } = a;
    const inRange = typeof value === 'number' && Number.isInteger(value) && !(fs.min !== undefined && value < fs.min) && !(fs.max !== undefined && value > fs.max);
    if (inRange) return;
    invalid(a, `\`${field}\` must be an integer${fs.min !== undefined ? ` ${fs.min}..${fs.max}` : ''}.`, field === 'maxIterations' ? `Loops are capped at ${LIMITS.MAX_ACTION_LOOP_ITERATIONS} iterations.` : 'Pass an integer.');
}

/** @param {FieldCheck} a */
function checkRecordValues(a) {
    if (!isObject(a.value)) { invalid(a, '`values` must be an object map of { column: binding }.', 'Use { col: {kind:"static",value} }.'); return; }
    for (const [col, b] of Object.entries(a.value)) validateBinding(col, b, `${a.path}.${col}`, a.ctx);
}

/**
 * A nested step list. `errorScope`: the list runs with a failure in scope (a
 * try's catch), so `error` has a value there.
 * @param {FieldCheck} a
 */
function checkSteps({ fs, value, path, depth, counter, ctx, validateSteps }) {
    validateSteps(value, path, depth + 1, counter, fs.errorScope ? { ...ctx, inErrorHandler: true } : ctx);
}

/** @param {FieldCheck} a */
function checkSwitchCases(a) {
    const { value, path, depth, counter, ctx, validateSteps } = a;
    if (!Array.isArray(value)) { invalid(a, 'switch `cases` must be an array.', 'Use [{ value, steps }].'); return; }
    value.forEach((c, i) => {
        if (!isObject(c)) { ctx.pushE({ code: 'action.step_field_invalid', severity: 'error', path: `${path}[${i}]`, message: 'Each switch case must be an object { value, steps }.', hint: 'Provide value + steps.' }); return; }
        validateSteps(c.steps, `${path}[${i}].steps`, depth + 1, counter, ctx);
    });
}

/** @param {FieldCheck} a */
function checkStringList(a) {
    const { field, value } = a;
    if (!Array.isArray(value)) { invalid(a, `\`${field}\` must be an array of strings.`, 'Pass a list of ids.'); return; }
    if (value.length > 50) { invalid(a, `\`${field}\` has too many entries (${value.length}; max 50).`, 'Remove some.'); return; }
    if (value.some((v) => typeof v !== 'string')) invalid(a, `\`${field}\` entries must all be strings.`, 'Use string ids.');
}

/** @param {FieldCheck} a */
const checkEnvelope = ({ fs, value, path, depth, counter, ctx, validateSteps }) => validateEnvelopeField(fs.type, value, path, { depth, counter, ctx, validateActionSteps: validateSteps });

/**
 * Field type to its check, for the types this module can check on its own
 * (actions.js adds the ones that need its own validators).
 * @type {ReadonlyArray<[string, (a: FieldCheck) => void]>}
 */
const FIELD_TYPE_CHECKS = [
    ['string', checkString],
    ['url', checkString],
    ['enum', checkEnum],
    ['boolean', checkBoolean],
    ['int', checkInt],
    ['formula', (a) => validateFormula(a.value, a.path, a.ctx, FORMULA_SCOPE_ROOTS)],
    ['binding', (a) => validateBinding(a.field, a.value, a.path, a.ctx)],
    ['inputMapping', (a) => validateInputMapping(`${a.kind}.${a.field}`, a.value, a.path, a.ctx)],
    ['recordValues', checkRecordValues],
    ['steps', checkSteps],
    ['switchCases', checkSwitchCases],
    ['stepBranches', (a) => validateStepBranches(a.value, a.path, (/** @type {unknown} */ list, /** @type {string} */ at) => a.validateSteps(list, at, a.depth + 1, a.counter, a.ctx), a.ctx)],
    ['navParams', (a) => validateNavigateParams(a.label, a.value, a.path, a.ctx)],
    ['stringList', checkStringList],
    ['contextSources', (a) => validateContextSources(a.field, a.value, a.path, /** @type {Parameters<typeof validateContextSources>[3]} */ (/** @type {unknown} */ (a.ctx)))],
    ['approvalQuestions', (a) => require('./approvalQuestionChecks.mts').validateApprovalQuestions(a.field, a.value, a.path, a.ctx)],
    // Checked by stepDataChecks.checkRecordTarget (it needs recordId next to it).
    ['recordFilter', () => {}],
    ['callParams', (a) => validateCallParams(a.field, a.value, a.path, a.ctx)],
    ['tierChoice', (a) => validateTierChoice(a.field, a.fs, a.value, a.path, /** @type {Parameters<typeof validateTierChoice>[4]} */ (/** @type {unknown} */ (a.ctx)))],
    ['errorHandler', checkEnvelope],
    ['retry', checkEnvelope],
];

/**
 * Any other type: temperature and an AI step's answer checks (schema v3),
 * aiReliability.mts, the automation ai_step's rules.
 * @param {FieldCheck} a
 */
const checkOtherType = (a) => require('../aiReliability.mts').validateReliabilityField(a.field, a.fs, a.value, a.path, a.ctx);

module.exports = { checkReferenceField, FIELD_TYPE_CHECKS, checkOtherType };
