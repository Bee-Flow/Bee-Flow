// @typecheck
/**
 * The approval step: the one step whose entire payload is a sentence a human
 * reads before deciding. Everything it can carry is checked here — the
 * question, the single approver, the panel and its decision rule, the stage
 * chain that supersedes both, the reminder and escalation clocks, and the
 * attachments and questions the approver is shown.
 *
 * Shape only. Whether a person or group actually belongs to the owner's
 * organisation is a database question, answered at save time and again at run
 * time; this validator stays pure.
 *
 * The checks are a list, run in order (the order of the findings is part of
 * what the builder model reads); each one owns one part of the config.
 */

// Stage-chain caps live in approvalStages.js, the rulebook the engine and the
// App Studio executor both desugar through — imported rather than restated so
// a cap can never drift between what the validator promises and what the
// runtime enforces.
const {
    MAX_APPROVAL_STAGES, MAX_SEATS_PER_STAGE, MAX_TOTAL_SEATS,
    MAX_STAGE_NAME_LEN, MAX_STAGE_DESCRIPTION_LEN, STAGE_RULES,
} = require('../../approvalStages');
const {
    APPROVAL_MAX_EXPIRY_HOURS, APPROVAL_MAX_ATTACHMENTS, APPROVAL_MAX_FIELDS,
} = require('../constants');

/**
 * @typedef {{ pushE: (f: object) => void, pushW: (f: object) => void }} Sinks
 * @typedef {(ctx: Sinks, step: any, at: string, cfg: any) => void} ApprovalCheck
 */

/** @param {unknown} v @returns {boolean} */
const isSet = (v) => v !== undefined && v !== null;

/**
 * One seat: exactly one person ({ userId }) or one group ({ groupId }).
 * @param s a seat, as the author wrote it
 */
const seatShapeOk = (s) => {
    const u = typeof s?.userId === 'string' && s.userId.trim();
    const g = typeof s?.groupId === 'string' && s.groupId.trim();
    return !!(s && typeof s === 'object' && ((u && !g) || (g && !u)));
};

/**
 * A quorum of `n` over `count` seats: a whole number from 1, and at most the
 * seat count once there are seats to count.
 * @param {number} n
 * @param {number} count
 */
const quorumOk = (n, count) => Number.isInteger(n) && n >= 1 && !(count > 0 && n > count);

/** @type {ApprovalCheck} */
function checkQuestion({ pushE }, step, at) {
    // Mirrors the engine's own fallback (renderApprovalPrompt): the builder
    // writes `prompt`, but `title` is the legacy field that imported and
    // pre-editor definitions carry — and an approval with a title DOES reach
    // its approver with a question, so flagging it would report working
    // automations as broken.
    const hasQuestion = ['prompt', 'title'].some(
        f => typeof step[f] === 'string' && step[f].trim(),
    );
    if (!hasQuestion) {
        pushE({ code: 'approval.prompt_missing', severity: 'error', path: at + '.prompt', message: `Step ${step.id}: an approval needs a question for the approver.`, hint: 'Write what the person is being asked to approve. Use {{...}} to include values from earlier steps.' });
    }
}

/** @type {ApprovalCheck} */
function checkExpiry({ pushW }, step, at) {
    // Read off `step.approval` itself, not the `{}` fallback: a falsy config
    // value is what the deadline check sees.
    const hrs = step.approval && step.approval.expiresInHours;
    if (hrs !== undefined && (!Number.isFinite(hrs) || hrs < 0 || hrs > APPROVAL_MAX_EXPIRY_HOURS)) {
        pushW({ code: 'approval.expiry_invalid', severity: 'warning', path: at + '.approval', message: `Step ${step.id}: the approval deadline must be between 0 and ${APPROVAL_MAX_EXPIRY_HOURS} hours (30 days).`, hint: 'Use 0 for no deadline. Anything above 720 is capped at 30 days when the run starts.' });
    }
}

/** @type {ApprovalCheck} */
function checkForEach({ pushE }, step, at) {
    // execForEachStep rethrows a run pause, so an approval with `forEach`
    // pauses on item 1 and items 2..n never run — the same trap
    // NESTED_FORBIDDEN_RULES catches for a loop body, reached by a different
    // door.
    if (step.forEach) {
        pushE({ code: 'approval.forEach_forbidden', severity: 'error', path: at + '.forEach', message: `Step ${step.id}: an approval cannot run once per item — the run pauses on the first item and the rest never run.`, hint: 'Approve once before the list, or move the approval after the loop.' });
    }
}

/** @type {ApprovalCheck} */
function checkAssignee({ pushE }, step, at, cfg) {
    // Assignee SHAPE only — whether the person or group actually belongs to
    // the owner's org is checked at save time (crud/persistDraft) and again at
    // run time.
    if (isSet(cfg.assignee) && !seatShapeOk(cfg.assignee)) {
        pushE({ code: 'approval.assignee_invalid', severity: 'error', path: at + '.approval.assignee', message: `Step ${step.id}: the approver must be either one person ({ userId }) or one group ({ groupId }).`, hint: 'Pick a person or a group in the step\'s Approver section, or leave it empty so the automation\'s owner decides.' });
    }
}

/** @type {ApprovalCheck} */
function checkDetails({ pushE }, step, at, cfg) {
    if (isSet(cfg.details) && typeof cfg.details !== 'string') {
        pushE({ code: 'approval.details_invalid', severity: 'error', path: at + '.approval.details', message: `Step ${step.id}: approval details must be text.`, hint: 'Write the extra information as text; use {{...}} to pull in values from earlier steps.' });
    }
}

/**
 * Panel (multiple approvers): approvers is a list of SEATS ({userId}|{groupId},
 * ≤10); rule decides how the votes resolve; quorum names N for rule=quorum.
 * Shape only — org membership is checked at save/run time like the assignee.
 * @type {ApprovalCheck}
 */
function checkPanel(ctx, step, at, cfg) {
    const { pushE, pushW } = ctx;
    const panel = cfg.approvers;
    if (!isSet(panel)) {
        if (cfg.rule !== undefined || cfg.quorum !== undefined) {
            pushW({ code: 'approval.rule_invalid', severity: 'warning', path: at + '.approval.rule', message: `Step ${step.id}: a decision rule only means something with a panel of approvers.`, hint: 'Add approvers, or remove the rule.' });
        }
        return;
    }
    if (!Array.isArray(panel) || panel.length < 1 || panel.length > 10 || !panel.every(seatShapeOk)) {
        pushE({ code: 'approval.approvers_invalid', severity: 'error', path: at + '.approval.approvers', message: `Step ${step.id}: approvers must be a list of 1 to 10 seats, each one person ({ userId }) or one group ({ groupId }).`, hint: 'Pick the people or groups whose votes count.' });
    }
    if (isSet(cfg.assignee)) {
        pushE({ code: 'approval.approvers_invalid', severity: 'error', path: at + '.approval.assignee', message: `Step ${step.id}: pick EITHER a single approver (assignee) OR a panel (approvers) — not both.`, hint: 'A panel of one seat behaves like a single approver.' });
    }
    if (isSet(cfg.escalateTo)) {
        pushE({ code: 'approval.approvers_invalid', severity: 'error', path: at + '.approval.escalateTo', message: `Step ${step.id}: escalation is not supported together with a panel.`, hint: 'Use the optional final approver (and a reminder) instead — that is the panel\'s takeover mechanism.' });
    }
    checkPanelRule(ctx, step, at, cfg);
}

/** How a panel's votes resolve: the rule, and N for rule=quorum. @type {ApprovalCheck} */
function checkPanelRule({ pushE }, step, at, cfg) {
    if (cfg.rule !== undefined && !['all', 'first', 'quorum'].includes(cfg.rule)) {
        pushE({ code: 'approval.rule_invalid', severity: 'error', path: at + '.approval.rule', message: `Step ${step.id}: the decision rule must be "all", "first" or "quorum".`, hint: 'all = everyone must approve (one reject declines); first = the first vote decides; quorum = N of M.' });
    }
    const seats = Array.isArray(cfg.approvers) ? cfg.approvers.length : 0;
    if (cfg.rule === 'quorum' && !quorumOk(Number(cfg.quorum), seats)) {
        pushE({ code: 'approval.rule_invalid', severity: 'error', path: at + '.approval.quorum', message: `Step ${step.id}: quorum must be a whole number between 1 and the number of seats${seats ? ` (${seats})` : ''}.`, hint: 'e.g. 2 of 3 approvers.' });
    }
}

/** The optional second-stage sign-off. @type {ApprovalCheck} */
function checkFinalApprover({ pushE }, step, at, cfg) {
    if (isSet(cfg.finalApprover) && !seatShapeOk(cfg.finalApprover)) {
        pushE({ code: 'approval.final_approver_invalid', severity: 'error', path: at + '.approval.finalApprover', message: `Step ${step.id}: the final approver must be one person ({ userId }) or one group ({ groupId }).`, hint: 'They give the last sign-off after the panel (or the approver) says yes.' });
    }
}

/**
 * Where a stage finding points: the sink, the step, the stage's path and how a
 * message names it ("stage 2").
 * @typedef {{ pushE: Sinks['pushE'], step: any, sp: string, label: string }} StageAt
 */

/**
 * A stage's key: text, and unique across the chain (votes are filed under it).
 * @param {StageAt} where
 * @param {unknown} key
 * @param {Set<string>} keys
 */
function checkStageKey({ pushE, step, sp, label }, key, keys) {
    if (!isSet(key)) return;
    if (typeof key !== 'string' || !key.trim()) {
        pushE({ code: 'approval.stages_invalid', severity: 'error', path: sp + '.key', message: `Step ${step.id}: ${label}'s key must be text.`, hint: 'Leave the key empty and one is assigned — it is what already-cast votes are filed under, so do not rename it by hand.' });
    } else if (keys.has(key.trim())) {
        pushE({ code: 'approval.stages_invalid', severity: 'error', path: sp + '.key', message: `Step ${step.id}: two stages share the key "${key.trim()}".`, hint: 'Every stage needs its own key — votes are filed under it, so a duplicate would mix two stages\' votes together.' });
    } else {
        keys.add(key.trim());
    }
}

/**
 * A stage's name, description, rule, quorum and condition.
 * @param {StageAt} where
 * @param st the stage as written
 */
function checkStageText({ pushE, step, sp, label }, st) {
    if (isSet(st.name) && (typeof st.name !== 'string' || st.name.length > MAX_STAGE_NAME_LEN)) {
        pushE({ code: 'approval.stage_name_invalid', severity: 'error', path: sp + '.name', message: `Step ${step.id}: ${label}'s name must be text of at most ${MAX_STAGE_NAME_LEN} characters.`, hint: 'Name it after who decides — "Team lead", "Finance", "Director sign-off".' });
    }
    if (isSet(st.description) && (typeof st.description !== 'string' || st.description.length > MAX_STAGE_DESCRIPTION_LEN)) {
        pushE({ code: 'approval.stage_description_invalid', severity: 'error', path: sp + '.description', message: `Step ${step.id}: ${label}'s description must be text of at most ${MAX_STAGE_DESCRIPTION_LEN} characters.`, hint: 'Tell this stage\'s approvers what they are being asked to check.' });
    }
    if (st.rule !== undefined && !STAGE_RULES.includes(st.rule)) {
        pushE({ code: 'approval.stage_rule_invalid', severity: 'error', path: sp + '.rule', message: `Step ${step.id}: ${label}'s decision rule must be "all", "first" or "quorum".`, hint: 'all = everyone in this stage must approve; first = the first vote moves it on; quorum = N of M.' });
    }
    const count = Array.isArray(st.approvers) ? st.approvers.length : 0;
    if (st.rule === 'quorum' && !quorumOk(Number(st.quorum), count)) {
        pushE({ code: 'approval.stage_rule_invalid', severity: 'error', path: sp + '.quorum', message: `Step ${step.id}: ${label}'s quorum must be a whole number between 1 and its number of approvers${count ? ` (${count})` : ''}.`, hint: 'e.g. 2 of 3.' });
    }
    if (isSet(st.when) && typeof st.when !== 'string') {
        pushE({ code: 'approval.stages_invalid', severity: 'error', path: sp + '.when', message: `Step ${step.id}: ${label}'s condition must be text.`, hint: 'Write a condition like steps.invoice.output.amount > 5000 (an expression: no {{ }}) — the stage is skipped when it is not met.' });
    }
}

/**
 * One stage of the chain; returns the seats it adds to the chain's total.
 * @param {{ pushE: Sinks['pushE'], step: any, at: string, keys: Set<string> }} chain
 * @param st the stage as written
 * @param {number} i
 */
function checkStage({ pushE, step, at, keys }, st, i) {
    const sp = `${at}.approval.stages[${i}]`;
    const label = `stage ${i + 1}`;
    if (!st || typeof st !== 'object' || Array.isArray(st)) {
        pushE({ code: 'approval.stages_invalid', severity: 'error', path: sp, message: `Step ${step.id}: ${label} must be an object with its own approvers.`, hint: 'Each stage names who decides at that point in the chain.' });
        return 0;
    }
    const seats = st.approvers;
    const seatsOk = Array.isArray(seats) && seats.length >= 1 && seats.length <= MAX_SEATS_PER_STAGE && seats.every(seatShapeOk);
    if (!seatsOk) {
        pushE({ code: 'approval.stages_invalid', severity: 'error', path: sp + '.approvers', message: `Step ${step.id}: ${label} needs 1 to ${MAX_SEATS_PER_STAGE} approvers, each one person ({ userId }) or one group ({ groupId }).`, hint: 'A stage with nobody in it can never be decided.' });
    }
    const where = { pushE, step, sp, label };
    checkStageKey(where, st.key, keys);
    checkStageText(where, st);
    return seatsOk ? seats.length : 0;
}

/**
 * The legacy approver fields a stage chain supersedes, with how a finding
 * names each one.
 */
const SUPERSEDED_BY_STAGES = [['assignee', 'a single approver'], ['approvers', 'a panel'], ['finalApprover', 'a final approver'], ['escalateTo', 'an escalation']];

/**
 * Stage chain (sequential approvals): `stages` is the modern shape and
 * supersedes every legacy field: an ORDERED list of up to five named steps,
 * each with its own approvers and its own rule. Only the current stage's people
 * are asked, and only when their turn arrives. Shape only — org membership is
 * checked at save/run time like the assignee.
 * @type {ApprovalCheck}
 */
function checkStages(ctx, step, at, cfg) {
    if (!isSet(cfg.stages)) return;
    const { pushE } = ctx;
    const stages = cfg.stages;
    if (!Array.isArray(stages) || stages.length < 1 || stages.length > MAX_APPROVAL_STAGES) {
        pushE({ code: 'approval.stages_invalid', severity: 'error', path: at + '.approval.stages', message: `Step ${step.id}: approval stages must be a list of 1 to ${MAX_APPROVAL_STAGES} steps.`, hint: `Add up to ${MAX_APPROVAL_STAGES} stages — the request goes to each one in turn.` });
    } else {
        const chain = { pushE, step, at, keys: new Set() };
        const totalSeats = stages.reduce((sum, st, i) => sum + checkStage(chain, st, i), 0);
        if (totalSeats > MAX_TOTAL_SEATS) {
            pushE({ code: 'approval.stages_invalid', severity: 'error', path: at + '.approval.stages', message: `Step ${step.id}: the stages have ${totalSeats} approvers between them — the limit across the whole chain is ${MAX_TOTAL_SEATS}.`, hint: 'Use groups instead of listing every person, or drop a stage.' });
        }
    }
    // Stages supersede the legacy fields rather than combining with them.
    // Silently ignoring a configured approver is the one outcome worse than
    // refusing to save: someone believes they are in the chain and is never
    // asked.
    for (const [field, human] of SUPERSEDED_BY_STAGES) {
        if (isSet(cfg[field])) {
            pushE({ code: 'approval.stages_conflict', severity: 'error', path: `${at}.approval.${field}`, message: `Step ${step.id}: this approval uses stages, so ${human} set alongside them would never be asked.`, hint: `Move ${human === 'an escalation' ? 'the escalation target' : 'them'} into a stage, or remove the stages.` });
        }
    }
}

/**
 * Reminder + escalation clocks: hours 1..720; a clock at or past the deadline
 * is dropped at run time (nudging someone about an approval that already
 * expired is worse than silence) — say so here rather than let them discover
 * it a week later.
 * @param {unknown} v
 */
const hoursOk = (v) => Number.isFinite(Number(v)) && Number(v) >= 1 && Number(v) <= APPROVAL_MAX_EXPIRY_HOURS;
/**
 * @param cfg the approval config
 * @param {unknown} v
 */
const beatsDeadline = (cfg, v) => {
    const expiryH = Number(cfg.expiresInHours);
    return Number.isFinite(expiryH) && expiryH > 0 && Number(v) >= expiryH;
};

/** @type {ApprovalCheck} */
function checkReminder({ pushW }, step, at, cfg) {
    if (!isSet(cfg.remindAfterHours)) return;
    if (!hoursOk(cfg.remindAfterHours)) {
        pushW({ code: 'approval.reminder_invalid', severity: 'warning', path: at + '.approval.remindAfterHours', message: `Step ${step.id}: the reminder must be 1 to ${APPROVAL_MAX_EXPIRY_HOURS} hours after the request.`, hint: 'Remove it, or pick a whole number of hours.' });
    } else if (beatsDeadline(cfg, cfg.remindAfterHours)) {
        pushW({ code: 'approval.reminder_invalid', severity: 'warning', path: at + '.approval.remindAfterHours', message: `Step ${step.id}: the reminder fires at or after the ${Number(cfg.expiresInHours)}h deadline, so it will never be sent.`, hint: 'Set the reminder earlier than the deadline.' });
    }
}

/** @type {ApprovalCheck} */
function checkEscalation({ pushE, pushW }, step, at, cfg) {
    const hasEscTarget = isSet(cfg.escalateTo);
    const hasEscHours = isSet(cfg.escalateAfterHours);
    if (!hasEscTarget && !hasEscHours) return;
    if (!hasEscTarget || !seatShapeOk(cfg.escalateTo)) {
        pushE({ code: 'approval.escalation_invalid', severity: 'error', path: at + '.approval.escalateTo', message: `Step ${step.id}: escalation needs one person ({ userId }) or one group ({ groupId }) to escalate to.`, hint: 'Pick who takes over, or remove the escalation.' });
    }
    if (!hasEscHours || !hoursOk(cfg.escalateAfterHours)) {
        pushE({ code: 'approval.escalation_invalid', severity: 'error', path: at + '.approval.escalateAfterHours', message: `Step ${step.id}: escalation needs a delay of 1 to ${APPROVAL_MAX_EXPIRY_HOURS} hours.`, hint: 'Say how long the original approver gets before it escalates.' });
    } else if (beatsDeadline(cfg, cfg.escalateAfterHours)) {
        pushW({ code: 'approval.escalation_invalid', severity: 'warning', path: at + '.approval.escalateAfterHours', message: `Step ${step.id}: the escalation fires at or after the ${Number(cfg.expiresInHours)}h deadline, so it will never happen.`, hint: 'Escalate earlier than the deadline.' });
    }
}

/** @param x an attachments entry */
const isBindingAttachment = (x) => !!x && typeof x === 'object' && typeof x.binding === 'string' && !!x.binding.trim();

/** @type {ApprovalCheck} */
function checkAttachments({ pushE }, step, at, cfg) {
    const atts = cfg.attachments;
    if (!isSet(atts)) return;
    if (!Array.isArray(atts) || atts.length > APPROVAL_MAX_ATTACHMENTS || !atts.every(isBindingAttachment)) {
        pushE({ code: 'approval.attachments_invalid', severity: 'error', path: at + '.approval.attachments', message: `Step ${step.id}: attachments must be a list of up to ${APPROVAL_MAX_ATTACHMENTS} bindings to files earlier steps produced.`, hint: 'Each attachment needs a binding like {{steps.doc.output.fileId}} pointing at a generated document.' });
    }
}

/**
 * The form-contract vocabulary, INPUT types only: display fields belong to
 * attachments/details here, and these input types have no place on the
 * approval card, which is a decision surface, not a form page.
 */
const FIELD_TYPES_REFUSED = {
    // Approver uploads need the public-form upload ledger — out of scope for
    // in-app approvals.
    file: { message: 'approvers cannot be asked to upload files.', hint: 'Use attachments to SHOW the approver files; ask for text, numbers, dates or choices.' },
    // The card has no picker to render, and an approver asked to "choose a
    // transcript" would see an empty box. The decision material belongs in
    // `attachments` or `details`, gathered before the approval.
    app_pick: { message: 'approvers cannot be asked to pick a record from an app.', hint: 'Gather it on a Form page before the approval, and SHOW it to the approver with attachments or details.' },
};

/** @type {ApprovalCheck} */
function checkFields({ pushE }, step, at, cfg) {
    const fields = cfg.fields;
    if (!isSet(fields)) return;
    const issue = (/** @type {string} */ message, /** @type {string} */ hint) => pushE({ code: 'approval.fields_invalid', severity: 'error', path: at + '.approval.fields', message: `Step ${step.id}: ${message}`, hint });
    if (!Array.isArray(fields) || fields.length > APPROVAL_MAX_FIELDS) {
        issue(`approval questions must be a list of up to ${APPROVAL_MAX_FIELDS} fields.`, 'Add each question the approver should answer as its own field.');
        return;
    }
    if (!fields.length) return;
    const { validateFormDeclaration } = require('../../formTriggerContract');
    for (const fe of validateFormDeclaration({ title: 'Approval', fields }, { requireFields: false, allowDisplayFields: false })) {
        issue(fe.message, fe.hint || 'Fix the question definition — every field needs a name, a label and a supported type.');
    }
    for (const f of fields) {
        const refused = f && Object.hasOwn(FIELD_TYPES_REFUSED, f.type) ? FIELD_TYPES_REFUSED[/** @type {keyof typeof FIELD_TYPES_REFUSED} */ (f.type)] : null;
        if (refused) issue(refused.message, refused.hint);
    }
}

/** Every check, in the order its findings are reported. @type {ApprovalCheck[]} */
const APPROVAL_CHECKS = [
    checkQuestion, checkExpiry, checkForEach, checkAssignee, checkDetails,
    checkPanel, checkFinalApprover, checkStages, checkReminder, checkEscalation,
    checkAttachments, checkFields,
];

/**
 * An approval could otherwise go live asking nothing at all — the approver
 * would see "Approval requested" and have to open the automation to find out
 * what they were agreeing to.
 * @param {Sinks} ctx
 * @param step the approval step
 * @param {string} at
 */
function checkApproval(ctx, step, at) {
    if (step.type !== 'approval') return;
    const cfg = step.approval || {};
    for (const check of APPROVAL_CHECKS) check(ctx, step, at, cfg);
}

module.exports = { checkApproval };
