/**
 * Approvals. Dispatched in-process from the approval lifecycle (request /
 * decide / withdraw / reaper expiry), org-scoped like Support — an approval
 * belongs to the organisation it was requested in.
 *
 * These events are the GENERAL-PURPOSE reaction channel: "when a quote is
 * approved, post to the team channel / send the customer an email / kick off
 * the next automation". App Studio's own primary channel is the on_decided
 * record-write hook (executed synchronously inside the decision), so an app
 * does not need an automation wired to react; these fire as well, for
 * everything that lives outside the app.
 *
 * `decision` on approval.decided is the FINAL STATUS of the row — approved,
 * rejected, expired (nobody decided in time) or cancelled (withdrawn) —
 * so one subscription can route all four outcomes with a filter.
 *
 * Rows without an organisation (consumer accounts) dispatch user-scoped to
 * the approval's owner instead — see automation/approvalEvents.js.
 */
module.exports = { TRIGGER_SOURCES: [{
        id: 'approvals',
        label: 'Approvals',
        order: 61,
        defaultEvent: 'approval.decided',
        availability: {
            kind: 'check',
            check: 'approvals',
        },
        events: [
            {
                id: 'approval.decided',
                label: 'Approval decided',
                fields: [
                    'approvalId',
                    'source',
                    'decision',
                    'reason',
                    'answers',
                    'prompt',
                    'automationId',
                    'runId',
                    'studioAppId',
                    'requestedBy',
                    'decidedBy',
                    'decidedByName',
                    'assigneeUserId',
                    'assigneeGroupId',
                    'votes',
                    'stages',
                    'stage',
                    'context',
                ],
                sample: {
                    approvalId: 'apr_9f2c41d0e6b7a8f31245',
                    source: 'run',
                    decision: 'approved',
                    reason: 'Discount is within policy.',
                    answers: { poNumber: 'PO-4471' },
                    prompt: 'Send the €12.400 quote to Jansen BV?',
                    automationId: 'auto_quote_followup',
                    runId: 'run_7d81b2',
                    studioAppId: null,
                    requestedBy: null,
                    decidedBy: 'user-42',
                    decidedByName: 'Fleur de Vries',
                    assigneeUserId: 'user-42',
                    assigneeGroupId: null,
                    // Panel evidence — null for single-approver rows.
                    votes: [
                        { by: 'user-42', name: 'Fleur de Vries', decision: 'approve', reason: null, stage: 'panel' },
                        { by: 'user-7', name: 'Daan Bakker', decision: 'approve', reason: 'Binnen budget.', stage: 'panel' },
                    ],
                    // The chain, when the approval had one — null for single
                    // approver and panel rows. `stage` is where it finished.
                    stages: [
                        { key: 's1', name: 'Teamleider', description: null, rule: 'first', skipped: false },
                        { key: 's2', name: 'Finance', description: 'Past dit binnen het budget?', rule: 'all', skipped: false },
                        { key: 's3', name: 'Directie', description: null, rule: 'first', skipped: true },
                    ],
                    stage: 's2',
                    context: { recordId: 'rec_18' },
                },
                scope: 'org',
                source: {
                    kind: 'push',
                },
            },
            {
                id: 'approval.requested',
                label: 'Approval requested',
                fields: [
                    'approvalId',
                    'source',
                    'prompt',
                    'automationId',
                    'runId',
                    'studioAppId',
                    'requestedBy',
                    'assigneeUserId',
                    'assigneeGroupId',
                    'expiresAt',
                    'stages',
                    'stage',
                    'context',
                ],
                sample: {
                    approvalId: 'apr_9f2c41d0e6b7a8f31245',
                    source: 'run',
                    prompt: 'Send the €12.400 quote to Jansen BV?',
                    automationId: 'auto_quote_followup',
                    runId: 'run_7d81b2',
                    studioAppId: null,
                    requestedBy: null,
                    assigneeUserId: 'user-42',
                    assigneeGroupId: null,
                    expiresAt: '2026-09-08T17:00:00.000Z',
                    // The chain, when the approval has one — `stage` is the
                    // step now waiting, so a subscriber can announce "Finance
                    // is up" without reading the row.
                    stages: [
                        { key: 's1', name: 'Teamleider', description: null, rule: 'first', skipped: false },
                        { key: 's2', name: 'Finance', description: 'Past dit binnen het budget?', rule: 'all', skipped: false },
                    ],
                    stage: 's1',
                    context: { recordId: 'rec_18' },
                },
                scope: 'org',
                source: {
                    kind: 'push',
                },
            },
        ],
    }] };
