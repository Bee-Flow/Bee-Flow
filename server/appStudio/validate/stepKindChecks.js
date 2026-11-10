// @typecheck
/**
 * App Studio validator — per-kind rules of a sequence step (approvals, email, generated files, loops, browsing).
 * Split out of actions.js; the refusals are pinned by actions.validateStep.test.js.
 */

'use strict';

const { isObject, pushDataRef } = require('./shared');
const { checkCallAction } = require('./callChecks.mts');
const { checkLoopExit, checkWhile, checkTry } = require('./controlFlowChecks.mts');
const { checkParallel, validateStepBranches } = require('./parallelChecks.mts');
const { someStepThroughCalls } = require('../actionCalls.mts');
const { TRANSACTION_CHILD_KINDS, MAX_TRANSACTION_STEPS, extraChildLists } = require('../../shared/appDefinition/stepFlow.mjs');
const { STEP_META, EXTENSION_STEP_ENTRIES } = require('../componentSpecs/stepRegistry');

// The base kinds are told in this order (the order the warnings have always come in); registry kinds follow.
const LOOP_FINDING_ORDER = ['generate_presentation', 'generate_file', 'fill_document'];
const LOOP_FINDING_KINDS = [
    ...LOOP_FINDING_ORDER.filter((k) => STEP_META[k]?.inLoop),
    ...Object.keys(STEP_META).filter((k) => STEP_META[k].inLoop && !LOOP_FINDING_ORDER.includes(k)),
];
const REGISTRY_NO_LOOP_KINDS = EXTENSION_STEP_ENTRIES.filter((e) => e.noLoop === true).map((e) => e.kind);

/**
 * A step of `kind` under these steps, or in an action they call.
 * @param {unknown} steps
 * @param {string} kind
 * @param {{ actions?: unknown }} ctx
 */
function containsThroughCalls(steps, kind, ctx) {
    return containsStepKind(steps, kind) || someStepThroughCalls(steps, ctx.actions, (/** @type {Record<string, unknown>} */ s) => s.kind === kind);
}

/**
 * Is there a send_email anywhere under these steps?
 *
 * Walks the whole subtree, not just the immediate children — burying the send
 * inside a condition inside the loop is the obvious way around a shallow check.
 */
function containsSendEmail(steps) {
    if (!Array.isArray(steps)) return false;
    for (const s of steps) {
        if (!isObject(s)) continue;
        if (s.kind === 'send_email') return true;
        if (containsSendEmail(s.steps) || containsSendEmail(s.then) || containsSendEmail(s.else)) return true;
        if (Array.isArray(s.cases)) {
            for (const c of s.cases) {
                if (isObject(c) && containsSendEmail(c.steps)) return true;
            }
        }
        if (containsSendEmail(s.default)) return true;
        // The places a registry container adds (a try's catch and finally).
        if (extraChildLists(s).some((list) => containsSendEmail(list))) return true;
    }
    return false;
}

// Same whole-subtree walk, for any kind. (containsSendEmail predates this and
// stays as-is — its call site is the single most important guard in the file
// and not worth churning.)
/**
 * @param {string} kind
 */
function containsStepKind(steps, kind) {
    if (!Array.isArray(steps)) return false;
    for (const s of steps) {
        if (!isObject(s)) continue;
        if (s.kind === kind) return true;
        if (containsStepKind(s.steps, kind) || containsStepKind(s.then, kind) || containsStepKind(s.else, kind)) return true;
        if (Array.isArray(s.cases)) {
            for (const c of s.cases) {
                if (isObject(c) && containsStepKind(c.steps, kind)) return true;
            }
        }
        if (containsStepKind(s.default, kind)) return true;
        // A step's onError handler runs too (automationRefs.walkSteps descends into it as well).
        if (containsStepKind(s.onError?.steps, kind)) return true;
        // The places a registry container adds (a try's catch and finally).
        if (extraChildLists(s).some((list) => containsStepKind(list, kind))) return true;
    }
    return false;
}

function checkApproval(step, path, ctx) {
    const { pushE } = ctx;
    // One decider target, not two: a user OR a group (neither = the owner
    // decides). Mirrors the automation approval's assignee rule.
    const hasUser = typeof step.assigneeUserId === 'string' && step.assigneeUserId !== '';
    const hasGroup = typeof step.assigneeGroupId === 'string' && step.assigneeGroupId !== '';
    if (hasUser && hasGroup) {
        pushE({
            code: 'action.approval_assignee_ambiguous', severity: 'error', path,
            message: 'Step "request_approval" names both a person and a group as approver.',
            hint: 'Set assigneeUserId OR assigneeGroupId — or neither, and the app owner decides.',
        });
    }
    // Stages supersede the one-stage and two-stage shorthands rather than
    // combining with them. Refusing the combination is deliberate: the
    // alternative is a configured approver who is never asked, and nobody
    // discovers that until the invoice is already paid.
    if (Array.isArray(step.stages) && step.stages.length) {
        for (const [f, human] of [
            ['assigneeUserId', 'an approver'], ['assigneeGroupId', 'an approver group'],
            ['approverUserIds', 'a panel'], ['approverGroupIds', 'a panel of groups'],
            ['finalApproverUserId', 'a final approver'], ['finalApproverGroupId', 'a final approver group'],
            ['escalateToUserId', 'an escalation target'], ['escalateToGroupId', 'an escalation group'],
        ]) {
            const v = step[f];
            const set = Array.isArray(v) ? v.length > 0 : (typeof v === 'string' && v !== '');
            if (set) {
                pushE({
                    code: 'action.approval_stages_conflict', severity: 'error', path: `${path}.${f}`,
                    message: `Step "request_approval" uses stages, so ${human} set alongside them would never be asked.`,
                    hint: 'Move them into a stage, or remove the stages.',
                });
            }
        }
    }
}

function checkSendEmail(step, path, ctx) {
    const { pushE, pushW } = ctx;
    const hasRecord = step.replyToRecordId !== undefined && step.replyToRecordId !== null;
    const hasThread = step.replyToThreadKey !== undefined && step.replyToThreadKey !== null;
    if (hasRecord && hasThread) {
        pushE({
            code: 'action.send_email_reply_ambiguous', severity: 'error', path,
            message: 'Step "send email" names both a message and a conversation to reply to.',
            hint: 'Use replyToRecordId when the screen has a message, replyToThreadKey when it has a conversation — not both.',
        });
    } else if (!hasRecord && !hasThread) {
        // Not an error: a mailbox connector can legitimately send a first
        // message. But every reply UI reaches this without noticing, and the
        // symptom — the customer gets a detached mail, and the next sync
        // files it as a SECOND ticket — looks like a sync bug, not this.
        pushW({
            code: 'action.send_email_unthreaded', severity: 'warning', path,
            message: 'Step "send email" does not say what it is replying to, so it starts a new conversation.',
            hint: 'Set replyToRecordId (a message) or replyToThreadKey (a conversation) so the reply lands in the existing thread.',
        });
    }

    if (ctx.dataMailboxConnectors && typeof step.connectorId === 'string') {
        if (!ctx.dataMailboxConnectors.has(step.connectorId)) {
            const known = Array.from(ctx.dataMailboxConnectors);
            pushDataRef(ctx, {
                code: 'action.send_email_connector_invalid', severity: 'error', path: `${path}.connectorId`,
                message: `Step "send_email" references ${JSON.stringify(step.connectorId)}, which is not a mailbox connector.`,
                hint: known.length ? `Mailbox connectors in this app: ${known.join(', ')}.` : 'Add a mailbox connector in the Data tab first.',
            });
        }
    }
}

function checkGenerateFile(step, path, ctx) {
    const { pushE, pushW } = ctx;
    // attachTo is how anyone but the OWNER gets to download the result: an
    // attachment ledger row with recordId null is owner-only. Half a link
    // is exactly that bug wearing a config.
    const hasRec = step.attachToRecordId !== undefined && step.attachToRecordId !== null;
    const hasKey = typeof step.attachToFieldKey === 'string' && step.attachToFieldKey !== '';
    if (hasRec !== hasKey) {
        pushE({
            code: 'action.generate_file_attach_partial', severity: 'error', path,
            message: 'Step "generate_file" sets only half of attachToRecordId + attachToFieldKey.',
            hint: 'Set both (the record and its file column) so viewers other than the owner can download the file — or neither, making the file owner-only.',
        });
    }
    if (hasKey && ctx.dataTables) {
        // The field key must exist SOMEWHERE in the model — we cannot know
        // the table (recordId is a runtime value), so this is a warning,
        // not an error. dataTables values are Sets of field KEYS (see
        // buildDataTables), so only existence is checkable here; whether
        // the column is `file`-typed is the author's to get right.
        let known = false;
        for (const keys of ctx.dataTables.values()) {
            if (keys && typeof keys.has === 'function' && keys.has(step.attachToFieldKey)) { known = true; break; }
        }
        if (!known) {
            pushW({
                code: 'action.generate_file_field_unknown', severity: 'warning', path: `${path}.attachToFieldKey`,
                message: `No table has a column named ${JSON.stringify(step.attachToFieldKey)}.`,
                hint: 'Name an existing `file` column, or the download link will 404 for everyone but the owner.',
            });
        }
    }
    if (step.format && step.format !== 'csv' && step.delimiter !== undefined) {
        pushW({ code: 'action.generate_file_field_ignored', severity: 'warning', path: `${path}.delimiter`, message: '`delimiter` only applies to CSV output.', hint: 'Remove it, or set format to csv.' });
    }
    if ((step.format === 'csv' || step.format === undefined) && step.sheetName !== undefined) {
        pushW({ code: 'action.generate_file_field_ignored', severity: 'warning', path: `${path}.sheetName`, message: '`sheetName` only applies to spreadsheet output.', hint: 'Remove it, or set format to xlsx/ods.' });
    }
}

function checkFillDocument(step, path, ctx) {
    const { pushE, pushW } = ctx;
    if (step.documentId && typeof step.documentId === 'string' && ctx.ownedDocuments && !ctx.ownedDocuments.get(step.documentId)) {
        const known = [...ctx.ownedDocuments.values()].map((d) => `${d.id} ("${d.name}")`);
        pushE({
            code: 'action.fill_document_unknown', severity: 'error', path: `${path}.documentId`,
            message: `Step "fill_document" references document ${JSON.stringify(step.documentId)}, which the app owner does not have.`,
            hint: known.length ? `The owner's documents: ${known.join(', ')}.` : 'The owner has no designed documents — one has to be made in Studio → Documents first.',
        });
    }
    if (!step.documentId || typeof step.documentId !== 'string') {
        pushE({
            code: 'action.fill_document_missing', severity: 'error', path: `${path}.documentId`,
            message: 'Step "fill_document" has no document to fill.',
            hint: 'Name one of the owner\'s documents from Studio → Documents; design it there first if it does not exist yet.',
        });
    }
    // The SAME half-a-link bug generate_file has, and for the same reason:
    // an attachment ledger row with recordId null is owner-only, so a
    // colleague who presses the button gets a 404 on Download.
    const hasRec = step.attachToRecordId !== undefined && step.attachToRecordId !== null;
    const hasKey = typeof step.attachToFieldKey === 'string' && step.attachToFieldKey !== '';
    if (hasRec !== hasKey) {
        pushE({
            code: 'action.fill_document_attach_partial', severity: 'error', path,
            message: 'Step "fill_document" sets only half of attachToRecordId + attachToFieldKey.',
            hint: 'Set both (the record and its file column) so viewers other than the owner can download the document — or neither, making it owner-only.',
        });
    }
    if (hasKey && ctx.dataTables) {
        let known = false;
        for (const keys of ctx.dataTables.values()) {
            if (keys && typeof keys.has === 'function' && keys.has(step.attachToFieldKey)) { known = true; break; }
        }
        if (!known) {
            pushW({
                code: 'action.fill_document_field_unknown', severity: 'warning', path: `${path}.attachToFieldKey`,
                message: `No table has a column named ${JSON.stringify(step.attachToFieldKey)}.`,
                hint: 'Name an existing `file` column, or the download link will 404 for everyone but the owner.',
            });
        }
    }
}

function checkGeneratePresentation(step, path, ctx) {
    const { pushE, pushW } = ctx;
    const s = step.slides;
    if (s === undefined || s === null || (typeof s === 'string' && !s.trim())) {
        pushE({
            code: 'action.generate_presentation_missing', severity: 'error', path: `${path}.slides`,
            message: 'Step "generate_presentation" has no slides.',
            hint: 'Bind `slides` to the outline an ai_generate step wrote (vars.<resultVar>) — "# " title, "## " per slide, "- " bullets — or to records of a table with title/content columns.',
        });
    }
    // The SAME half-a-link bug generate_file has, and for the same reason.
    const hasRec = step.attachToRecordId !== undefined && step.attachToRecordId !== null;
    const hasKey = typeof step.attachToFieldKey === 'string' && step.attachToFieldKey !== '';
    if (hasRec !== hasKey) {
        pushE({
            code: 'action.generate_presentation_attach_partial', severity: 'error', path,
            message: 'Step "generate_presentation" sets only half of attachToRecordId + attachToFieldKey.',
            hint: 'Set both (the record and its file column) so viewers other than the owner can download the deck — or neither, making it owner-only.',
        });
    }
    if (hasKey && ctx.dataTables) {
        let known = false;
        for (const keys of ctx.dataTables.values()) {
            if (keys && typeof keys.has === 'function' && keys.has(step.attachToFieldKey)) { known = true; break; }
        }
        if (!known) {
            pushW({
                code: 'action.generate_presentation_field_unknown', severity: 'warning', path: `${path}.attachToFieldKey`,
                message: `No table has a column named ${JSON.stringify(step.attachToFieldKey)}.`,
                hint: 'Name an existing `file` column, or the download link will 404 for everyone but the owner.',
            });
        }
    }
}

function checkLoopCosts(step, path, ctx) {
    const { pushW } = ctx;
    if (step.kind !== 'loop' && step.kind !== 'while') return;
    // What a loop holding a kind is told is on the kind's catalogue entry (`inLoop`, `noLoop`).
    for (const kind of LOOP_FINDING_KINDS) {
        const finding = STEP_META[kind].inLoop;
        if (finding && containsThroughCalls(step.steps, kind, ctx)) {
            (finding.severity === 'error' ? ctx.pushE : pushW)({ code: finding.code, severity: finding.severity, path: `${path}.steps`, message: finding.message, hint: finding.hint });
        }
    }
    // A registry kind marked `noLoop` gets the generic refusal (send_email keeps its own, in actions.js).
    for (const kind of REGISTRY_NO_LOOP_KINDS) {
        if (containsThroughCalls(step.steps, kind, ctx)) {
            ctx.pushE({ code: 'action.step_in_loop', severity: 'error', path: `${path}.steps`, message: `A "${kind}" step may not run inside a loop.`, hint: 'Run it once, before or after the loop.' });
        }
    }
}

function checkAiBrowse(step, path, ctx) {
    const { pushE } = ctx;
if (!ctx.aiBrowsingEnabled) {
        pushE({
            code: 'browse.not_enabled', severity: 'error', path,
            message: 'This app contains an ai_browse step but AI browsing is not enabled for the app.',
            hint: 'The app OWNER enables it under App settings → AI browsing (the builder cannot switch it on). Until then this step can never run.',
        });
}
}

/**
 * copy_document: the template must be a presentation of the owner's (when
 * the caller knows the owner's documents), and only a presentation takes one.
 */
function checkCopyDocument(step, path, ctx) {
    const { pushW } = ctx;
    const templateId = typeof step.templateDocumentId === 'string' ? step.templateDocumentId : '';
    if (!templateId || !ctx.ownedDocuments) return;
    const known = ctx.ownedDocuments.get(templateId);
    if (!known) {
        pushW({
            code: 'action.copy_document_template_unknown', severity: 'warning', path: `${path}.templateDocumentId`,
            message: `Step "copy_document" names template ${JSON.stringify(templateId)}, which is not one of the owner's documents.`,
            hint: 'Use the id of one of the owner\'s presentations from Studio → Documents.',
        });
    } else if (known.docType && known.docType !== 'presentation') {
        pushW({
            code: 'action.copy_document_template_not_deck', severity: 'warning', path: `${path}.templateDocumentId`,
            message: `Step "copy_document" names template "${known.name}", which is not a presentation; only a presentation's look can be applied.`,
            hint: 'Pick a presentation, or leave templateDocumentId out for a plain copy.',
        });
    }
}

/**
 * A transaction holds only record writes on the app's own tables, at most
 * MAX_TRANSACTION_STEPS, and its children carry no handler or retry of their own
 * (the transaction is ONE step: it fails or retries as a whole).
 * @param {string} path
 */
function checkTransaction(step, path, ctx) {
    const { pushE, pushW } = ctx;
    const children = Array.isArray(step.steps) ? step.steps : [];
    if (!children.length) {
        pushW({ code: 'action.transaction_empty', severity: 'warning', path: `${path}.steps`, message: 'This transaction has no steps, so it does nothing.', hint: 'Add create_record, update_record or delete_record steps, or remove it.' });
        return;
    }
    if (children.length > MAX_TRANSACTION_STEPS) {
        pushE({ code: 'action.transaction_too_many', severity: 'error', path: `${path}.steps`, message: `A transaction holds at most ${MAX_TRANSACTION_STEPS} steps (LIMITS.MAX_TRANSACTION_STEPS); this one has ${children.length}.`, hint: 'Split it, or write the rows with one step that takes a list.' });
    }
    children.forEach((/** @type {unknown} */ raw, /** @type {number} */ i) => {
        if (!isObject(raw)) return; // validateStep names it
        const c = /** @type {Record<string, unknown>} */ (raw);
        const at = `${path}.steps[${i}]`;
        if (!TRANSACTION_CHILD_KINDS.includes(String(c.kind))) {
            pushE({ code: 'action.transaction_child_kind', severity: 'error', path: `${at}.kind`, message: `A transaction holds only ${TRANSACTION_CHILD_KINDS.join(', ')}; step ${i + 1} is "${String(c.kind)}".`, hint: 'Move it before or after the transaction.' });
            return;
        }
        if (c.onError !== undefined || c.retry !== undefined) {
            pushE({ code: 'action.transaction_child_handler', severity: 'error', path: at, message: `Step ${i + 1} of the transaction has its own ${c.onError !== undefined ? 'onError' : 'retry'}; the transaction fails or is retried as a whole.`, hint: 'Put onError / retry on the transaction step itself.' });
        }
        const source = ctx.dataTableSources && typeof c.tableId === 'string' ? ctx.dataTableSources.get(c.tableId) : null;
        if (source !== undefined && source !== null) {
            pushE({ code: 'action.transaction_linked_table', severity: 'error', path: `${at}.tableId`, message: `Step ${i + 1} of the transaction writes a linked table; its rows live in another store, so they cannot be rolled back with the rest.`, hint: 'Write the linked table in its own step, outside the transaction.' });
        }
    });
}

const KIND_CHECKS = {
    transaction: checkTransaction,
    request_approval: checkApproval,
    send_email: checkSendEmail,
    generate_file: checkGenerateFile,
    fill_document: checkFillDocument,
    generate_presentation: checkGeneratePresentation,
    loop: checkLoopCosts,
    ai_browse: checkAiBrowse,
    copy_document: checkCopyDocument,
    call_action: checkCallAction,
    // The control kinds of the step registry (controlFlowChecks.mts); a while is told what a loop is told.
    break: checkLoopExit,
    continue: checkLoopExit,
    while: (step, path, ctx) => { checkWhile(step, path, ctx); checkLoopCosts(step, path, ctx); },
    try: checkTry,
    parallel: checkParallel,
    // Registry kinds (componentSpecs/steps/<kind>.js) whose fields need more than their types.
    code: require('./codeStepChecks.mts').checkCodeStep,
    http_request: require('./httpRequestChecks.mts').checkHttpRequest,
};

// The browser steps that name a component (focus, scroll_to, set_ui, set_form_field).
Object.assign(KIND_CHECKS, require('./uiStepChecks.mts').UI_STEP_CHECKS);
module.exports = { containsSendEmail, KIND_CHECKS, validateStepBranches };

/** @typedef {import('./shared').ValidationCtx} ValidationCtx */
