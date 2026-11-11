// @typecheck strict
/**
 * App Studio catalog — the field table of an approval request: what `request_approval` asks and
 * of whom. `await_approval` (steps/await_approval.js) asks with the same fields, so the two can
 * never drift apart. A function, not a shared object: every step kind gets its own table, which
 * the catalogue then extends (the error envelope, a server step's guard).
 */

'use strict';

/** A fresh copy of the request fields, in catalogue order. */
function requestApprovalFields() {
    return {
        prompt: { type: 'binding', required: true },
        details: { type: 'binding' },                       // markdown shown to the approver
        fields: { type: 'approvalQuestions' },              // questions answered at decide time
        assigneeUserId: { type: 'string', maxLen: 80, nullable: true },
        assigneeGroupId: { type: 'string', maxLen: 80, nullable: true },
        // Panel (multiple approvers) — used INSTEAD of the assignee.
        // Seats are the users plus the groups (a group seat is filled by
        // whichever member votes first), ≤ 10 in total. `rule` decides
        // how votes resolve; quorumCount is N for rule 'quorum'; the
        // final approver is an optional second sign-off stage.
        approverUserIds: { type: 'stringList' },
        approverGroupIds: { type: 'stringList' },
        rule: { type: 'enum', values: ['all', 'first', 'quorum'], default: 'all' },
        quorumCount: { type: 'int', min: 1, max: 10 },
        finalApproverUserId: { type: 'string', maxLen: 80, nullable: true },
        finalApproverGroupId: { type: 'string', maxLen: 80, nullable: true },
        // Stages — an ORDERED chain of up to five named steps, each with
        // its own approvers and its own rule. Set INSTEAD of the assignee,
        // the panel and the final approver: those are the one-stage and
        // two-stage shapes written out longhand, and combining them with a
        // chain would leave a configured approver nobody ever asks.
        // A stage's optional `when` is evaluated ONCE, at request time,
        // against the action scope — which is how "over €5,000 also needs
        // the director" is expressed without a second action.
        stages: { type: 'approvalStages' },
        expiresInHours: { type: 'int', min: 0, max: 720 },  // absent = no deadline (0 too)
        // Nudge + takeover clocks; both must land before the deadline or
        // they are dropped at request time. Escalation WIDENS the decider
        // set (the original approver keeps their rights).
        remindAfterHours: { type: 'int', min: 1, max: 720 },
        escalateToUserId: { type: 'string', maxLen: 80, nullable: true },
        escalateToGroupId: { type: 'string', maxLen: 80, nullable: true },
        escalateAfterHours: { type: 'int', min: 1, max: 720 },
        attachments: { type: 'binding' },                   // studio_attachment descriptor(s)
        context: { type: 'recordValues' },                  // { key: binding } — resolved at request time
        onDecided: { type: 'approvalOnDecided' },           // record-write hook, snapshotted
        resultVar: { type: 'string', maxLen: 60 },
    };
}

module.exports = { requestApprovalFields };
