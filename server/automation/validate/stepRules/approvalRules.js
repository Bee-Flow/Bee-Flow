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

function checkApproval(ctx, step, at) {
    const { pushE, pushW } = ctx;
    // An approval is the one step whose entire payload is a sentence a
    // human reads before deciding. Until now the validator read NO field
    // off it, so an approval could go live asking nothing at all — the
    // approver saw "Approval requested" and had to open the routine to
    // find out what they were agreeing to.
    if (step.type === 'approval') {
        // Mirrors the engine's own fallback (renderApprovalPrompt): the
        // builder writes `prompt`, but `title` is the legacy field that
        // imported and pre-editor definitions carry — and an approval with
        // a title DOES reach its approver with a question, so flagging it
        // would report working routines as broken.
        const hasQuestion = ['prompt', 'title'].some(
            f => typeof step[f] === 'string' && step[f].trim(),
        );
        if (!hasQuestion) {
            pushE({ code: 'approval.prompt_missing', severity: 'error', path: at + '.prompt', message: `Step ${step.id}: an approval needs a question for the approver.`, hint: 'Write what the person is being asked to approve. Use {{...}} to include values from earlier steps.' });
        }
        const hrs = step.approval && step.approval.expiresInHours;
        if (hrs !== undefined && (!Number.isFinite(hrs) || hrs < 0 || hrs > APPROVAL_MAX_EXPIRY_HOURS)) {
            pushW({ code: 'approval.expiry_invalid', severity: 'warning', path: at + '.approval', message: `Step ${step.id}: the approval deadline must be between 0 and ${APPROVAL_MAX_EXPIRY_HOURS} hours (30 days).`, hint: 'Use 0 for no deadline. Anything above 720 is capped at 30 days when the run starts.' });
        }
        // execForEachStep rethrows a run pause, so an approval with
        // `forEach` pauses on item 1 and items 2..n never run — the same
        // trap NESTED_FORBIDDEN_RULES catches for a loop body, reached by a
        // different door.
        if (step.forEach) {
            pushE({ code: 'approval.forEach_forbidden', severity: 'error', path: at + '.forEach', message: `Step ${step.id}: an approval cannot run once per item — the run pauses on the first item and the rest never run.`, hint: 'Approve once before the list, or move the approval after the loop.' });
        }
        const cfg = step.approval || {};
        // Assignee SHAPE only — this validator is pure/DB-free, so whether
        // the person or group actually belongs to the owner's org is
        // checked at save time (crud/persistDraft) and again at run time.
        if (cfg.assignee !== undefined && cfg.assignee !== null) {
            const a = cfg.assignee;
            const hasUser = typeof a?.userId === 'string' && a.userId.trim();
            const hasGroup = typeof a?.groupId === 'string' && a.groupId.trim();
            if (!a || typeof a !== 'object' || (!hasUser && !hasGroup) || (hasUser && hasGroup)) {
                pushE({ code: 'approval.assignee_invalid', severity: 'error', path: at + '.approval.assignee', message: `Step ${step.id}: the approver must be either one person ({ userId }) or one group ({ groupId }).`, hint: 'Pick a person or a group in the step\'s Approver section, or leave it empty so the routine\'s owner decides.' });
            }
        }
        if (cfg.details !== undefined && cfg.details !== null && typeof cfg.details !== 'string') {
            pushE({ code: 'approval.details_invalid', severity: 'error', path: at + '.approval.details', message: `Step ${step.id}: approval details must be text.`, hint: 'Write the extra information as text; use {{...}} to pull in values from earlier steps.' });
        }
        // ── Panel (multiple approvers) ───────────────────────────────
        // approvers is a list of SEATS ({userId}|{groupId}, ≤10); rule
        // decides how the votes resolve; quorum names N for rule=quorum;
        // finalApprover is the optional second-stage sign-off. Shape only
        // — org membership is checked at save/run time like the assignee.
        const seatShapeOk = (s) => {
            const u = typeof s?.userId === 'string' && s.userId.trim();
            const g = typeof s?.groupId === 'string' && s.groupId.trim();
            return !!(s && typeof s === 'object' && ((u && !g) || (g && !u)));
        };
        const panel = cfg.approvers;
        const hasPanelCfg = panel !== undefined && panel !== null;
        if (hasPanelCfg) {
            if (!Array.isArray(panel) || panel.length < 1 || panel.length > 10 || !panel.every(seatShapeOk)) {
                pushE({ code: 'approval.approvers_invalid', severity: 'error', path: at + '.approval.approvers', message: `Step ${step.id}: approvers must be a list of 1 to 10 seats, each one person ({ userId }) or one group ({ groupId }).`, hint: 'Pick the people or groups whose votes count.' });
            }
            if (cfg.assignee !== undefined && cfg.assignee !== null) {
                pushE({ code: 'approval.approvers_invalid', severity: 'error', path: at + '.approval.assignee', message: `Step ${step.id}: pick EITHER a single approver (assignee) OR a panel (approvers) — not both.`, hint: 'A panel of one seat behaves like a single approver.' });
            }
            if (cfg.escalateTo !== undefined && cfg.escalateTo !== null) {
                pushE({ code: 'approval.approvers_invalid', severity: 'error', path: at + '.approval.escalateTo', message: `Step ${step.id}: escalation is not supported together with a panel.`, hint: 'Use the optional final approver (and a reminder) instead — that is the panel\'s takeover mechanism.' });
            }
            if (cfg.rule !== undefined && !['all', 'first', 'quorum'].includes(cfg.rule)) {
                pushE({ code: 'approval.rule_invalid', severity: 'error', path: at + '.approval.rule', message: `Step ${step.id}: the decision rule must be "all", "first" or "quorum".`, hint: 'all = everyone must approve (one reject declines); first = the first vote decides; quorum = N of M.' });
            }
            if (cfg.rule === 'quorum') {
                const seats = Array.isArray(panel) ? panel.length : 0;
                const n = Number(cfg.quorum);
                if (!Number.isInteger(n) || n < 1 || (seats > 0 && n > seats)) {
                    pushE({ code: 'approval.rule_invalid', severity: 'error', path: at + '.approval.quorum', message: `Step ${step.id}: quorum must be a whole number between 1 and the number of seats${seats ? ` (${seats})` : ''}.`, hint: 'e.g. 2 of 3 approvers.' });
                }
            }
        } else if (cfg.rule !== undefined || cfg.quorum !== undefined) {
            pushW({ code: 'approval.rule_invalid', severity: 'warning', path: at + '.approval.rule', message: `Step ${step.id}: a decision rule only means something with a panel of approvers.`, hint: 'Add approvers, or remove the rule.' });
        }
        if (cfg.finalApprover !== undefined && cfg.finalApprover !== null && !seatShapeOk(cfg.finalApprover)) {
            pushE({ code: 'approval.final_approver_invalid', severity: 'error', path: at + '.approval.finalApprover', message: `Step ${step.id}: the final approver must be one person ({ userId }) or one group ({ groupId }).`, hint: 'They give the last sign-off after the panel (or the approver) says yes.' });
        }

        // ── Stage chain (sequential approvals) ───────────────────────
        // `stages` is the modern shape and supersedes every legacy field:
        // an ORDERED list of up to five named steps, each with its own
        // approvers and its own rule. Only the current stage's people are
        // asked, and only when their turn arrives. Shape only — org
        // membership is checked at save/run time like the assignee.
        if (cfg.stages !== undefined && cfg.stages !== null) {
            const stages = cfg.stages;
            if (!Array.isArray(stages) || stages.length < 1 || stages.length > MAX_APPROVAL_STAGES) {
                pushE({ code: 'approval.stages_invalid', severity: 'error', path: at + '.approval.stages', message: `Step ${step.id}: approval stages must be a list of 1 to ${MAX_APPROVAL_STAGES} steps.`, hint: `Add up to ${MAX_APPROVAL_STAGES} stages — the request goes to each one in turn.` });
            } else {
                let totalSeats = 0;
                const keys = new Set();
                stages.forEach((st, i) => {
                    const sp = `${at}.approval.stages[${i}]`;
                    const label = `stage ${i + 1}`;
                    if (!st || typeof st !== 'object' || Array.isArray(st)) {
                        pushE({ code: 'approval.stages_invalid', severity: 'error', path: sp, message: `Step ${step.id}: ${label} must be an object with its own approvers.`, hint: 'Each stage names who decides at that point in the chain.' });
                        return;
                    }
                    const seats = st.approvers;
                    if (!Array.isArray(seats) || seats.length < 1 || seats.length > MAX_SEATS_PER_STAGE || !seats.every(seatShapeOk)) {
                        pushE({ code: 'approval.stages_invalid', severity: 'error', path: sp + '.approvers', message: `Step ${step.id}: ${label} needs 1 to ${MAX_SEATS_PER_STAGE} approvers, each one person ({ userId }) or one group ({ groupId }).`, hint: 'A stage with nobody in it can never be decided.' });
                    } else {
                        totalSeats += seats.length;
                    }
                    if (st.key !== undefined && st.key !== null) {
                        if (typeof st.key !== 'string' || !st.key.trim()) {
                            pushE({ code: 'approval.stages_invalid', severity: 'error', path: sp + '.key', message: `Step ${step.id}: ${label}'s key must be text.`, hint: 'Leave the key empty and one is assigned — it is what already-cast votes are filed under, so do not rename it by hand.' });
                        } else if (keys.has(st.key.trim())) {
                            pushE({ code: 'approval.stages_invalid', severity: 'error', path: sp + '.key', message: `Step ${step.id}: two stages share the key "${st.key.trim()}".`, hint: 'Every stage needs its own key — votes are filed under it, so a duplicate would mix two stages\' votes together.' });
                        } else {
                            keys.add(st.key.trim());
                        }
                    }
                    if (st.name !== undefined && st.name !== null
                        && (typeof st.name !== 'string' || st.name.length > MAX_STAGE_NAME_LEN)) {
                        pushE({ code: 'approval.stage_name_invalid', severity: 'error', path: sp + '.name', message: `Step ${step.id}: ${label}'s name must be text of at most ${MAX_STAGE_NAME_LEN} characters.`, hint: 'Name it after who decides — "Team lead", "Finance", "Director sign-off".' });
                    }
                    if (st.description !== undefined && st.description !== null
                        && (typeof st.description !== 'string' || st.description.length > MAX_STAGE_DESCRIPTION_LEN)) {
                        pushE({ code: 'approval.stage_description_invalid', severity: 'error', path: sp + '.description', message: `Step ${step.id}: ${label}'s description must be text of at most ${MAX_STAGE_DESCRIPTION_LEN} characters.`, hint: 'Tell this stage\'s approvers what they are being asked to check.' });
                    }
                    if (st.rule !== undefined && !STAGE_RULES.includes(st.rule)) {
                        pushE({ code: 'approval.stage_rule_invalid', severity: 'error', path: sp + '.rule', message: `Step ${step.id}: ${label}'s decision rule must be "all", "first" or "quorum".`, hint: 'all = everyone in this stage must approve; first = the first vote moves it on; quorum = N of M.' });
                    }
                    if (st.rule === 'quorum') {
                        const n = Number(st.quorum);
                        const count = Array.isArray(seats) ? seats.length : 0;
                        if (!Number.isInteger(n) || n < 1 || (count > 0 && n > count)) {
                            pushE({ code: 'approval.stage_rule_invalid', severity: 'error', path: sp + '.quorum', message: `Step ${step.id}: ${label}'s quorum must be a whole number between 1 and its number of approvers${count ? ` (${count})` : ''}.`, hint: 'e.g. 2 of 3.' });
                        }
                    }
                    if (st.when !== undefined && st.when !== null && typeof st.when !== 'string') {
                        pushE({ code: 'approval.stages_invalid', severity: 'error', path: sp + '.when', message: `Step ${step.id}: ${label}'s condition must be text.`, hint: 'Write a condition like {{steps.invoice.output.amount}} > 5000 — the stage is skipped when it is not met.' });
                    }
                });
                if (totalSeats > MAX_TOTAL_SEATS) {
                    pushE({ code: 'approval.stages_invalid', severity: 'error', path: at + '.approval.stages', message: `Step ${step.id}: the stages have ${totalSeats} approvers between them — the limit across the whole chain is ${MAX_TOTAL_SEATS}.`, hint: 'Use groups instead of listing every person, or drop a stage.' });
                }
            }
            // Stages supersede the legacy fields rather than combining
            // with them. Silently ignoring a configured approver is the
            // one outcome worse than refusing to save: someone believes
            // they are in the chain and is never asked.
            for (const [field, human] of [['assignee', 'a single approver'], ['approvers', 'a panel'], ['finalApprover', 'a final approver'], ['escalateTo', 'an escalation']]) {
                if (cfg[field] !== undefined && cfg[field] !== null) {
                    pushE({ code: 'approval.stages_conflict', severity: 'error', path: `${at}.approval.${field}`, message: `Step ${step.id}: this approval uses stages, so ${human} set alongside them would never be asked.`, hint: `Move ${human === 'an escalation' ? 'the escalation target' : 'them'} into a stage, or remove the stages.` });
                }
            }
        }

        // Reminder + escalation clocks. Hours 1..720; a clock at or past
        // the deadline is dropped at run time (nudging someone about an
        // approval that already expired is worse than silence) — say so
        // here rather than let them discover it a week later.
        const hoursOk = (v) => Number.isFinite(Number(v)) && Number(v) >= 1 && Number(v) <= APPROVAL_MAX_EXPIRY_HOURS;
        const expiryH = Number(cfg.expiresInHours);
        const beatsDeadline = (v) => Number.isFinite(expiryH) && expiryH > 0 && Number(v) >= expiryH;
        if (cfg.remindAfterHours !== undefined && cfg.remindAfterHours !== null) {
            if (!hoursOk(cfg.remindAfterHours)) {
                pushW({ code: 'approval.reminder_invalid', severity: 'warning', path: at + '.approval.remindAfterHours', message: `Step ${step.id}: the reminder must be 1 to ${APPROVAL_MAX_EXPIRY_HOURS} hours after the request.`, hint: 'Remove it, or pick a whole number of hours.' });
            } else if (beatsDeadline(cfg.remindAfterHours)) {
                pushW({ code: 'approval.reminder_invalid', severity: 'warning', path: at + '.approval.remindAfterHours', message: `Step ${step.id}: the reminder fires at or after the ${expiryH}h deadline, so it will never be sent.`, hint: 'Set the reminder earlier than the deadline.' });
            }
        }
        const hasEscTarget = cfg.escalateTo !== undefined && cfg.escalateTo !== null;
        const hasEscHours = cfg.escalateAfterHours !== undefined && cfg.escalateAfterHours !== null;
        if (hasEscTarget || hasEscHours) {
            const t = cfg.escalateTo;
            const tUser = typeof t?.userId === 'string' && t.userId.trim();
            const tGroup = typeof t?.groupId === 'string' && t.groupId.trim();
            if (!hasEscTarget || !t || typeof t !== 'object' || (!tUser && !tGroup) || (tUser && tGroup)) {
                pushE({ code: 'approval.escalation_invalid', severity: 'error', path: at + '.approval.escalateTo', message: `Step ${step.id}: escalation needs one person ({ userId }) or one group ({ groupId }) to escalate to.`, hint: 'Pick who takes over, or remove the escalation.' });
            }
            if (!hasEscHours || !hoursOk(cfg.escalateAfterHours)) {
                pushE({ code: 'approval.escalation_invalid', severity: 'error', path: at + '.approval.escalateAfterHours', message: `Step ${step.id}: escalation needs a delay of 1 to ${APPROVAL_MAX_EXPIRY_HOURS} hours.`, hint: 'Say how long the original approver gets before it escalates.' });
            } else if (beatsDeadline(cfg.escalateAfterHours)) {
                pushW({ code: 'approval.escalation_invalid', severity: 'warning', path: at + '.approval.escalateAfterHours', message: `Step ${step.id}: the escalation fires at or after the ${expiryH}h deadline, so it will never happen.`, hint: 'Escalate earlier than the deadline.' });
            }
        }
        if (cfg.attachments !== undefined && cfg.attachments !== null) {
            const atts = cfg.attachments;
            if (!Array.isArray(atts) || atts.length > APPROVAL_MAX_ATTACHMENTS
                || atts.some(x => !x || typeof x !== 'object' || typeof x.binding !== 'string' || !x.binding.trim())) {
                pushE({ code: 'approval.attachments_invalid', severity: 'error', path: at + '.approval.attachments', message: `Step ${step.id}: attachments must be a list of up to ${APPROVAL_MAX_ATTACHMENTS} bindings to files earlier steps produced.`, hint: 'Each attachment needs a binding like {{steps.doc.output.fileId}} pointing at a generated document.' });
            }
        }
        if (cfg.fields !== undefined && cfg.fields !== null) {
            if (!Array.isArray(cfg.fields) || cfg.fields.length > APPROVAL_MAX_FIELDS) {
                pushE({ code: 'approval.fields_invalid', severity: 'error', path: at + '.approval.fields', message: `Step ${step.id}: approval questions must be a list of up to ${APPROVAL_MAX_FIELDS} fields.`, hint: 'Add each question the approver should answer as its own field.' });
            } else if (cfg.fields.length) {
                // The form-contract vocabulary, INPUT types only: display
                // fields belong to attachments/details here, and `file`
                // (approver uploads) needs the public-form upload ledger —
                // explicitly out of scope for in-app approvals.
                const { validateFormDeclaration } = require('../../formTriggerContract');
                const formIssues = validateFormDeclaration({ title: 'Approval', fields: cfg.fields }, { requireFields: false, allowDisplayFields: false });
                for (const fe of formIssues) {
                    pushE({ code: 'approval.fields_invalid', severity: 'error', path: at + '.approval.fields', message: `Step ${step.id}: ${fe.message}`, hint: fe.hint || 'Fix the question definition — every field needs a name, a label and a supported type.' });
                }
                for (const f of cfg.fields) {
                    if (f && f.type === 'file') {
                        pushE({ code: 'approval.fields_invalid', severity: 'error', path: at + '.approval.fields', message: `Step ${step.id}: approvers cannot be asked to upload files.`, hint: 'Use attachments to SHOW the approver files; ask for text, numbers, dates or choices.' });
                    }
                    if (f && f.type === 'app_pick') {
                        // Refused for the same reason as `file`: the
                        // approval card is a decision surface, not a form
                        // page — it has no picker to render, and an
                        // approver asked to "choose a transcript" would see
                        // an empty box. The decision material belongs in
                        // `attachments` or `details`, gathered before the
                        // approval.
                        pushE({ code: 'approval.fields_invalid', severity: 'error', path: at + '.approval.fields', message: `Step ${step.id}: approvers cannot be asked to pick a record from an app.`, hint: 'Gather it on a Form page before the approval, and SHOW it to the approver with attachments or details.' });
                    }
                }
            }
        }
    }
}

module.exports = { checkApproval };
