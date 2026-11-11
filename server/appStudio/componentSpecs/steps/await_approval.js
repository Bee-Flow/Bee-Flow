// @typecheck strict
/**
 * Step kind `await_approval`: asks for an approval and waits for the decision. The request is the
 * one `request_approval` makes (same fields, same deciders, same Approvals inbox); the run then
 * goes on hold (runPause.mts) until somebody decides, and continues with the decision as the
 * step's result. Only a run on the server can wait like that: an action with `runOn: 'server'`
 * or `background: true`. Executor: actionExecutor/steps/await_approval.mts; the decision side is
 * appStudio/approvalWaits.mts.
 */

'use strict';

const { requestApprovalFields } = require('../approvalRequestFields');

/** The longest timeout, in hours: the deadline an approval request may have (request_approval expiresInHours). */
const MAX_TIMEOUT_HOURS = 720;

/** The request fields, with the request's deadline replaced by the step's timeout. */
function awaitApprovalFields() {
    /** @type {Record<string, Record<string, unknown>>} */
    const out = {};
    for (const [name, spec] of Object.entries(requestApprovalFields())) {
        if (name === 'resultVar') continue;
        if (name === 'expiresInHours') {
            out.timeoutHours = {
                type: 'int', min: 1, max: MAX_TIMEOUT_HOURS,
                description: `How long the request stays open, in hours (1 to ${MAX_TIMEOUT_HOURS}). Then it expires and the step goes on with decision "expired". Left out: it waits until someone decides (at most the longest wait the server allows).`,
            };
            continue;
        }
        out[name] = spec;
    }
    out.resultVar = { type: 'string', maxLen: 60, description: 'The variable that gets the decision: { decision, reason, answers, decidedBy, decidedByName, decidedAt, approvalId }.' };
    return out;
}

module.exports = {
    kind: 'await_approval',
    since: 3,
    side: 'server',
    fields: awaitApprovalFields(),
    childSlots: [],
    // It asks a person: running it again would ask twice.
    retrySafe: false,
    budget: 'light',
    handler: 'file',
    inLoop: {
        severity: 'warning', code: 'action.await_approval_in_loop',
        message: 'This loop waits for a separate decision in every round, one after the other.',
        hint: 'Ask once for the whole list (put the rows in `details` or `context`), unless every row really needs its own decision.',
    },
    // A click cannot wait for days: only a run on the server holds it (runOn: 'server' or background).
    // A test run never asks anybody: the decision is mocked (approved unless the mock says otherwise).
    policy: { click: 'refuse', background: 'run', mailboxHook: 'refuse', unattended: 'run', mcpRun: 'refuse', mcpDryRun: 'mock', public: 'refuse' },
    /** @param {Record<string, unknown>} s */
    summary: (s) => `await_approval${typeof s.resultVar === 'string' && s.resultVar ? `→${s.resultVar}` : ''}`,
    description: 'Asks for an approval and waits for the decision before the next step. '
        + 'The request is the one request_approval makes, with the same fields (prompt, details, questions in `fields`, assigneeUserId / assigneeGroupId, a panel, stages, reminders, attachments, context, onDecided) and the same deciders in the Approvals inbox; without an approver the app owner decides. '
        + 'The run is put on hold until someone decides, then goes on with the decision in `resultVar`: { decision: "approved" | "rejected" | "expired" | "cancelled", reason, answers, decidedBy, decidedByName, decidedAt, approvalId }. Branch on it with a condition, e.g. vars.ok.decision == "approved", and read the approver\'s answers as vars.ok.answers.<question>. '
        + '`timeoutHours` (1 to 720) closes the request after that many hours and the step goes on with decision "expired". A withdrawn request gives "cancelled"; cancelling the run withdraws its open request. '
        + 'Only an action that runs on the server can wait: set runOn: "server" (the page waits for the end) or background: true on the sequence. Not on a public page, not from a mailbox hook and not inside a parallel branch. '
        + 'In app_run_action and saved tests nobody is asked: the step goes on as approved, and a mock gives another decision, e.g. mock { "steps[1]": { "decision": "rejected", "reason": "Too expensive" } } or just "rejected". '
        + 'Example: { "kind": "await_approval", "prompt": { "kind": "static", "value": "Approve this order?" }, "assigneeGroupId": "grp_finance", "timeoutHours": 48, "resultVar": "approval" }.',
};
