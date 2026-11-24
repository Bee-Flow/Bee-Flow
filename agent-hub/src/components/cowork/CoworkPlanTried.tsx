/**
 * How the plan's last try-out went, on its card (./CoworkPlanCard.tsx): "Tried once: 'List meetings' read 5 items, the
 * AI wrote its answer. Nothing was changed or sent." Or, honestly, what still fails: a plan Cowork made gets its
 * Approve only once a try-out of exactly that plan passed (./coworkPlanModel.ts canApprove).
 *
 * Presentation only; the words come from ./coworkWiringModel.ts. Nothing when there is no try-out to tell.
 */
import { FlaskConical } from 'lucide-react';
import { triedLines } from './coworkWiringModel';
import type { PlanTried } from '@/api/coworkPlan.types';
import type { TranslateFn } from '@/hooks/useTranslation';

const TONE: Record<'ok' | 'warning' | 'error', string> = {
    ok: 'text-[var(--text-secondary)]',
    warning: 'text-[var(--warning-ink)]',
    error: 'text-[var(--error-ink)]',
};

/** `findingsShown`: the card shows why the plan cannot run right below, so the try-out line does not repeat it. */
export default function CoworkPlanTried({ tried, findingsShown = false, t }: { tried: PlanTried | null | undefined; findingsShown?: boolean; t: TranslateFn }) {
    const lines = triedLines(tried, t, { findingsShown });
    if (!lines) return null;
    return (
        <div className="flex flex-col gap-1" data-testid="cowork-plan-tried" data-tone={lines.tone}>
            <p className={`flex items-start gap-1.5 text-[12.5px] ${TONE[lines.tone]}`}>
                <FlaskConical aria-hidden="true" className="mt-0.5 w-3.5 h-3.5 flex-shrink-0" />
                <span>{lines.line}</span>
            </p>
            {lines.problems.length > 0 && (
                <ul className="list-disc pl-9 flex flex-col gap-0.5">
                    {lines.problems.map((problem) => <li key={problem} className="text-[12.5px] text-[var(--text-secondary)]">{problem}</li>)}
                </ul>
            )}
        </div>
    );
}
