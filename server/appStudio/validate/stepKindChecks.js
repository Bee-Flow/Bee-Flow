/**
 * App Studio validator — per-kind rules of a sequence step (approvals, email, generated files, loops, browsing).
 * Split out of actions.js; the refusals are pinned by actions.validateStep.test.js.
 */

'use strict';

const { isObject, pushDataRef } = require('./shared');

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
    }
    return false;
}

// Same whole-subtree walk, for any kind. (containsSendEmail predates this and
// stays as-is — its call site is the single most important guard in the file
// and not worth churning.)
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
// A deck inside a loop is the fill_document shape: one stored file per
// iteration, against the attachment quota. A warning about the cost.
if (step.kind === 'loop' && containsStepKind(step.steps, 'generate_presentation')) {
    pushW({
        code: 'action.generate_presentation_in_loop', severity: 'warning', path: `${path}.steps`,
        message: 'A "generate presentation" step runs inside a loop — one stored deck per iteration.',
        hint: 'Usually one deck over all rows is wanted; bind `slides` to the whole set instead of looping.',
    });
}

// A generate_file inside a loop is legal (one file per order is a real
// shape) but easy to reach by accident — each iteration writes a blob
// against the app's attachment quota, and a quota 409 halfway leaves a
// partial run. A warning, where send_email-in-loop is an error.
if (step.kind === 'loop' && containsStepKind(step.steps, 'generate_file')) {
    pushW({
        code: 'action.generate_file_in_loop', severity: 'warning', path: `${path}.steps`,
        message: 'A "generate file" step runs inside a loop — one stored file per iteration.',
        hint: 'Usually one file over all rows is wanted; bind `rows` to the whole set instead of looping.',
    });
}

// fill_document in a loop is the same quota shape — but the other way
// round: one invoice PER row is the normal thing to want, where one export
// over all rows is. So it warns about the cost rather than the intent.
if (step.kind === 'loop' && containsStepKind(step.steps, 'fill_document')) {
    pushW({
        code: 'action.fill_document_in_loop', severity: 'warning', path: `${path}.steps`,
        message: 'A "fill document" step runs inside a loop — one stored PDF per iteration.',
        hint: 'That is usually intended (one invoice per row); keep the list short, since each file counts against the app\'s storage quota.',
    });
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

const KIND_CHECKS = {
    request_approval: checkApproval,
    send_email: checkSendEmail,
    generate_file: checkGenerateFile,
    fill_document: checkFillDocument,
    generate_presentation: checkGeneratePresentation,
    loop: checkLoopCosts,
    ai_browse: checkAiBrowse,
};

module.exports = { containsSendEmail, KIND_CHECKS };
