/**
 * What an opened task (./CoworkTaskView.tsx) could do cheaper, one offer at a time, never in "Needs you":
 *
 *   - a task the AI or an agent does that went the same way every time: "Turn it into fixed steps?", with the
 *     comparison (what its last runs did every time, server usecases/coworkRoutine.mts). Accepting has Cowork make the
 *     steps from those runs and try them once; they run only once their owner approves them;
 *   - a steady AI step: "One step can run without AI", with how it did on the past runs (a fixed-step proposal);
 *   - after that was accepted, while it is still the plan: "'…' now runs without AI. · Undo".
 */
import { useState } from 'react';
import { appLabel } from '../coworkPlanModel';
import { madeFixed, openOffer } from '../coworkProposalModel';
import { BTN_LINK, BTN_PRIMARY, BTN_QUIET, CARD_HEAD, CARD_SOFT, Failure, META, ROW_ACTIONS, UndoNote } from './taskUi';
import { useCoworkProposalActions, useCoworkProposals } from '@/api/coworkProposals';
import { isRoutineWorthIt, useCoworkRoutine, type RoutineAdvice } from '@/api/coworkRoutine';
import type { CoworkProposal } from '@/api/coworkProposals';
import type { TranslateFn } from '@/hooks/useTranslation';

type Actions = ReturnType<typeof useCoworkProposalActions>;

function NoAiOffer({ offer, actions, t }: { offer: CoworkProposal; actions: Actions; t: TranslateFn }) {
    const replay = offer.replay;
    const full = replay ? replay.same + replay.differs + replay.partial : 0;
    const busy = actions.approve.isPending || actions.dismiss.isPending;
    return (
        <section className={CARD_SOFT} data-testid="cowork-task-offer-noai">
            <div className={CARD_HEAD}>{t('cowork_task.offer.noai_heading', 'One step can run without AI')}</div>
            <p className="text-[14px]">
                {t('cowork_task.offer.noai_line', "'{step}' gave the same result in {same} of {full} replays. Without AI it is faster and costs nothing. You can undo this.", { step: offer.stepTitle ?? '', same: replay?.same ?? 0, full })}
            </p>
            <div className={ROW_ACTIONS}>
                <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={() => actions.approve.mutate({ proposalId: offer.id, fingerprint: offer.fingerprint })}>
                    {t('cowork_task.offer.noai_accept', 'Run it without AI')}
                </button>
                <button type="button" className={BTN_QUIET} disabled={busy} onClick={() => actions.dismiss.mutate(offer.id)}>{t('cowork_task.not_now', 'Not now')}</button>
            </div>
        </section>
    );
}

/** The apps every one of the last runs used, by name. */
function steadyApps(advice: RoutineAdvice): string[] {
    const apps = (advice.signals?.steady ?? []).map((h) => (h.app ? appLabel(h.app) : null)).filter((a): a is string => !!a);
    return [...new Set(apps)];
}

function Comparison({ advice, t }: { advice: RoutineAdvice; t: TranslateFn }) {
    const apps = steadyApps(advice);
    return (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5" data-testid="cowork-task-offer-compare">
            <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-primary)] p-3 flex flex-col gap-1.5 text-[14px]">
                <h4 className="font-semibold">{t('cowork_task.offer.now_ai', 'Now: the AI works it out every run')}</h4>
                <span>{t('cowork_task.offer.now_line', 'It works out the steps again on every run.')}</span>
            </div>
            <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-primary)] p-3 flex flex-col gap-1.5 text-[14px]">
                <h4 className="font-semibold">{t('cowork_task.offer.steps_heading', 'As fixed steps')}</h4>
                <span>{t('cowork_task.offer.steps_line', 'The same steps every run. The AI only writes or judges where it must.')}</span>
                {apps.length > 0 && <span className={META}>{t('cowork_task.offer.steps_apps', 'Every run used: {apps}.', { apps: apps.join(', ') })}</span>}
            </div>
        </div>
    );
}

function RoutineOffer({ advice, busy, onAccept, onLater, t }: { advice: RoutineAdvice; busy: boolean; onAccept: () => void; onLater: () => void; t: TranslateFn }) {
    const [proof, setProof] = useState(false);
    return (
        <section className={CARD_SOFT} data-testid="cowork-task-offer-routine">
            <div className={CARD_HEAD}>{t('cowork_task.offer.routine_heading', 'Turn it into fixed steps?')}</div>
            <p className="text-[14px]">
                {t('cowork_task.offer.routine_line', 'This task did the same thing the last {count} times. As fixed steps it is faster and cheaper, and the result stays the same.', { count: advice.signals?.runs ?? 0 })}
            </p>
            <button type="button" className={`${BTN_LINK} self-start`} aria-expanded={proof} onClick={() => setProof((v) => !v)}>
                {proof ? t('cowork_task.offer.hide_compare', 'Hide the comparison') : t('cowork_task.offer.show_compare', 'See the comparison')}
            </button>
            {proof && <Comparison advice={advice} t={t} />}
            <p className={META}>{t('cowork_task.offer.routine_tested', 'Cowork makes the steps from these runs and tests them once. Nothing is sent, and they run only after you approve them.')}</p>
            <div className={ROW_ACTIONS}>
                <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={onAccept}>{t('cowork_task.offer.routine_accept', 'Turn into fixed steps')}</button>
                <button type="button" className={BTN_QUIET} onClick={onLater}>{t('cowork_task.not_now', 'Not now')}</button>
            </div>
        </section>
    );
}

interface CoworkTaskOfferProps {
    coworkId: string;
    /** The task has fixed steps. */
    hasSteps: boolean;
    /** The organisation has automations, so a task may get fixed steps. */
    mayPlan: boolean;
    /** Cowork is making steps right now. */
    making: boolean;
    /** Make the steps from the last runs ("make it routine"). */
    onMakeFromRuns: () => void;
    t: TranslateFn;
}

export default function CoworkTaskOffer({ coworkId, hasSteps, mayPlan, making, onMakeFromRuns, t }: CoworkTaskOfferProps) {
    const list = useCoworkProposals(coworkId).data;
    const actions = useCoworkProposalActions(coworkId);
    const routine = useCoworkRoutine(coworkId, mayPlan && !hasSteps).data;
    const [later, setLater] = useState(false);
    const offer = openOffer(list);
    const made = offer ? null : madeFixed(list);
    const error = actions.approve.error || actions.dismiss.error || actions.restore.error;
    let body = null;
    if (offer) body = <NoAiOffer offer={offer} actions={actions} t={t} />;
    else if (made && made.undoVersion !== null) {
        const version = made.undoVersion;
        body = (
            <UndoNote testId="cowork-task-noai-note" undoing={actions.restore.isPending} onUndo={() => actions.restore.mutate(version)} t={t}>
                {t('cowork_task.offer.noai_done', "'{step}' now runs without AI. Faster, and it costs nothing.", { step: made.stepTitle ?? '' })}
            </UndoNote>
        );
    } else if (!hasSteps && !later && isRoutineWorthIt(routine) && routine) {
        body = <RoutineOffer advice={routine} busy={making} onAccept={onMakeFromRuns} onLater={() => setLater(true)} t={t} />;
    }
    if (!body) return null;
    return <div className="flex flex-col gap-2">{body}<Failure error={error} t={t} /></div>;
}
