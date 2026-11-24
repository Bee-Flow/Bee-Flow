/**
 * Cowork's own fix of the wiring of a plan that is not approved, on its card (./CoworkPlanCard.tsx): asked by itself
 * once per plan when the server says it can fix it (server usecases/coworkPlanWiringRepair.mts), then "Fixed:
 * 'Notification' now waits for 'AI step'." Where that did not work out (the budget kept it from a try-out, or there is
 * no fix Cowork may make), "Fix it for me" asks again, and says how it went in one sentence.
 *
 * Nothing here approves: the owner still approves the fixed plan on the card. The words come from ./coworkWiringModel.ts.
 */
import { Wrench } from 'lucide-react';
import { draftFixLine, draftFixOutcome, offerDraftFix } from './coworkWiringModel';
import { useCoworkPlanAutoFix, useCoworkPlanWiringFix } from '@/api/queries/coworkPlan';
import { errorMessage } from '@/utils/caughtError';
import type { PlanState } from '@/api/coworkPlan.types';
import type { TranslateFn } from '@/hooks/useTranslation';

const LINE = 'text-[12.5px] text-[var(--text-secondary)]';
const SECONDARY = 'inline-flex items-center self-start px-2.5 py-1.5 rounded-lg border text-[12px] font-medium disabled:opacity-50 border-[var(--border-default)] text-[var(--text-secondary)]';

export default function CoworkPlanWiringFix({ coworkId, state, t }: { coworkId: string; state: PlanState; t: TranslateFn }) {
    const auto = useCoworkPlanAutoFix(coworkId, state);
    const manual = useCoworkPlanWiringFix(coworkId);
    const busy = auto.isFetching || manual.isPending;
    const fixed = draftFixLine(state.tried, t);
    const offer = offerDraftFix(state, { busy, failed: auto.isError });
    const outcome = manual.data
        ? draftFixOutcome(manual.data, t)
        : manual.error ? errorMessage(manual.error) || t('cowork_wiring.draft_fix.failed', 'Cowork could not fix this plan by itself.') : null;
    if (!fixed && !offer && !outcome && !busy) return null;
    return (
        <div className="flex flex-col gap-1.5" data-testid="cowork-plan-wiring-fix">
            {fixed && (
                <p className={`flex items-start gap-1.5 ${LINE}`} data-testid="cowork-plan-wiring-fixed">
                    <Wrench aria-hidden="true" className="mt-0.5 w-3.5 h-3.5 flex-shrink-0" />
                    <span>{fixed}</span>
                </p>
            )}
            {busy && <p role="status" className={LINE}>{t('cowork_wiring.draft_fix.fixing', 'Cowork is fixing the order of the steps…')}</p>}
            {offer && (
                <button type="button" data-testid="cowork-plan-fix-wiring" className={SECONDARY} disabled={busy} onClick={() => { manual.mutate(); }}>
                    {t('cowork_wiring.draft_fix.button', 'Fix it for me')}
                </button>
            )}
            {outcome && !busy && <p role="status" className={LINE} data-testid="cowork-plan-wiring-outcome">{outcome}</p>}
        </div>
    );
}
