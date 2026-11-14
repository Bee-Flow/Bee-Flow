// @typecheck strict
/**
 * The validator's refusal of ONE App Studio action, said back to the model
 * (actionNormalise.js repairs what it can before the validator runs): a
 * sentence per record, from a handler per validator code, plus every
 * mechanical fix the records name merged into one patch. A record whose code
 * has no handler adds nothing; with no sentence at all the answer is the
 * generic one.
 */

'use strict';

const { suggestTableId } = require('./tableHints');

const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

/**
 * @param {unknown} v
 * @returns {v is Record<string, any>}
 */
function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/**
 * @param {string} name
 */
function fieldBindingFromName(name) {
    return { kind: 'formula', expr: `form.${name}` };
}

/**
 * The value at a dotted path (`a.b[0].c`), or undefined.
 * @param {unknown} root
 * @param {unknown} path
 * @returns {unknown}
 */
function getAt(root, path) {
    if (!path) return root;
    const tokens = String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
    let cur = root;
    for (const t of tokens) {
        if (cur === null || cur === undefined) return undefined;
        cur = /** @type {Record<string, unknown>} */ (cur)[t];
    }
    return cur;
}

/** @param {{ hint?: unknown } | null | undefined} record */
function didYouMean(record) {
    const m = /Did you mean "([^"]+)"/.exec(String(record && record.hint || ''));
    return m ? m[1] : null;
}

const CREATE_RECIPE = 'create_record takes only tableId, values, resultVar. To save a form: {kind:"sequence", steps:[{kind:"create_record", tableId, values:{<fieldKey>:{kind:"formula",expr:"form.<inputName>"}}}, {kind:"refresh", tableId}, {kind:"toast", message}]}, then app_bind_action {nodeId:<form id>, event:"onSubmit", actionId}.';

/**
 * @typedef {{ code?: unknown, path?: unknown, message?: unknown, hint?: unknown }} ValidatorRecord
 * @typedef {{ id: string, key?: string, name?: string, fields?: Array<{ key: string }> }} AppTable
 * @typedef {{ op: string, path?: string, from?: string, to?: string, value?: unknown }} PatchOp
 * @typedef {{ e: ValidatorRecord, code: string, path: string, action: unknown, tableList: AppTable[],
 *   reasons: string[], ops: PatchOp[] }} RefusalCtx
 * @typedef {(ctx: RefusalCtx) => void} RefusalHandler
 */

/** @param {unknown} s */
const sentence = (s) => String(s || '').replace(/\.$/, '');

/** @type {RefusalHandler} */
function unknownTable({ e, path, action, tableList, reasons, ops }) {
    const m = /references table "([^"]+)"/.exec(String(e.message || ''));
    const bad = m ? m[1] : getAt(action, path.replace(/^action\.?/, ''));
    const dym = didYouMean(e) || (suggestTableId(/** @type {string} */ (bad), tableList) || {}).table?.id || null;
    reasons.push(`table ${JSON.stringify(bad)} is not in the app${tableList.length === 0 ? ' (it has no tables yet)' : ''}. ${dym ? `Did you mean "${dym}"? ` : ''}Create it first with app_upsert_table {name, fields:[{key,type}]} — or link an existing Studio table with app_link_datatable {name} — and use the tbl_ id from the result; never invent a tbl_ id. Then resend this action unchanged`);
    if (dym) ops.push({ op: 'set', path, value: dym });
}

/** @type {RefusalHandler} */
function unknownField({ e, path, tableList, reasons, ops }) {
    const dym = didYouMean(e);
    const m = /field "([^"]+)" which is not on table "([^"]+)"/.exec(String(e.message || ''));
    const table = m ? tableList.find((t) => t && (t.id === m[2] || t.key === m[2])) : null;
    const keys = table ? (table.fields || []).map((f) => f.key).join(', ') : '';
    reasons.push(`${path} names a field the table does not have${keys ? ` (its keys: ${keys})` : ''}${dym ? ` — did you mean "${dym}"` : ''}`);
    if (dym && /\.values\.[^.]+$/.test(path)) ops.push({ op: 'move', from: path, to: path.replace(/\.values\.[^.]+$/, `.values.${dym}`) });
}

/** @type {RefusalHandler} */
function invalidBinding({ code, path, action, reasons, ops }) {
    const bindingPath = code === 'binding.kind_invalid' ? path.replace(/\.kind$/, '') : path;
    const current = getAt(action, bindingPath.replace(/^action\.?/, ''));
    const name = isObject(current) && typeof current.name === 'string' && IDENT_RE.test(current.name) ? current.name : null;
    reasons.push(`${bindingPath} must be a binding object: {kind:"formula", expr:"form.<inputName>"} for a submitted value, or {kind:"static", value}`);
    if (name) ops.push({ op: 'set', path: bindingPath, value: fieldBindingFromName(name) });
}

/** @type {RefusalHandler} */
function unknownActionField({ e, reasons }) {
    reasons.push(`${sentence(e.message)}. ${CREATE_RECIPE}`);
}

/** @type {RefusalHandler} */
function requiredStepField({ e, path, action, tableList, reasons }) {
    const m = /missing required `([^`]+)`/.exec(String(e.message || ''));
    const tableId = getAt(action, 'tableId');
    const table = tableList.find((t) => t && t.id === tableId);
    const keys = table ? (table.fields || []).map((f) => f.key).join(', ') : '';
    reasons.push(`${path} is missing ${m ? `\`${m[1]}\`` : 'a required field'}${m && m[1] === 'values' ? ` — values: {<fieldKey>: binding}${keys ? `, keys of ${table && table.key}: ${keys}` : ''}` : ''}`);
}

/** @type {RefusalHandler} */
function navigateMissing({ path, reasons }) {
    reasons.push(`${path.replace(/\.screenId$/, '')} (navigate) needs screenId at the top level — {kind:"navigate", screenId:"scr_…", params:{…}} — with a scr_ id from the draft state, never a guessed one`);
}

/** @type {RefusalHandler} */
function approvalStagesInvalid({ e, path, reasons }) {
    reasons.push(`${path}: ${sentence(e.message)} — a stage is {key, name, approvers:[{userId:"…"}|{groupId:"…"}], rule:"first"|"all"|"quorum"}`);
}

/** @type {RefusalHandler} */
function approvalHookInvalid({ e, path, reasons }) {
    reasons.push(`${path}: ${sentence(e.message)} — onDecided is {tableId:"tbl_…", recordId:{kind:"formula", expr:"screen.params.recordId"}, set:{approved:{<statusKey>:"…"}, rejected:{<statusKey>:"…"}}}`);
}

/** @type {RefusalHandler} */
function navigateUnresolved({ e, path, reasons, ops }) {
    const dym = didYouMean(e);
    reasons.push(`${path} navigates to a screen the app does not have${dym ? ` — did you mean "${dym}"` : ''}; use a scr_ id from the draft state`);
    if (dym) ops.push({ op: 'set', path, value: dym });
}

/** Validator code to its handler, for the codes matched exactly. */
const HANDLERS = new Map(Object.entries({
    'binding.kind_invalid': invalidBinding,
    'binding.invalid': invalidBinding,
    'action.unknown_field': unknownActionField,
    'action.step_unknown_field': unknownActionField,
    'action.step_field_required': requiredStepField,
    'action.navigate_missing': navigateMissing,
    'action.approval_stages_invalid': approvalStagesInvalid,
    'action.approval_hook_invalid': approvalHookInvalid,
    'action.navigate_unresolved': navigateUnresolved,
    'action.step_navigate_unresolved': navigateUnresolved,
    'action.effects_navigate_unresolved': navigateUnresolved,
}));

/**
 * The handler for a validator code: any `*.unknown_table`, a step or binding
 * `unknown_field`, else the exact code's.
 * @param {string} code
 * @returns {RefusalHandler | undefined}
 */
function handlerFor(code) {
    if (/\.unknown_table$/.test(code)) return unknownTable;
    if (/^(step|binding)\.unknown_field$/.test(code)) return unknownField;
    return HANDLERS.get(code);
}

/**
 * The validator's records for ONE action → { _fixHint, _suggestedPatch? }.
 * Paths are rewritten `actions.<id>.X` → `action.X` (the patch path in the
 * single form). Each record adds its sentence; every mechanical fix is
 * merged into one patch.
 * @param {unknown} errors  the validator's records
 * @param {{ actionId?: string, action?: Record<string, unknown>, tables?: AppTable[] }} [opts]
 */
function describeActionRefusal(errors, { actionId, action, tables } = {}) {
    /** @type {ValidatorRecord[]} */
    const list = Array.isArray(errors) ? errors.filter(Boolean) : [];
    const rel = (/** @type {unknown} */ p) => String(p || '').replace(`actions.${actionId}`, 'action');
    /** @type {PatchOp[]} */
    const ops = [];
    /** @type {string[]} */
    const reasons = [];
    const tableList = Array.isArray(tables) ? tables : [];

    for (const e of list) {
        const code = String(e.code || '');
        const handler = handlerFor(code);
        if (handler) handler({ e, code, path: rel(e.path), action, tableList, reasons, ops });
    }
    const _fixHint = reasons.length
        ? `Reject reason: ${[...new Set(reasons)].join(' | ')}.`
        : 'Fix the fields the errors name and call app_set_action again with the whole action.';
    /** @type {{ _fixHint: string, _suggestedPatch?: { ops: PatchOp[], why: string } }} */
    const out = { _fixHint };
    if (ops.length) out._suggestedPatch = { ops, why: 'the validator named the exact fix' };
    return out;
}

module.exports = { describeActionRefusal, CREATE_RECIPE, getAt, isObject, fieldBindingFromName, IDENT_RE };
