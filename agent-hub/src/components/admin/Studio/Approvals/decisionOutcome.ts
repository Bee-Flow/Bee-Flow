import type { TranslateFn } from '@/hooks/useTranslation';

/**
 * What a decision did, read from the server's answer. One reading for every
 * surface that decides an approval: the Approvals section (POST
 * /approvals/:id/decide) and the builder's approval bar (POST
 * /runs/:runId/approve-step) get the same answer from approvalService.decide,
 * so they must not tell the person two different stories about it.
 *
 *   vote_recorded       a panel or a stage took the vote; the approval still waits
 *   panel_final         the panel agreed; the final approver is next
 *   stage_advanced      this stage is done; the chain moved on to `stageName`
 *   approved            the run continues: 200 with the continuation, or 202
 *                       { pending, runId } while it still runs
 *   rejected            the run stopped here (ApprovalRejected)
 *   rejected_continued  the run continues on the step's "On rejected" branch
 */
type DecisionOutcome =
    | { kind: 'vote_recorded' }
    | { kind: 'panel_final' }
    | { kind: 'stage_advanced'; stageName: string | null; index: number; total: number }
    | { kind: 'approved'; runId: string | null; pending: boolean }
    | { kind: 'rejected'; runId: string | null }
    | { kind: 'rejected_continued'; runId: string | null; pending: boolean };

type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A staged vote that moved the chain on: the stage now waiting, with its place in the chain. */
function stageAdvance(res: Obj): DecisionOutcome | null {
    const progress = obj(res.progress);
    const nextKey = str(res.stage);
    if (progress?.kind !== 'stages' || !nextKey) return null;
    const stages = Array.isArray(progress.stages) ? progress.stages.map(obj) : [];
    const next = stages.find(s => s?.key === nextKey);
    const position = obj(progress.position);
    const index = num(position?.index);
    const total = num(position?.total);
    if (!next || index == null || total == null) return null;
    return { kind: 'stage_advanced', stageName: str(next.name), index, total };
}

/** The run a continuing decision hands on to: the 202's runId, or the continuation the 200 carries. */
function continuationId(res: Obj): string | null {
    return str(res.runId) ?? str(obj(res.run)?.id);
}

/**
 * The outcome of a decision from the server's answer. `decision` is what was
 * sent ('approve' | 'reject'); the answer's own `decision` wins when it says
 * more (a vote, or the reject a 202 carries).
 */
export function decisionOutcome(reply: unknown, decision: string): DecisionOutcome {
    const res = obj(reply) ?? {};
    if (res.decision === 'vote_recorded') {
        const advanced = stageAdvance(res);
        if (advanced) return advanced;
        return res.stage === 'final' ? { kind: 'panel_final' } : { kind: 'vote_recorded' };
    }
    const pending = res.pending === true;
    if ((str(res.decision) ?? decision) === 'reject') {
        // A reject that ended the run answers with that run, closed as
        // ApprovalRejected; one that continued answers with the continuation
        // (or a 202 naming it).
        const run = obj(res.run);
        const stopped = !pending && (!run || run.errorClass === 'ApprovalRejected');
        return stopped
            ? { kind: 'rejected', runId: str(run?.id) }
            : { kind: 'rejected_continued', runId: continuationId(res), pending };
    }
    return { kind: 'approved', runId: continuationId(res), pending };
}

/** The decision still waits on somebody: a vote, a passed stage, the panel's final sign-off. */
export function stillPending(outcome: DecisionOutcome): boolean {
    return outcome.kind === 'vote_recorded' || outcome.kind === 'panel_final' || outcome.kind === 'stage_advanced';
}

/**
 * The toast for an outcome. `following`: the surface follows the run it
 * continued (the builder's canvas), so it says so instead of "continuing".
 */
export function decisionOutcomeText(outcome: DecisionOutcome, t: TranslateFn, { following = false }: { following?: boolean } = {}): string {
    switch (outcome.kind) {
        case 'stage_advanced':
            return t('approvals.toast_stage_passed', 'This stage is done — it has moved on to {name} (stage {n} of {m}).', {
                name: outcome.stageName || t('approvals.stage_unnamed', 'this stage'),
                n: String(outcome.index),
                m: String(outcome.total),
            });
        case 'panel_final':
            return t('approvals.toast_panel_final', 'The panel approved — waiting for the final sign-off.');
        case 'vote_recorded':
            return t('approvals.toast_vote', 'Your vote is in — waiting for the other approvers.');
        case 'approved':
            return following
                ? t('automations.approval_outcome.approved_following', 'Approved — following the run.')
                : t('approvals.toast_approved', 'Approved — the run is continuing.');
        case 'rejected_continued':
            return following
                ? t('automations.approval_outcome.rejected_branch_following', 'Rejected — following the run on the rejected branch.')
                : t('automations.approval_outcome.rejected_branch', 'Rejected — the run continues on the rejected branch.');
        default:
            return t('approvals.toast_rejected', 'Rejected — the run has stopped.');
    }
}
