/**
 * The plan of one Cowork item in its detail view: reads the plan, shows it as a card (./CoworkPlanCard.tsx) and
 * carries out what its owner does with it: approve the plan that is on screen, or take it off.
 *
 * A plan nothing blocks can be tried first (./CoworkPlanTry.tsx): one run on the owner's real data in which nothing is
 * changed or sent, followed step by step.
 *
 * An item without a plan shows two ways to give it one, to someone whose organisation has automations: let Cowork
 * make the plan from the brief (./CoworkPlanMake.tsx), or use one of their own automations. Everyone else sees
 * nothing here, and their items run as before.
 *
 * A failure to read the plan costs this card and nothing else: the brief, the figures and the history still render.
 */
import { useState } from 'react';
import CoworkPlanCard from './CoworkPlanCard';
import CoworkPlanMake from './CoworkPlanMake';
import CoworkPlanTry from './CoworkPlanTry';
import CoworkIndependence from './CoworkIndependence';
import CoworkRoutine from './CoworkRoutine';
import CoworkRoutineCompare from './CoworkRoutineCompare';
import { canTry } from './coworkPlanModel';
import { useCoworkPlanActions, useCoworkPlanQuery, useCoworkPlanTry, usePlanAutomations } from '../../api/queries/coworkPlan';
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

/** The other way to a plan: one of your own automations. */
function AttachPlan({ automations, busy, error, t, onAttach }: AttachProps) {
    const [choice, setChoice] = useState('');
    if (automations.length === 0) return null;
    const selected = choice || automations[0]?.id || '';
    return (
        <details data-testid="cowork-plan-attach" className="pt-2 border-t border-[var(--border-subtle)]">
            <summary className="cursor-pointer text-[12px] text-[var(--text-secondary)] marker:text-[var(--text-tertiary)]">
                {t('cowork_plan.attach.heading', 'Or use one of your own automations')}
            </summary>
            <div className="flex flex-col gap-2 pt-2">
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
        </details>
    );
}

/** The sentence of a refused request, or null when nothing failed. */
function failureOf(error: unknown, t: TranslateFn): string | null {
    return error ? errorMessage(error) || t('cowork_plan.failed', 'That did not work. Try again.') : null;
}

type Maker = ReturnType<typeof useCoworkPlanMaker>;

/** An item without a plan: the two ways to give it one, for someone whose organisation has automations. */
function PlanAttachGate({ coworkId, mailTriggered, maker, t }: { coworkId: string; mailTriggered: boolean; maker: Maker; t: TranslateFn }) {
    const ent = useEntitlements() as { loading: boolean; can: (id: string) => boolean };
    const { attach } = useCoworkPlanActions(coworkId);
    // An item that starts on a new mail carries no plan yet; the server refuses it too.
    const mayPlan = !mailTriggered && !ent.loading && ent.can('automations');
    const automations = usePlanAutomations(mayPlan);
    if (!mayPlan) return null;
    return (
        <section
            aria-label={t('cowork_plan.heading', 'The plan')}
            data-testid="cowork-plan-none"
            className="rounded-[10px] border border-dashed px-[18px] py-3.5 flex flex-col gap-3 [border-color:var(--border-default)]"
        >
            <CoworkRoutine coworkId={coworkId} busy={maker.making.running} onPropose={() => { void maker.start(true); }} t={t} />
            <CoworkPlanMake t={t} making={maker.making} onMake={() => { void maker.start(); }} onCancel={maker.cancel} />
            {!maker.making.running && (
                <AttachPlan automations={automations} busy={attach.isPending} error={failureOf(attach.error, t)} t={t} onAttach={(id) => attach.mutate(id)} />
            )}
        </section>
    );
}

/** The try-out of the plan on screen: started here, followed until it is over. */
function PlanTry({ coworkId, fingerprint, t }: { coworkId: string; fingerprint: string; t: TranslateFn }) {
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
        </>
    );
}

export default function CoworkPlanPanel({ coworkId, mailTriggered = false }: { coworkId: string; mailTriggered?: boolean }) {
    const { t } = useTranslation();
    const { data: state } = useCoworkPlanQuery(coworkId);
    const { approve, remove } = useCoworkPlanActions(coworkId);
    const maker = useCoworkPlanMaker(coworkId);
    if (!state) return null;
    if (!state.automationId) return <PlanAttachGate coworkId={coworkId} mailTriggered={mailTriggered} maker={maker} t={t} />;
    const busy = approve.isPending ? 'approve' : remove.isPending ? 'remove' : null;
    const tryOut = state.draft && canTry(state) ? <PlanTry coworkId={coworkId} fingerprint={state.draft.fingerprint} t={t} /> : null;
    return (
        <CoworkPlanCard
            state={state}
            t={t}
            busy={busy}
            tryOut={tryOut}
            independence={state.approved ? <CoworkIndependence coworkId={coworkId} t={t} /> : null}
            note={maker.making.summary || null}
            error={failureOf(approve.error || remove.error, t)}
            onApprove={(fingerprint) => { remove.reset(); approve.mutate(fingerprint); }}
            onRemove={() => { approve.reset(); remove.mutate(); }}
        />
    );
}
