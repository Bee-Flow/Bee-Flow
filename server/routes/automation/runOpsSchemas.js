// @typecheck
// The bodies and queries of the run operations (routes/automation/webhooksAndRunOps.js),
// split out of it. Every schema is `.strict()`.
const { z, typeError } = require('../../utils/zod');
const { worded } = require('../../core/http/schemaParts');

// ── What a caller may send ──────────────────────────────────────────
//
// Every schema is `.strict()`: a key this router does not read is a client
// bug, and answering 200 to it means the person watches a setting they typed
// fail to stick with nothing on screen to explain it.

/**
 * A body that also accepts NO body at all. Express 5 leaves `req.body`
 * undefined when a POST carries none, and several of these are sent exactly
 * that way — an approve with no body has always meant "approve".
 */
const bodyOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object(shape).strict());

const STEP_ID_TEXT = 'triggerStepId is the id of a trigger on this automation.';
/** Omitted → the primary trigger. Which trigger it names is checked against the graph. */
const TriggerStepBody = bodyOf({
    triggerStepId: worded(STEP_ID_TEXT).trim().min(1, STEP_ID_TEXT).nullish(),
});

const DECISION_TEXT = 'decision is "approve" or "reject".';
/**
 * Absent, blank or null all mean approve: the builder's bar has one button and
 * it approves, and every deployed caller sends no body at all. The default may
 * never be WIDER than an explicit approval — it IS one.
 */
const Decision = z.preprocess((v) => {
    // Case folds, whitespace does NOT: " approve " is a caller that built the
    // value out of something, and on an approval gate an unreadable decision
    // is refused rather than guessed at.
    const said = typeof v === 'string' ? v.toLowerCase() : v;
    return said === undefined || said === null || said === '' ? 'approve' : said;
}, z.enum(['approve', 'reject'], { error: () => DECISION_TEXT }));
const Reason = worded('reason must be text.').trim().max(2000, 'A reason is at most 2000 characters.').optional();

const ApproveStepBody = bodyOf({
    decision: Decision,
    reason: Reason,
    // The answers belong to the form the approval asked for, and the form
    // contract coerces them field by field.
    answers: z.unknown().optional(),
});

const ApproveRunBody = bodyOf({ decision: Decision, reason: Reason });
const CancelRunBody = bodyOf({ reason: Reason });

const SOURCE_TEXT = 'source is the id of a pick source.';
const FormPickBody = bodyOf({
    source: worded(SOURCE_TEXT).trim().min(1, SOURCE_TEXT),
    // clampQuery and clampLimit in automation/formPickRecord are the one
    // place these two are narrowed; narrowing them again here would be a
    // second answer to the same question.
    query: z.unknown().optional(),
    limit: z.unknown().optional(),
});

const AgentInvokeBody = bodyOf({
    // Whatever this automation's agent_call trigger declares it takes.
    args: z.record(z.string(), z.unknown(), { error: typeError({ invalid: 'args is an object of the automation\'s own inputs.' }) }).default({}),
});

const ATTEMPTS_TEXT = 'attempts is the attempt number of the step row, a whole number from 1.';
/** Which attempt's row the full output belongs to; omitted → the first. */
const FullOutputQuery = z.object({
    attempts: z.coerce.number({ error: typeError({ invalid: ATTEMPTS_TEXT }) })
        .int(ATTEMPTS_TEXT).min(1, ATTEMPTS_TEXT).default(1),
}).strict();

const RunFormBody = bodyOf({
    stepId: worded('stepId is the id of the form page being answered.').trim().min(1, 'stepId is the id of the form page being answered.').optional(),
    values: z.record(z.string(), z.unknown(), { error: typeError({ invalid: 'values maps a field id to its answer.' }) }).default({}),
});

module.exports = {
    TriggerStepBody, ApproveStepBody, ApproveRunBody, CancelRunBody, FormPickBody, AgentInvokeBody, FullOutputQuery, RunFormBody,
};
