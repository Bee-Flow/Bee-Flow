/**
 * The ONE shape of an approval step's output, whoever produced the decision: a
 * person deciding a live approval, the default a resume injects, a dry run's
 * synthesis or a test harness. Downstream steps bind `steps.<id>.output.*`, so
 * every producer must hand them the same keys:
 *
 *   { approved, by, reason, decidedAt, answers, votes }
 *
 *   approved   boolean
 *   by         the deciding user id, or null
 *   reason     the decider's comment, or null
 *   decidedAt  ISO timestamp (now when not given)
 *   answers    the approver's answers to the step's questions; {} when none
 *   votes      a panel's votes; [] when not a panel
 *
 * Nothing else: whether an output was synthesised is marked at the step level
 * (`_dryRun` / dryRunSynthesised), by the producers that synthesise it.
 *
 * Pure, requires nothing.
 */

export type ApprovalVote = Record<string, unknown>;

export type ApprovalOutput = {
    approved: boolean;
    by: string | null;
    reason: string | null;
    decidedAt: string;
    answers: Record<string, unknown>;
    votes: ApprovalVote[];
};

export type ApprovalDecisionInput = {
    approved?: unknown;
    by?: unknown;
    reason?: unknown;
    decidedAt?: unknown;
    answers?: unknown;
    votes?: unknown;
};

const isPlainObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

function isoOf(x: unknown, now: () => Date): string {
    if (x instanceof Date && Number.isFinite(x.getTime())) return x.toISOString();
    if (typeof x === 'string' && x && Number.isFinite(Date.parse(x))) return new Date(x).toISOString();
    return now().toISOString();
}

/** The approval output for a decision. Unknown or malformed fields fall back to their empty value. */
export function approvalOutput(input: ApprovalDecisionInput = {}, now: () => Date = () => new Date()): ApprovalOutput {
    const d = isPlainObject(input) ? input : {};
    return {
        approved: d.approved === true,
        by: typeof d.by === 'string' && d.by ? d.by : null,
        reason: typeof d.reason === 'string' && d.reason ? d.reason : null,
        decidedAt: isoOf(d.decidedAt, now),
        answers: isPlainObject(d.answers) ? { ...d.answers } : {},
        votes: Array.isArray(d.votes) ? d.votes.filter(isPlainObject).map((v) => ({ ...v })) : [],
    };
}
