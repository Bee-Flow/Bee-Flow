/**
 * The plan of one Cowork item in its detail view: reads the plan, shows it as a card (./CoworkPlanCard.tsx) and
 * carries out what its owner does with it: approve the plan that is on screen, or take it off.
 *
 * A plan nothing blocks can be tried first (./CoworkPlanTry.tsx): one run on the owner's real data in which nothing is
 * changed or sent, followed step by step. A changed plan can be replayed on what the past runs read
 * (./CoworkPlanReplay.tsx).
 *
 * An item without a plan shows ONE way to give it one in sight, to someone whose organisation has automations: "Make
 * it routine" (./CoworkRoutine.tsx) when its past runs say so, otherwise "Make a plan" from the brief
 * (./CoworkPlanMake.tsx). The other ways, one of their own automations among them, wait under "More ways". Everyone
 * else sees the `fallback` here (one sentence), and their items run as before.
 *
 * An approved plan says how independent it is in one line (./CoworkIndependenceLine.tsx) that opens to the choice,
 * and, when a steady AI step can run without AI, one quiet line more (./CoworkPlanOffer.tsx).
 *
 * A failure to read the plan costs this card and nothing else: the brief, the figures and the history still render.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import CoworkPlanCard from './CoworkPlanCard';
import CoworkPlanMake from './CoworkPlanMake';
import CoworkPlanTry from './CoworkPlanTry';
import CoworkPlanReplay from './CoworkPlanReplay';
import CoworkIndependenceLine from './CoworkIndependenceLine';
import CoworkPlanOffer from './CoworkPlanOffer';
import CoworkRoutine from './CoworkRoutine';
import CoworkRoutineCompare from './CoworkRoutineCompare';
import { canReplay, canTry } from './coworkPlanModel';
import { useCoworkPlanActions, useCoworkPlanQuery, useCoworkPlanTry, usePlanAutomations } from '../../api/queries/coworkPlan';
import { isRoutineWorthIt, useCoworkRoutine } from '../../api/coworkRoutine';
import useCoworkPlanMaker from '../../hooks/useCoworkPlanMaker';
import { useEntitlements } from '../licensing/EntitlementsContext';
import { useTranslation } from '../../hooks/useTranslation';
import { errorMessage } from '../../utils/caughtError';
import type { TranslateFn } from '../../hooks/useTranslation';
import type { PlanAutomation } from '../../api/coworkPlan.types';

interface AttachProps {
    automations: PlanAutomation[];
    busy: boolean;
    error: string | null;
    t: TranslateFn;
    onAttach: (automationId: string) => void;
}

/** Another way to a plan, under "More ways": one of your own automations. */
function AttachPlan({ automations, busy, error, t, onAttach }: AttachProps) {
    const [choice, setChoice] = useState('');
    if (automations.length === 0) return null;
    const selected = choice || automations[0]?.id || '';
    return (
        <div data-testid="cowork-plan-attach" className="flex flex-col gap-2">
            <h4 className="text-[12.5px] font-medium text-[var(--text-primary)]">
                {t('cowork_plan.attach.heading', 'Or use one of your own automations')}
            </h4>
            <div className="flex flex-col gap-2">
                <p className="text-[12px] text-[var(--text-secondary)]">
                    {t('cowork_plan.attach.hint', 'An automation you built in Studio can be the plan. It runs only after you approve it here.')}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                    <label className="sr-only" htmlFor="cowork-plan-automation">{t('cowork_plan.attach.select', 'Automation')}</label>
                    <select
                        id="cowork-plan-automation"
                        value={selected}
                        onChange={(e) => setChoice(e.target.value)}
                        className="min-w-[200px] rounded-lg border px-2 py-1.5 text-[12.5px] bg-[var(--bg-primary)] border-[var(--border-default)] text-[var(--text-primary)]"
                    >
                        {automations.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
                    </select>
                    <button
                        type="button"
                        data-testid="cowork-plan-attach-button"
                        disabled={busy || !selected}
                        onClick={() => onAttach(selected)}
                        className="inline-flex items-center px-2.5 py-1.5 rounded-lg border text-[12px] font-medium disabled:opacity-50 border-[var(--border-default)] text-[var(--text-secondary)]"
                    >
                        {t('cowork_plan.attach.use', 'Use as the plan')}
                    </button>
                </div>
                {error && <p role="alert" className="text-[12.5px] text-[var(--error-ink)]">{error}</p>}
            </div>
        </div>
    );
}

/** The sentence of a refused request, or null when nothing failed. */
function failureOf(error: unknown, t: TranslateFn): string | null {
    return error ? errorMessage(error) || t('cowork_plan.failed', 'That did not work. Try again.') : null;
}

type Maker = ReturnType<typeof useCoworkPlanMaker>;

/** The ways that are not the first one, folded: nothing when there is none. */
function MoreWays({ t, children }: { t: TranslateFn; children: ReactNode[] }) {
    const ways = children.filter(Boolean);
    if (ways.length === 0) return null;
    return (
        <details data-testid="cowork-plan-more" className="pt-2 border-t border-[var(--border-subtle)]">
            <summary className="cursor-pointer text-[12px] font-medium text-[var(--text-secondary)] marker:text-[var(--text-tertiary)]">
                {t('cowork_detail.plan.more_ways', 'More ways')}
            </summary>
            <div className="flex flex-col gap-4 pt-3">{ways}</div>
        </details>
    );
}

interface GateProps { coworkId: string; maker: Maker; t: TranslateFn; fallback: ReactNode }

/**
 * An item without a plan, for someone whose organisation has automations: one way in sight, the others under "More
 * ways". "Make it routine" goes first when the past runs say so. While a plan is being made, or when making it
 * failed, its progress or its error is in sight whichever way started it.
 */
function PlanAttachGate({ coworkId, maker, t, fallback }: GateProps) {
    const ent = useEntitlements() as { loading: boolean; can: (id: string) => boolean };
    const { attach } = useCoworkPlanActions(coworkId);
    // An item that starts on a new mail may carry a plan too: it drafts its replies, never sends them.
    const mayPlan = !ent.loading && ent.can('automations');
    const automations = usePlanAutomations(mayPlan);
    const routineFirst = isRoutineWorthIt(useCoworkRoutine(coworkId, mayPlan).data);
    // The licence decides, and says nothing while it is still read.
    if (!mayPlan) return <>{!ent.loading ? fallback : null}</>;
    const { running } = maker.making;
    const makeInSight = !routineFirst || running || maker.making.error !== null;
    const make = <CoworkPlanMake key="make" t={t} making={maker.making} onMake={() => { void maker.start(); }} onCancel={maker.cancel} />;
    return (
        <section
            aria-label={t('cowork_plan.heading', 'The plan')}
            data-testid="cowork-plan-none"
            className="rounded-[10px] border border-dashed px-[18px] py-3.5 flex flex-col gap-3 [border-color:var(--border-default)]"
        >
            {routineFirst && <CoworkRoutine coworkId={coworkId} busy={running} onPropose={() => { void maker.start(true); }} t={t} />}
            {makeInSight && make}
            {!running && (
                <MoreWays t={t}>
                    {[
                        makeInSight ? null : make,
                        automations.length > 0
                            ? <AttachPlan key="attach" automations={automations} busy={attach.isPending} error={failureOf(attach.error, t)} t={t} onAttach={(id) => attach.mutate(id)} />
                            : null,
                    ]}
                </MoreWays>
            )}
        </section>
    );
}

/**
 * The try-out of the plan on screen: started here, followed until it is over. A changed plan can also be replayed on
 * what the past runs read (./CoworkPlanReplay.tsx), before it is approved.
 */
function PlanTry({ coworkId, fingerprint, replay, t }: { coworkId: string; fingerprint: string; replay: boolean; t: TranslateFn }) {
    const { start, started, state, error } = useCoworkPlanTry(coworkId);
    return (
        <>
            <CoworkPlanTry
                t={t}
                state={state}
                starting={start.isPending}
                stale={started !== null && started.fingerprint !== fingerprint}
                error={failureOf(error, t)}
                onStart={() => start.mutate()}
            />
            {/* The proof of "make it routine": this try-out next to the last run the AI made, when there is one. */}
            <CoworkRoutineCompare coworkId={coworkId} tryId={state?.tryId ?? null} done={!!state?.done} t={t} />
            {replay && <CoworkPlanReplay coworkId={coworkId} t={t} />}
        </>
    );
}

interface CoworkPlanPanelProps {
    coworkId: string;
    /** What shows instead when this item cannot be given a plan here (no automations). */
    fallback?: ReactNode;
}

export default function CoworkPlanPanel({ coworkId, fallback = null }: CoworkPlanPanelProps) {
    const { t } = useTranslation();
    const { data: state } = useCoworkPlanQuery(coworkId);
    const { approve, remove } = useCoworkPlanActions(coworkId);
    const maker = useCoworkPlanMaker(coworkId);
    if (!state) return null;
    if (!state.automationId) return <PlanAttachGate coworkId={coworkId} maker={maker} t={t} fallback={fallback} />;
    const busy = approve.isPending ? 'approve' : remove.isPending ? 'remove' : null;
    const tryOut = state.draft && canTry(state) ? <PlanTry coworkId={coworkId} fingerprint={state.draft.fingerprint} replay={canReplay(state)} t={t} /> : null;
    return (
        <CoworkPlanCard
            state={state}
            t={t}
            busy={busy}
            tryOut={tryOut}
            independence={state.approved ? <><CoworkIndependenceLine coworkId={coworkId} t={t} /><CoworkPlanOffer coworkId={coworkId} t={t} /></> : null}
            note={maker.making.summary || null}
            error={failureOf(approve.error || remove.error, t)}
            onApprove={(fingerprint) => { remove.reset(); approve.mutate(fingerprint); }}
            onRemove={() => { approve.reset(); remove.mutate(); }}
        />
    );
}
