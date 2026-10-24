/**
 * App Studio validator — definition.actions: the per-kind action checks and
 * the v2 sequence-step tree (STEP_SPECS fields, approvals, AI steps, loops
 * and the client/server partition).
 */

'use strict';

const {
    LIMITS,
    FORMULA_SCOPE_ROOTS,
    ACTION_KINDS,
    ACTION_SPECS,
    STEP_KINDS,
    STEP_SPECS,
    DATA_MUTATING_STEP_KINDS,
    AI_SCHEMA_FIELD_TYPES,
    TOAST_TONES,
} = require('../componentSpecs');
const { pickClosestId } = require('../../automation/validate/helpers');
const { isObject } = require('./shared');
const { validateFormula, checkServerFormulas } = require('./formulas');
const {
    checkTableRef,
    checkTableSource,
    checkTableWritable,
    checkFieldRef,
    checkAutomationRef,
    checkModalRef,
    validateNavigateParams,
    validateInputMapping,
} = require('./refs');
const { validateBinding } = require('./bindings');
const { containsSendEmail, KIND_CHECKS } = require('./stepKindChecks');
const { DATASET_QUERY_OUTPUTS, KIND_CHECKS: DATA_KIND_CHECKS } = require('./stepDataChecks');
const log = require('../../telemetry/log');

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function validateEffects(effects, path, ctx) {
    const { pushE, screenIds } = ctx;
    if (!isObject(effects)) {
        pushE({ code: 'action.effects_invalid', severity: 'error', path, message: 'Effects must be an object { toast?, navigateTo? }.', hint: 'Effects are bounded — they never chain into further actions.' });
        return;
    }
    const extra = Object.keys(effects).filter((k) => k !== 'toast' && k !== 'navigateTo');
    if (extra.length) pushE({ code: 'action.unknown_field', severity: 'error', path, message: `Effects has unknown fields: ${extra.join(', ')}.`, hint: 'Only { toast?, navigateTo? } are allowed.' });
    if (effects.toast !== undefined) {
        const t = effects.toast;
        if (!isObject(t) || typeof t.message !== 'string' || !t.message || t.message.length > ACTION_SPECS.toast.fields.message.maxLen) {
            pushE({ code: 'action.effects_toast_invalid', severity: 'error', path: `${path}.toast`, message: 'Effects toast needs a non-empty message of at most 500 chars.', hint: 'Use { message, tone? }.' });
        } else if (t.tone !== undefined && !TOAST_TONES.includes(t.tone)) {
            pushE({ code: 'action.toast_tone_invalid', severity: 'error', path: `${path}.toast.tone`, message: `Unknown toast tone ${JSON.stringify(t.tone)}.`, hint: `Use one of: ${TOAST_TONES.join(', ')}.` });
        }
    }
    if (effects.navigateTo !== undefined && effects.navigateTo !== null) {
        if (typeof effects.navigateTo !== 'string' || !screenIds.has(effects.navigateTo)) {
            const suggestion = pickClosestId(effects.navigateTo, Array.from(screenIds));
            pushE({ code: 'action.effects_navigate_unresolved', severity: 'error', path: `${path}.navigateTo`, message: `Effects navigateTo references unknown screen ${JSON.stringify(effects.navigateTo)}.`, hint: suggestion ? `Did you mean "${suggestion}"?` : 'Use a screen id from definition.screens, or null.' });
        }
    }
}

/**
 * Action kinds whose fields are checked ONE BY ONE against their spec table,
 * the same way a sequence step is.
 *
 * The kinds above this line have hand-written checks; these share their field
 * table with the step catalog and are validated through the step validator so a
 * bare v1 action is checked exactly as strictly as the same thing inside a
 * sequence. `create_record` is here from the day it became an action kind: it
 * carries a tableId and a map of bindings, and without this an action pointing
 * at a table that does not exist — or a column bound to nonsense — saved
 * cleanly and failed at the first click.
 *
 * `send_email` is deliberately NOT here yet. It has the same gap, but turning
 * its per-field checks on rejects definitions that today save (a raw string
 * where the spec wants a binding), so it is a behaviour change of its own
 * rather than a side effect of this one.
 */
const PER_FIELD_VALIDATED_ACTION_KINDS = new Set(['ai_extract', 'ai_generate', 'kb_query', 'create_record']);

function validateAction(id, action, path, ctx) {
    const { pushE, pushW, screenIds, ownedAutomations } = ctx;

    if (!isObject(action)) {
        pushE({ code: 'action.not_object', severity: 'error', path, message: 'Each action must be an object.', hint: 'Use { kind, ...fields } per the action catalog.' });
        return;
    }
    if (!ACTION_KINDS.includes(action.kind)) {
        const suggestion = pickClosestId(action.kind, ACTION_KINDS);
        pushE({ code: 'action.kind_invalid', severity: 'error', path: `${path}.kind`, message: `Unknown action kind ${JSON.stringify(action.kind)}.`, hint: suggestion ? `Did you mean "${suggestion}"? Legal kinds: ${ACTION_KINDS.join(', ')}.` : `Legal kinds: ${ACTION_KINDS.join(', ')}.` });
        return;
    }

    const spec = ACTION_SPECS[action.kind];
    const unknown = Object.keys(action).filter((k) => k !== 'kind' && !(k in spec.fields));
    if (unknown.length) {
        pushE({ code: 'action.unknown_field', severity: 'error', path, message: `Action "${id}" has unknown fields for kind "${action.kind}": ${unknown.join(', ')}.`, hint: `Legal fields: ${Object.keys(spec.fields).join(', ')}.` });
    }

    if (action.kind === 'run_automation') {
        const aid = action.automationId;
        if (aid === null || aid === undefined) {
            // Templates ship with automationId unset — non-blocking until publish.
            pushW({ code: 'action.automation_unset', severity: 'warning', path: `${path}.automationId`, message: `Action "${id}" has no automation selected yet.`, hint: 'Pick one of the user\'s automations before publishing.' });
        } else if (typeof aid !== 'string') {
            pushE({ code: 'action.automation_invalid', severity: 'error', path: `${path}.automationId`, message: 'automationId must be a string or null.', hint: 'Use the automation\'s id.' });
        } else if (ownedAutomations) {
            const rec = ownedAutomations.get(aid);
            if (!rec) {
                pushE({ code: 'action.automation_missing', severity: 'error', path: `${path}.automationId`, message: `Action "${id}" references automation "${aid}" which the owner does not have.`, hint: 'Pick an automation the app owner owns.' });
            } else if (!(rec === true || rec.isActive)) {
                pushE({ code: 'action.automation_inactive', severity: 'error', path: `${path}.automationId`, message: `Action "${id}" references automation "${aid}" which is not active.`, hint: 'Activate the automation, then publish the app.' });
            }
        }
        if (action.inputMapping !== undefined) validateInputMapping(id, action.inputMapping, `${path}.inputMapping`, ctx);
        if (action.onSuccess !== undefined) validateEffects(action.onSuccess, `${path}.onSuccess`, ctx);
        if (action.onError !== undefined) validateEffects(action.onError, `${path}.onError`, ctx);
    }

    if (action.kind === 'navigate') {
        if (typeof action.screenId !== 'string' || !action.screenId) {
            pushE({ code: 'action.navigate_missing', severity: 'error', path: `${path}.screenId`, message: `Action "${id}" (navigate) needs a screenId.`, hint: 'Use a screen id from definition.screens.' });
        } else if (!screenIds.has(action.screenId)) {
            const suggestion = pickClosestId(action.screenId, Array.from(screenIds));
            pushE({ code: 'action.navigate_unresolved', severity: 'error', path: `${path}.screenId`, message: `Action "${id}" navigates to unknown screen "${action.screenId}".`, hint: suggestion ? `Did you mean "${suggestion}"?` : 'Add the screen first.' });
        }
        if (action.params !== undefined && action.params !== null) {
            validateNavigateParams(`Action "${id}" (navigate)`, action.params, `${path}.params`, ctx);
        }
    }

    if (action.kind === 'toast') {
        if (typeof action.message !== 'string' || !action.message) {
            pushE({ code: 'action.toast_message_missing', severity: 'error', path: `${path}.message`, message: `Action "${id}" (toast) needs a non-empty message.`, hint: 'Provide the text to show.' });
        } else if (action.message.length > spec.fields.message.maxLen) {
            pushE({ code: 'action.toast_message_too_long', severity: 'error', path: `${path}.message`, message: `Toast message is ${action.message.length} chars — the maximum is ${spec.fields.message.maxLen}.`, hint: 'Shorten it.' });
        }
        if (action.tone !== undefined && !TOAST_TONES.includes(action.tone)) {
            pushE({ code: 'action.toast_tone_invalid', severity: 'error', path: `${path}.tone`, message: `Unknown toast tone ${JSON.stringify(action.tone)}.`, hint: `Use one of: ${TOAST_TONES.join(', ')}.` });
        }
    }

    if (action.kind === 'open_url') {
        if (typeof action.url !== 'string' || !action.url) {
            pushE({ code: 'action.url_invalid', severity: 'error', path: `${path}.url`, message: `Action "${id}" (open_url) needs a url string.`, hint: 'Provide an https:// URL.' });
        } else {
            let protocol = null;
            try { protocol = new URL(action.url).protocol; } catch (err) { log.debug('unparseable', err); }
            if (protocol === null) pushE({ code: 'action.url_invalid', severity: 'error', path: `${path}.url`, message: `Action "${id}" url ${JSON.stringify(action.url.slice(0, 80))} is not a valid URL.`, hint: 'Provide an absolute https:// URL.' });
            else if (protocol !== 'https:') pushE({ code: 'action.url_not_https', severity: 'error', path: `${path}.url`, message: `Action "${id}" url must use https (got ${protocol.replace(':', '')}).`, hint: 'Only https URLs may be opened from an app.' });
        }
        if (action.newTab !== undefined && typeof action.newTab !== 'boolean') {
            pushE({ code: 'action.newtab_invalid', severity: 'error', path: `${path}.newTab`, message: 'newTab must be a boolean.', hint: 'Use true or false.' });
        }
    }

    if (action.kind === 'open_modal' || action.kind === 'close_modal') {
        checkModalRef(action.modalId, `${path}.modalId`, ctx, `Action "${id}" (${action.kind})`);
    }

    if (action.kind === 'sequence') {
        validateActionSteps(action.steps, `${path}.steps`, 1, { n: 0, reported: false }, ctx);
    }

    // Native AI actions (ai_extract / ai_generate / kb_query) share their field
    // table with the sequence-step catalog — validate them through the same
    // per-field validator so a bare v1 AI action is checked as strictly as an
    // AI step inside a sequence.
    if (PER_FIELD_VALIDATED_ACTION_KINDS.has(action.kind)) {
        const label = `Action "${id}" (${action.kind})`;
        for (const [field, fs] of Object.entries(spec.fields)) {
            validateStepField(action.kind, field, fs, action[field], `${path}.${field}`, 1, { n: 0, reported: false }, ctx, label);
        }
        checkRecordValueColumns(action.kind, action.tableId, action.values, path, ctx, label);
    }
}

// ---------------------------------------------------------------------------
// v2 action sequences — validate the Step tree against STEP_SPECS: kinds,
// nesting depth, total step count, embedded formulas (compiled, not run),
// ref-checks (screens/modals/tables/automations), loop bounds, and the
// client/server partition (a client-only step may not carry data fields).
// ---------------------------------------------------------------------------

const RESERVED_DATA_FIELDS = new Set(['tableId', 'values', 'recordId', 'automationId', 'inputMapping']);

function validateActionSteps(steps, path, depth, counter, ctx) {
    const { pushE } = ctx;
    if (!Array.isArray(steps)) {
        pushE({ code: 'action.steps_invalid', severity: 'error', path, message: 'A sequence `steps` must be an array.', hint: 'Provide an array of step objects.' });
        return;
    }
    if (depth > LIMITS.MAX_ACTION_DEPTH) {
        pushE({ code: 'action.step_too_deep', severity: 'error', path, message: `Step nesting exceeds the maximum of ${LIMITS.MAX_ACTION_DEPTH}.`, hint: 'Flatten condition/loop/switch branches.' });
        return;
    }
    steps.forEach((step, i) => validateStep(step, `${path}[${i}]`, depth, counter, ctx));
}

/**
 * Data-model mode: the columns a create/update WRITE must exist on the target
 * table, and system columns are server-managed — never writable.
 *
 * Shared by the step path and the action path. It lived inline in validateStep,
 * so when create_record became a top-level action kind the action path had the
 * table check (via validateStepField) but not the COLUMN check: an action
 * writing to a column that does not exist saved without a word and failed at
 * the first click. One function, two callers, no second place to forget it.
 */
function checkRecordValueColumns(kind, tableId, values, path, ctx, label) {
    if (!ctx.dataTables) return;
    if (kind !== 'create_record' && kind !== 'update_record') return;
    if (!isObject(values)) return;
    for (const col of Object.keys(values)) {
        checkFieldRef(tableId, col, `${path}.values.${col}`, ctx, label, { codePrefix: 'step', allowSystem: false });
    }
}

/**
 * De stapsoorten die RIJEN VERANDEREN — de enige waarvoor `mode:'read'` een
 * fout is en niet slechts een eigenschap. Expliciet opgesomd en niet uit
 * `mutatesData` afgeleid: dat vlaggetje staat óók op run_automation en
 * request_approval, die geen `tableId` schrijven maar er eentje kunnen NOEMEN.
 */
const RECORD_WRITE_STEP_KINDS = new Set(['create_record', 'update_record', 'delete_record']);

function validateStepField(kind, field, fs, value, path, depth, counter, ctx, label = `Step "${kind}"`) {
    const { pushE } = ctx;
    // Cross-cutting reference fields own their own null/undefined semantics
    // (an unset table/automation is a soft warning, not a "required" error),
    // so they run BEFORE the generic missing/required check.
    if (field === 'automationId') { checkAutomationRef(value, path, ctx, label); return; }
    if (field === 'tableId') {
        // An OPTIONAL tableId that was left out is not "unset", it is absent by
        // design (refresh with no table means "reload everything"). Only the
        // required variants get the unset warning.
        if (fs.required || (value !== undefined && value !== null)) {
            checkTableRef(value, path, ctx, label, 'step');
            // …en dan de tweede tabelsoort. checkTableSource hing alleen aan de
            // LEESbindingen (validate/bindings.js), dus een stap die de enige
            // verwijzing naar een gekoppelde tabel was, publiceerde schoon
            // terwijl `source.datatableId` naar een Studio-tabel wees die de
            // eigenaar niet meer heeft — de fout viel dan pas bij het draaien,
            // op het scherm van de gebruiker in plaats van in de publicatiepoort.
            checkTableSource(value, path, ctx, label, { codePrefix: 'step' });
            // En voor een SCHRIJFstap de derde vraag: mag hier geschreven
            // worden? Een create_record op een read-koppeling kreeg bij het
            // publiceren geen woord en faalde daarna elke keer met 403.
            if (RECORD_WRITE_STEP_KINDS.has(kind)) {
                checkTableWritable(value, path, ctx, label, { codePrefix: 'step' });
            }
        }
        return;
    }
    if (field === 'modalId') { checkModalRef(value, path, ctx, label); return; }
    if (field === 'screenId') {
        if (typeof value !== 'string' || !ctx.screenIds.has(value)) {
            const suggestion = pickClosestId(value, Array.from(ctx.screenIds));
            pushE({ code: 'action.step_navigate_unresolved', severity: 'error', path, message: `${label} navigates to unknown screen ${JSON.stringify(value)}.`, hint: suggestion ? `Did you mean "${suggestion}"?` : 'Use a screen id from definition.screens.' });
        }
        return;
    }

    const missing = value === undefined || value === null;
    if (missing) {
        if (fs.required) pushE({ code: 'action.step_field_required', severity: 'error', path, message: `${label} is missing required \`${field}\`.`, hint: `Provide a ${fs.type}.` });
        return;
    }

    switch (fs.type) {
        case 'string':
        case 'url': {
            if (typeof value !== 'string') { pushE({ code: 'action.step_field_invalid', severity: 'error', path, message: `\`${field}\` must be a string.`, hint: 'Pass a plain string.' }); return; }
            if (fs.maxLen && value.length > fs.maxLen) pushE({ code: 'action.step_field_invalid', severity: 'error', path, message: `\`${field}\` is ${value.length} chars — the maximum is ${fs.maxLen}.`, hint: 'Shorten it.' });
            if (fs.type === 'url') {
                let ok = false; try { ok = new URL(value).protocol === 'https:'; } catch { ok = false; }
                if (!ok) pushE({ code: 'action.step_field_invalid', severity: 'error', path, message: `\`${field}\` must be an https:// URL.`, hint: 'Only https URLs are allowed.' });
            }
            return;
        }
        case 'enum':
            if (!fs.values.includes(value)) pushE({ code: 'action.step_field_invalid', severity: 'error', path, message: `\`${field}\` ${JSON.stringify(value)} is not legal.`, hint: `Use one of: ${fs.values.join(', ')}.` });
            return;
        case 'boolean':
            if (typeof value !== 'boolean') pushE({ code: 'action.step_field_invalid', severity: 'error', path, message: `\`${field}\` must be a boolean.`, hint: 'Use true or false.' });
            return;
        case 'int':
            if (typeof value !== 'number' || !Number.isInteger(value) || (fs.min !== undefined && value < fs.min) || (fs.max !== undefined && value > fs.max)) {
                pushE({ code: 'action.step_field_invalid', severity: 'error', path, message: `\`${field}\` must be an integer${fs.min !== undefined ? ` ${fs.min}..${fs.max}` : ''}.`, hint: field === 'maxIterations' ? `Loops are capped at ${LIMITS.MAX_ACTION_LOOP_ITERATIONS} iterations.` : 'Pass an integer.' });
            }
            return;
        case 'formula':
            validateFormula(value, path, ctx, FORMULA_SCOPE_ROOTS);
            return;
        case 'binding':
            validateBinding(field, value, path, ctx);
            return;
        case 'inputMapping':
            validateInputMapping(`${kind}.${field}`, value, path, ctx);
            return;
        case 'recordValues': {
            if (!isObject(value)) { pushE({ code: 'action.step_field_invalid', severity: 'error', path, message: '`values` must be an object map of { column: binding }.', hint: 'Use { col: {kind:"static",value} }.' }); return; }
            for (const [col, b] of Object.entries(value)) validateBinding(col, b, `${path}.${col}`, ctx);
            return;
        }
        case 'steps':
            validateActionSteps(value, path, depth + 1, counter, ctx);
            return;
        case 'switchCases': {
            if (!Array.isArray(value)) { pushE({ code: 'action.step_field_invalid', severity: 'error', path, message: 'switch `cases` must be an array.', hint: 'Use [{ value, steps }].' }); return; }
            value.forEach((c, i) => {
                if (!isObject(c)) { pushE({ code: 'action.step_field_invalid', severity: 'error', path: `${path}[${i}]`, message: 'Each switch case must be an object { value, steps }.', hint: 'Provide value + steps.' }); return; }
                validateActionSteps(c.steps, `${path}[${i}].steps`, depth + 1, counter, ctx);
            });
            return;
        }
        case 'navParams':
            validateNavigateParams(label, value, path, ctx);
            return;
        case 'stringList': {
            if (!Array.isArray(value)) { pushE({ code: 'action.step_field_invalid', severity: 'error', path, message: `\`${field}\` must be an array of strings.`, hint: 'Pass a list of ids.' }); return; }
            if (value.length > 50) { pushE({ code: 'action.step_field_invalid', severity: 'error', path, message: `\`${field}\` has too many entries (${value.length}; max 50).`, hint: 'Remove some.' }); return; }
            if (value.some((v) => typeof v !== 'string')) pushE({ code: 'action.step_field_invalid', severity: 'error', path, message: `\`${field}\` entries must all be strings.`, hint: 'Use string ids.' });
            return;
        }
        case 'aiSchema':
            validateAiSchema(field, value, path, ctx);
            return;
        case 'aiWriteTo':
            validateAiWriteTo(kind, value, path, ctx);
            return;
        case 'contextSources': {
            if (!Array.isArray(value)) {
                pushE({ code: 'action.step_field_invalid', severity: 'error', path, message: `\`${field}\` must be a list of { label, source }.`, hint: 'Pass an array.' });
                return;
            }
            // Each source is a real binding: a typo in the table id has to fail
            // here, not silently reach the model as an empty context that reads
            // like "this order has no lines".
            value.forEach((entry, i) => {
                if (!isObject(entry)) {
                    pushE({ code: 'action.step_field_invalid', severity: 'error', path: `${path}[${i}]`, message: 'Each context source must be an object { label, source }.', hint: 'Provide label + source.' });
                    return;
                }
                validateBinding(`${field}[${i}].source`, entry.source, `${path}[${i}].source`, ctx);
            });
            return;
        }
        case 'approvalQuestions':
            validateApprovalQuestions(field, value, path, ctx);
            return;
        case 'approvalStages':
            validateApprovalStages(field, value, path, ctx);
            return;
        case 'approvalOnDecided':
            validateApprovalOnDecided(value, path, ctx);
            return;
        default:
            return;
    }
}

// Approver questions: the form vocabulary, ≤ 20, and never `file` — approvers
// download attachments, they do not upload (matches the automation-approval
// rule in automation/validate.js).
const APPROVAL_QUESTION_TYPES = new Set(['text', 'textarea', 'number', 'date', 'email', 'select', 'checkbox']);
function validateApprovalQuestions(field, value, path, ctx) {
    const { pushE } = ctx;
    if (!Array.isArray(value)) { pushE({ code: 'action.approval_questions_invalid', severity: 'error', path, message: `\`${field}\` must be an array of question objects.`, hint: 'Use [{ name, label, type, required? }].' }); return; }
    if (value.length > 20) { pushE({ code: 'action.approval_questions_invalid', severity: 'error', path, message: `Too many approver questions (${value.length}; max 20).`, hint: 'An approval is a decision, not a form.' }); return; }
    const seen = new Set();
    value.forEach((q, i) => {
        const qp = `${path}[${i}]`;
        if (!isObject(q) || typeof q.name !== 'string' || !q.name) {
            pushE({ code: 'action.approval_questions_invalid', severity: 'error', path: qp, message: 'Each question needs a `name`.', hint: 'Use { name, label, type }.' });
            return;
        }
        if (seen.has(q.name)) pushE({ code: 'action.approval_questions_invalid', severity: 'error', path: `${qp}.name`, message: `Duplicate question name ${JSON.stringify(q.name)}.`, hint: 'Names key the answers — keep them unique.' });
        seen.add(q.name);
        if (q.type !== undefined && !APPROVAL_QUESTION_TYPES.has(q.type)) {
            pushE({ code: 'action.approval_questions_invalid', severity: 'error', path: `${qp}.type`, message: `Question type ${JSON.stringify(q.type)} is not legal.`, hint: `Use one of: ${[...APPROVAL_QUESTION_TYPES].join(', ')}. File uploads from approvers are not supported.` });
        }
    });
}

// The stage chain. Caps come from the shared rulebook so the app path and the
// automation path enforce the same numbers. Shape only — whether an approver is
// actually in the org is checked at request time, by the same gate the
// assignee has always passed through.
const { MAX_APPROVAL_STAGES: STAGE_MAX, MAX_SEATS_PER_STAGE: STAGE_SEAT_MAX,
    MAX_TOTAL_SEATS: STAGE_TOTAL_MAX, MAX_STAGE_NAME_LEN: STAGE_NAME_MAX,
    MAX_STAGE_DESCRIPTION_LEN: STAGE_DESC_MAX,
    STAGE_RULES: STAGE_RULE_VALUES } = require('../../core/automationModel/approvalStages');
function validateApprovalStages(field, value, path, ctx) {
    const { pushE } = ctx;
    if (!Array.isArray(value)) {
        pushE({ code: 'action.approval_stages_invalid', severity: 'error', path, message: `\`${field}\` must be an array of approval stages.`, hint: 'Use [{ name, approvers: [{ userId }|{ groupId }], rule }].' });
        return;
    }
    if (value.length > STAGE_MAX) {
        pushE({ code: 'action.approval_stages_invalid', severity: 'error', path, message: `Too many approval stages (${value.length}; max ${STAGE_MAX}).`, hint: 'Combine two steps into one stage with several approvers, or split the app into two approvals.' });
        return;
    }
    const keys = new Set();
    let totalSeats = 0;
    value.forEach((st, i) => {
        const sp = `${path}[${i}]`;
        if (!isObject(st)) {
            pushE({ code: 'action.approval_stages_invalid', severity: 'error', path: sp, message: 'Each approval stage must be an object.', hint: 'Use { name, approvers, rule }.' });
            return;
        }
        const seats = Array.isArray(st.approvers) ? st.approvers : null;
        if (!seats || !seats.length) {
            pushE({ code: 'action.approval_stages_invalid', severity: 'error', path: `${sp}.approvers`, message: `Stage ${i + 1} names nobody to decide it.`, hint: 'Every stage needs at least one person or group — a stage with no approvers can never pass.' });
        } else if (seats.length > STAGE_SEAT_MAX) {
            pushE({ code: 'action.approval_stages_invalid', severity: 'error', path: `${sp}.approvers`, message: `Stage ${i + 1} has ${seats.length} approvers (max ${STAGE_SEAT_MAX}).`, hint: 'Use a group instead of listing every person.' });
        } else {
            totalSeats += seats.length;
            seats.forEach((seat, j) => {
                const u = isObject(seat) && typeof seat.userId === 'string' && seat.userId !== '';
                const g = isObject(seat) && typeof seat.groupId === 'string' && seat.groupId !== '';
                if ((u && g) || (!u && !g)) {
                    pushE({ code: 'action.approval_stages_invalid', severity: 'error', path: `${sp}.approvers[${j}]`, message: `Stage ${i + 1}'s approver ${j + 1} must be exactly one person ({ userId }) or one group ({ groupId }).`, hint: 'A seat naming both, or neither, cannot be resolved to anyone.' });
                }
            });
        }
        if (typeof st.key === 'string' && st.key) {
            if (keys.has(st.key)) {
                pushE({ code: 'action.approval_stages_invalid', severity: 'error', path: `${sp}.key`, message: `Two approval stages share the key ${JSON.stringify(st.key)}.`, hint: 'Votes are filed under the key — a duplicate would mix two stages\' votes together.' });
            }
            keys.add(st.key);
        }
        if (typeof st.name === 'string' && st.name.length > STAGE_NAME_MAX) {
            pushE({ code: 'action.approval_stages_invalid', severity: 'error', path: `${sp}.name`, message: `Stage ${i + 1}'s name is longer than ${STAGE_NAME_MAX} characters.`, hint: 'Name it after who decides — "Team lead", "Finance".' });
        }
        if (typeof st.description === 'string' && st.description.length > STAGE_DESC_MAX) {
            pushE({ code: 'action.approval_stages_invalid', severity: 'error', path: `${sp}.description`, message: `Stage ${i + 1}'s description is longer than ${STAGE_DESC_MAX} characters.`, hint: 'Say in one line what this stage is checking.' });
        }
        if (st.rule !== undefined && !STAGE_RULE_VALUES.includes(st.rule)) {
            pushE({ code: 'action.approval_stages_invalid', severity: 'error', path: `${sp}.rule`, message: `Stage ${i + 1}'s rule ${JSON.stringify(st.rule)} is not legal.`, hint: `Use one of: ${STAGE_RULE_VALUES.join(', ')}.` });
        }
        if (st.rule === 'quorum') {
            const n = Number(st.quorum);
            const count = seats ? seats.length : 0;
            if (!Number.isInteger(n) || n < 1 || (count > 0 && n > count)) {
                pushE({ code: 'action.approval_stages_invalid', severity: 'error', path: `${sp}.quorum`, message: `Stage ${i + 1}'s quorum must be a whole number between 1 and its ${count || 'number of'} approvers.`, hint: 'e.g. 2 of 3.' });
            }
        }
    });
    if (totalSeats > STAGE_TOTAL_MAX) {
        pushE({ code: 'action.approval_stages_invalid', severity: 'error', path, message: `The stages have ${totalSeats} approvers between them (max ${STAGE_TOTAL_MAX} across the whole chain).`, hint: 'Use groups instead of listing every person, or drop a stage.' });
    }
}

// The on_decided record-write hook. tableId goes through the shared table-ref
// check (unset = warning, unknown = error at publish); recordId is a binding;
// each outcome's `set` is a { column: template-or-literal } map.
function validateApprovalOnDecided(value, path, ctx) {
    const { pushE } = ctx;
    if (!isObject(value)) { pushE({ code: 'action.approval_hook_invalid', severity: 'error', path, message: '`onDecided` must be an object { tableId, recordId, set }.', hint: 'See the request_approval step docs.' }); return; }
    checkTableRef(value.tableId, `${path}.tableId`, ctx, 'Step "request_approval" onDecided', 'step');
    // De haak SCHRIJFT (`set` per uitkomst), dus allebei de vervolgvragen.
    checkTableSource(value.tableId, `${path}.tableId`, ctx, 'Step "request_approval" onDecided', { codePrefix: 'step' });
    checkTableWritable(value.tableId, `${path}.tableId`, ctx, 'Step "request_approval" onDecided', { codePrefix: 'step' });
    if (value.recordId === undefined || value.recordId === null) {
        pushE({ code: 'action.approval_hook_invalid', severity: 'error', path: `${path}.recordId`, message: 'onDecided needs `recordId` — which row flips when the decision lands.', hint: 'Bind it to the record the approval is about.' });
    } else {
        validateBinding('recordId', value.recordId, `${path}.recordId`, ctx);
    }
    const outcomes = ['approved', 'rejected', 'expired', 'cancelled'];
    if (!isObject(value.set) || !outcomes.some((o) => isObject(value.set[o]) && Object.keys(value.set[o]).length)) {
        pushE({ code: 'action.approval_hook_invalid', severity: 'error', path: `${path}.set`, message: 'onDecided writes nothing — `set` needs at least one outcome map.', hint: 'e.g. set: { approved: { status: "approved" }, rejected: { status: "declined", note: "{{reason}}" } }.' });
        return;
    }
    for (const [outcome, m] of Object.entries(value.set)) {
        if (!outcomes.includes(outcome)) {
            pushE({ code: 'action.approval_hook_invalid', severity: 'error', path: `${path}.set.${outcome}`, message: `Unknown outcome ${JSON.stringify(outcome)}.`, hint: `Legal outcomes: ${outcomes.join(', ')}.` });
        } else if (!isObject(m)) {
            pushE({ code: 'action.approval_hook_invalid', severity: 'error', path: `${path}.set.${outcome}`, message: `set.${outcome} must be a { column: value } map.`, hint: 'Values are literals or templates like "{{reason}}".' });
        }
    }
}

// An AI output schema: a non-empty list of { name, type, description?, required? }
// field definitions with unique identifier names and legal types.
function validateAiSchema(field, value, path, ctx) {
    const { pushE } = ctx;
    if (!Array.isArray(value)) { pushE({ code: 'action.ai_schema_invalid', severity: 'error', path, message: `\`${field}\` must be an array of { name, type } fields.`, hint: 'Add at least one output field.' }); return; }
    if (value.length === 0) { pushE({ code: 'action.ai_schema_empty', severity: 'error', path, message: `\`${field}\` needs at least one output field.`, hint: 'Declare the fields the AI should return.' }); return; }
    if (value.length > 40) { pushE({ code: 'action.ai_schema_too_large', severity: 'error', path, message: `\`${field}\` has too many fields (${value.length}; max 40).`, hint: 'Reduce the number of output fields.' }); return; }
    const seen = new Set();
    value.forEach((f, i) => {
        const fp = `${path}[${i}]`;
        if (!isObject(f)) { pushE({ code: 'action.ai_schema_invalid', severity: 'error', path: fp, message: 'Each schema field must be an object { name, type }.', hint: 'Provide a name and a type.' }); return; }
        if (typeof f.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(f.name)) {
            pushE({ code: 'action.ai_schema_invalid', severity: 'error', path: `${fp}.name`, message: `Schema field name ${JSON.stringify(f.name)} must start with a letter and use only letters, digits and underscores.`, hint: 'Rename the field.' });
            return;
        }
        if (seen.has(f.name)) { pushE({ code: 'action.ai_schema_invalid', severity: 'error', path: `${fp}.name`, message: `Duplicate schema field name "${f.name}".`, hint: 'Field names must be unique.' }); return; }
        seen.add(f.name);
        if (!AI_SCHEMA_FIELD_TYPES.includes(f.type)) {
            pushE({ code: 'action.ai_schema_invalid', severity: 'error', path: `${fp}.type`, message: `Schema field "${f.name}" has invalid type ${JSON.stringify(f.type)}.`, hint: `Use one of: ${AI_SCHEMA_FIELD_TYPES.join(', ')}.` });
        }
        if (f.description !== undefined && (typeof f.description !== 'string' || f.description.length > 500)) {
            pushE({ code: 'action.ai_schema_invalid', severity: 'error', path: `${fp}.description`, message: `Schema field "${f.name}" description must be a string of at most 500 chars.`, hint: 'Shorten the description.' });
        }
    });
}

// The optional ai_extract write-to target: { tableId, mapping?: { column: fieldName } }.
// `mapping` may be omitted (or left empty) — the executor then writes each output
// field to the column of the same name (actionExecutor.resolveWriteMapping).
function validateAiWriteTo(kind, value, path, ctx) {
    const { pushE } = ctx;
    if (!isObject(value)) { pushE({ code: 'action.ai_writeto_invalid', severity: 'error', path, message: '`writeTo` must be an object { tableId, mapping }.', hint: 'Pick a table and map columns, or remove writeTo.' }); return; }
    checkTableRef(value.tableId, `${path}.tableId`, ctx, `Step "${kind}" writeTo`, 'step');
    // writeTo is per definitie een schrijving (ai_extract / file_intake /
    // dataset_query), dus dezelfde twee vervolgvragen als bij een record-stap.
    checkTableSource(value.tableId, `${path}.tableId`, ctx, `Step "${kind}" writeTo`, { codePrefix: 'step' });
    checkTableWritable(value.tableId, `${path}.tableId`, ctx, `Step "${kind}" writeTo`, { codePrefix: 'step' });
    if (value.mapping === undefined) return;
    if (!isObject(value.mapping)) { pushE({ code: 'action.ai_writeto_invalid', severity: 'error', path: `${path}.mapping`, message: '`writeTo.mapping` must be an object map of { column: fieldName }.', hint: 'Map each target column to a schema field name, or omit it to match columns by name.' }); return; }
    for (const [col, fieldName] of Object.entries(value.mapping)) {
        if (typeof fieldName !== 'string' || !fieldName) {
            pushE({ code: 'action.ai_writeto_invalid', severity: 'error', path: `${path}.mapping.${col}`, message: `writeTo.mapping.${col} must name a schema field (string).`, hint: 'Use one of the declared schema field names.' });
            continue;
        }
        checkFieldRef(value.tableId, col, `${path}.mapping.${col}`, ctx, `Step "${kind}" writeTo`, { codePrefix: 'step', allowSystem: false });
    }
    validateAiWriteToUpsert(kind, value, path, ctx);
    validateAiWriteToConstants(kind, value, path, ctx);
}

// `upsertOn` — the column that says which row an extracted row IS, rather than
// letting every run add another one. Without it a second read of the same
// document doubles the table; with a column that is not written, it would match
// nothing and do the same thing more slowly, so both are refused here.
function validateAiWriteToUpsert(kind, value, path, ctx) {
    const { pushE } = ctx;
    if (value.upsertOn === undefined) return;
    if (typeof value.upsertOn !== 'string' || !value.upsertOn) {
        pushE({ code: 'action.ai_writeto_invalid', severity: 'error', path: `${path}.upsertOn`, message: '`writeTo.upsertOn` must name a column (string).', hint: 'Name the column that identifies a row, or omit it to always insert.' });
        return;
    }
    checkFieldRef(value.tableId, value.upsertOn, `${path}.upsertOn`, ctx, `Step "${kind}" writeTo`, { codePrefix: 'step', allowSystem: false });
    const mapping = isObject(value.mapping) ? value.mapping : null;
    if (mapping && !Object.prototype.hasOwnProperty.call(mapping, value.upsertOn)) {
        pushE({
            code: 'action.ai_writeto_invalid', severity: 'error', path: `${path}.upsertOn`,
            message: `\`writeTo.upsertOn\` names "${value.upsertOn}", which the mapping never writes.`,
            hint: 'Map a schema field to that column, or upsert on a column the extraction actually fills.',
        });
    }
}

// `constants` — resolved once per step and stamped on every extracted row. This
// is what ties rows back to where they came from; without it an extracted
// invoice line names no ticket, so it cannot be shown in context and a
// retention purge has no way to find it.
const MAX_WRITETO_CONSTANTS = 10;

function validateAiWriteToConstants(kind, value, path, ctx) {
    const { pushE } = ctx;
    if (value.constants === undefined) return;
    if (!isObject(value.constants)) {
        pushE({ code: 'action.ai_writeto_invalid', severity: 'error', path: `${path}.constants`, message: '`writeTo.constants` must be an object map of { column: binding }.', hint: 'Map each column to a static or formula binding, or omit it.' });
        return;
    }
    const entries = Object.entries(value.constants);
    if (entries.length > MAX_WRITETO_CONSTANTS) {
        pushE({ code: 'action.ai_writeto_invalid', severity: 'error', path: `${path}.constants`, message: `\`writeTo.constants\` has too many columns (${entries.length}; max ${MAX_WRITETO_CONSTANTS}).`, hint: 'Stamp only the columns that record provenance.' });
        return;
    }
    for (const [col, binding] of entries) {
        checkFieldRef(value.tableId, col, `${path}.constants.${col}`, ctx, `Step "${kind}" writeTo`, { codePrefix: 'step', allowSystem: false });
        validateBinding(`constants.${col}`, binding, `${path}.constants.${col}`, ctx);
    }
}


function validateStep(step, path, depth, counter, ctx) {
    const { pushE } = ctx;
    counter.n += 1;
    if (counter.n > LIMITS.MAX_ACTION_STEPS && !counter.reported) {
        counter.reported = true;
        pushE({ code: 'action.too_many_steps', severity: 'error', path, message: `A sequence has more than ${LIMITS.MAX_ACTION_STEPS} steps.`, hint: 'Split the action into smaller ones.' });
    }
    if (!isObject(step)) {
        pushE({ code: 'action.step_not_object', severity: 'error', path, message: 'Each step must be an object { kind, ... }.', hint: 'Remove the malformed entry.' });
        return;
    }
    if (!STEP_KINDS.includes(step.kind)) {
        const suggestion = pickClosestId(step.kind, STEP_KINDS);
        pushE({ code: 'action.step_kind_invalid', severity: 'error', path: `${path}.kind`, message: `Unknown step kind ${JSON.stringify(step.kind)}.`, hint: suggestion ? `Did you mean "${suggestion}"? Legal: ${STEP_KINDS.join(', ')}.` : `Legal step kinds: ${STEP_KINDS.join(', ')}.` });
        return;
    }
    const spec = STEP_SPECS[step.kind];
    for (const [field, fs] of Object.entries(spec.fields)) {
        validateStepField(step.kind, field, fs, step[field], `${path}.${field}`, depth, counter, ctx);
    }

    // A send_email inside a loop is a spam cannon: one click over a 500-row
    // binding is 500 outbound messages from a real person's mailbox. There is no
    // legitimate app-builder use for it that an automation cannot do better, with
    // its own throttling. This is the single most important guard on the step.
    if (step.kind === 'loop' && containsSendEmail(step.steps)) {
        pushE({
            code: 'action.send_email_in_loop', severity: 'error', path: `${path}.steps`,
            message: 'A "send email" step may not run inside a loop.',
            hint: 'Sending one message per row would mail everyone at once. Send a single message, or use an automation that controls its own pacing.',
        });
    }

    // Only the SERVER-authoritative kinds get the server-scope check: a client
    // step's formulas are evaluated in the browser, where the full viewer object
    // really is in scope.
    if (DATA_MUTATING_STEP_KINDS.includes(step.kind)) {
        checkServerFormulas(step, path, ctx);
    }

    // The per-kind rules (a step has exactly one kind, so their order is free).
    const kindCheck = KIND_CHECKS[step.kind] || DATA_KIND_CHECKS[step.kind];
    if (kindCheck) kindCheck(step, path, ctx);
    checkRecordValueColumns(step.kind, step.tableId, step.values, path, ctx, `Step "${step.kind}"`);
    // Unknown fields — and the client/server partition invariant: a client-only
    // step may not carry a data-mutation field.
    const isMutating = DATA_MUTATING_STEP_KINDS.includes(step.kind);
    for (const k of Object.keys(step)) {
        if (k === 'kind' || k in spec.fields) continue;
        if (RESERVED_DATA_FIELDS.has(k) && !isMutating) {
            pushE({ code: 'action.step_partition', severity: 'error', path: `${path}.${k}`, message: `Client-only step "${step.kind}" may not carry the data-mutation field "${k}".`, hint: `Only ${DATA_MUTATING_STEP_KINDS.join(', ')} may read or write data.` });
        } else {
            pushE({ code: 'action.step_unknown_field', severity: 'error', path: `${path}.${k}`, message: `Step "${step.kind}" has unknown field "${k}".`, hint: `Legal fields: ${Object.keys(spec.fields).join(', ') || '(none)'}.` });
        }
    }
}

module.exports = {
    validateAction,
    DATASET_QUERY_OUTPUTS,
};
