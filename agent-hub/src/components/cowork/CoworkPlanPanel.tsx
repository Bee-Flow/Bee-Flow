/**
 * The plan of one Cowork item in its detail view: reads the plan, shows it as a card (./CoworkPlanCard.tsx) and
 * carries out what its owner does with it: approve the plan that is on screen, or take it off.
 *
 * An item without a plan shows a way to give it one, to someone whose organisation has automations: a plan is made
 * from one of their own automations. Everyone else sees nothing here, and their items run as before.
 *
 * A failure to read the plan costs this card and nothing else: the brief, the figures and the history still render.
 */
import { useState } from 'react';
import { ListChecks } from 'lucide-react';
import CoworkPlanCard from './CoworkPlanCard';
import { useCoworkPlanActions, useCoworkPlanQuery, usePlanAutomations } from '../../api/queries/coworkPlan';
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

/** "Give this work a plan": pick one of your automations. */
function AttachPlan({ automations, busy, error, t, onAttach }: AttachProps) {
    const [choice, setChoice] = useState('');
    if (automations.length === 0) return null;
    const selected = choice || automations[0]?.id || '';
    return (
        <section
            data-testid="cowork-plan-attach"
            className="rounded-[10px] border border-dashed px-[18px] py-3.5 flex flex-col gap-2 [border-color:var(--border-default)]"
        >
            <div className="flex items-center gap-1.5">
                <ListChecks aria-hidden="true" className="w-3.5 h-3.5 text-[var(--text-tertiary)]" />
                <h3 className="text-[12.5px] font-semibold text-[var(--text-primary)]">{t('cowork_plan.attach.heading', 'Give this work a plan')}</h3>
            </div>
            <p className="text-[12px] text-[var(--text-secondary)]">
                {t('cowork_plan.attach.hint', 'A plan does the fixed parts the same way every run, without AI. It is made from one of your automations, and runs only after you approve it.')}
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
        </section>
    );
}

/** The sentence of a refused request, or null when nothing failed. */
function failureOf(error: unknown, t: TranslateFn): string | null {
    return error ? errorMessage(error) || t('cowork_plan.failed', 'That did not work. Try again.') : null;
}

/** An item without a plan: the way to give it one, for someone whose organisation has automations. */
function PlanAttachGate({ coworkId, mailTriggered, t }: { coworkId: string; mailTriggered: boolean; t: TranslateFn }) {
    const ent = useEntitlements() as { loading: boolean; can: (id: string) => boolean };
    const { attach } = useCoworkPlanActions(coworkId);
    // An item that starts on a new mail carries no plan yet; the server refuses it too.
    const mayAttach = !mailTriggered && !ent.loading && ent.can('automations');
    const automations = usePlanAutomations(mayAttach);
    if (!mayAttach) return null;
    return <AttachPlan automations={automations} busy={attach.isPending} error={failureOf(attach.error, t)} t={t} onAttach={(id) => attach.mutate(id)} />;
}

export default function CoworkPlanPanel({ coworkId, mailTriggered = false }: { coworkId: string; mailTriggered?: boolean }) {
    const { t } = useTranslation();
    const { data: state } = useCoworkPlanQuery(coworkId);
    const { approve, remove } = useCoworkPlanActions(coworkId);
    if (!state) return null;
    if (!state.automationId) return <PlanAttachGate coworkId={coworkId} mailTriggered={mailTriggered} t={t} />;
    const busy = approve.isPending ? 'approve' : remove.isPending ? 'remove' : null;
    return (
        <CoworkPlanCard
            state={state}
            t={t}
            busy={busy}
            error={failureOf(approve.error || remove.error, t)}
            onApprove={(fingerprint) => { remove.reset(); approve.mutate(fingerprint); }}
            onRemove={() => { approve.reset(); remove.mutate(); }}
        />
    );
}
