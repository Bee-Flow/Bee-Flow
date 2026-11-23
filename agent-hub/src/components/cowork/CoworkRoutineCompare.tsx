/**
 * The proof of "make it routine", under a finished try-out (./CoworkPlanTry.tsx): the last run the AI made next to the
 * same work done by the plan, item by item, with the time each took. Shown only when there is such a run.
 */
import { useRoutineComparison } from '../../api/coworkRoutine';
import { shortDuration } from './coworkPlanTryModel';
import type { TranslateFn } from '../../hooks/useTranslation';

const COLUMN = 'flex-1 min-w-[220px] rounded-lg border px-3 py-2 [border-color:var(--border-subtle)] flex flex-col gap-1';

export default function CoworkRoutineCompare({ coworkId, tryId, done, t }: { coworkId: string; tryId: string | null; done: boolean; t: TranslateFn }) {
    const cmp = useRoutineComparison(coworkId, tryId, done).data;
    if (!cmp) return null;
    return (
        <section className="flex flex-col gap-2" data-testid="cowork-routine-compare" aria-label={t('cowork.routine.proof', 'The plan next to the last run the AI made')}>
            <p role="status" className="text-[12.5px] font-medium text-[var(--text-primary)]">
                {t('cowork.routine.same', 'Same items: {same} of {total}.', { same: cmp.same, total: cmp.before })}
                {cmp.beforeMs !== null && cmp.afterMs !== null && (
                    <span className="ml-1.5 font-normal text-[var(--text-tertiary)]">
                        {t('cowork.routine.times', 'The AI took {before}, the plan {after}.', { before: shortDuration(cmp.beforeMs), after: shortDuration(cmp.afterMs) })}
                    </span>
                )}
            </p>
            <div className="flex flex-wrap gap-2">
                <div className={COLUMN}>
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{t('cowork.routine.before', 'Last run, by the AI')}</span>
                    <pre className="whitespace-pre-wrap text-[12px] text-[var(--text-secondary)] font-[inherit] m-0">{cmp.beforeText}</pre>
                </div>
                <div className={COLUMN}>
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{t('cowork.routine.after', 'The same, with the plan')}</span>
                    <pre className="whitespace-pre-wrap text-[12px] text-[var(--text-secondary)] font-[inherit] m-0">{cmp.afterText}</pre>
                </div>
            </div>
            {cmp.onlyBefore.length > 0 && (
                <p className="text-[12px] text-[var(--warning-ink)]">{t('cowork.routine.missing', 'Only in the AI\'s run: {items}', { items: cmp.onlyBefore.join('; ') })}</p>
            )}
        </section>
    );
}
