// The words and choices of Cowork's own proposals (../../api/coworkProposals.ts): which one shows where, and what it
// says. A repair is a need (the item's "Needs you" strip); a fixed-step offer is not (a quiet line on the Plan tab).
import type { TranslateFn } from '@/hooks/useTranslation';
import type { CoworkProposal, ProposalReplay } from '@/api/coworkProposals';

/** The open repair of an item, if there is one. */
export function openRepair(list: readonly CoworkProposal[] | undefined): CoworkProposal | null {
    return list?.find((p) => p.kind === 'repair' && p.status === 'open') ?? null;
}

/** The open fixed-step offer of an item, if there is one. */
export function openOffer(list: readonly CoworkProposal[] | undefined): CoworkProposal | null {
    return list?.find((p) => p.kind === 'fixed_step' && p.status === 'open') ?? null;
}

/** The newest approved fixed step that is still the plan and can be undone. */
export function madeFixed(list: readonly CoworkProposal[] | undefined): CoworkProposal | null {
    return list?.find((p) => p.kind === 'fixed_step' && p.status === 'approved' && p.undoVersion !== null) ?? null;
}

/** What Cowork fixes by itself: a reference, or the order of the steps (server core/cowork/repairs/autoResolve.mts). */
const AUTO_FIXES: ReadonlySet<string> = new Set(['reference_fixed', 'wiring_fixed']);

/** The newest fix Cowork made by itself that is still the plan, with its Undo. */
export function autoFixed(list: readonly CoworkProposal[] | undefined): CoworkProposal | null {
    return list?.find((p) => AUTO_FIXES.has(p.reasonCode) && p.status === 'approved' && p.undoVersion !== null) ?? null;
}

/** "Fixed automatically: 'A week ago' now reads from 'Now', 'AI step' now waits for 'Get summary'." */
export function autoFixLine(fix: Pick<CoworkProposal, 'reasonCode' | 'stepTitle' | 'wiring'>, t: TranslateFn): string {
    if (fix.reasonCode !== 'wiring_fixed') return t('cowork_resolver.note.fixed', "Fixed automatically: step '{step}' was reading the wrong field.", { step: fix.stepTitle ?? '' });
    const changes = (fix.wiring ?? []).map((c) => (c.kind === 'waits'
        ? t('cowork_wiring.note.waits', "'{step}' now waits for '{other}'", { step: c.step, other: c.other })
        : t('cowork_wiring.note.reads', "'{step}' now reads from '{other}'", { step: c.step, other: c.other })));
    return t('cowork_wiring.note.fixed', 'Fixed automatically: {changes}.', { changes: changes.join(', ') || (fix.stepTitle ?? '') });
}

/** Why a repair is offered, in one line. */
export function repairLine(proposal: Pick<CoworkProposal, 'reasonCode' | 'stepTitle'>, t: TranslateFn): string {
    if (proposal.reasonCode === 'reference_unresolved') return t('cowork_resolver.repair.reference', "Step '{step}' found nothing to work on. A fix is ready.", { step: proposal.stepTitle ?? '' });
    if (proposal.reasonCode === 'wiring_broken') return t('cowork_wiring.repair.wiring', "'{step}' reads from a step that does not run before it. A fix is ready.", { step: proposal.stepTitle ?? '' });
    if (proposal.reasonCode === 'goal_under_target') return t('cowork_proposals.need.goal_under', 'Stayed under its goal three times in a row. A fix is ready.');
    return t('cowork_proposals.need.failed_twice', "Failed twice at '{step}'. A fix is ready.", { step: proposal.stepTitle ?? '' });
}

/** The past runs a replay replayed (those it could not replay left out). */
const replayed = (replay: ProposalReplay): number => replay.same + replay.differs + replay.partial;

/** How the replay of a proposal came out, in one line. */
export function replayLine(replay: ProposalReplay | null, t: TranslateFn): string {
    if (!replay || replayed(replay) === 0) return t('cowork_proposals.replay.none', 'There were no past runs to replay it on.');
    return t('cowork_proposals.replay.result', 'Replayed on {full} past runs: {same} the same, {differs} different.', {
        full: replayed(replay), same: replay.same, differs: replayed(replay) - replay.same,
    });
}

/** The quiet line of a fixed-step offer. */
export function offerLine(proposal: CoworkProposal, t: TranslateFn): string {
    const replay = proposal.replay;
    return t('cowork_proposals.offer.line', 'One step can run without AI: the same in {same} of {full}.', {
        same: replay?.same ?? 0, full: replay ? replayed(replay) : 0,
    });
}
