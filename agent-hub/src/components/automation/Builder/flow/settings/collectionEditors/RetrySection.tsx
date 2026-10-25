import { RotateCw } from 'lucide-react';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import { FormRow, inputClass } from '../formPrimitives';
import type { RetryWaitTotalProps, RetrySectionProps } from '../collectionEditors.types';
import { retryTriesLabel, retryWaitLabel, retryChoices, retryRowCap } from './collectionEditors.helpers';

/** The try-again counts offered, as extra attempts AFTER the first one. */
const RETRY_TRY_COUNTS = [1, 2, 3, 5];

/** The waits offered, in the runner's own unit. */
const RETRY_WAIT_MS = [0, 2000, 5000, 15000, 30000, 60_000];

/** Two extra tries, five seconds apart — a rate limit's usual shape. */
const RETRY_DEFAULT = { max: 2, backoffMs: 5000 };

/** Half the default run budget (RUN_HARD_TIMEOUT_MS, 5 min) spent waiting. */
const RETRY_LONG_WAIT_MS = 150_000;

function RetryWaitTotal({ tries, waitMs, rowCap }: RetryWaitTotalProps) {
    const worstCaseMs = tries * waitMs * rowCap;
    if (worstCaseMs <= 0) return null;
    const long = worstCaseMs >= RETRY_LONG_WAIT_MS;
    const seconds = Math.round(worstCaseMs / 1000);
    return (
        <p className={`text-[11px] font-medium ${long
            ? 'text-amber-600 dark:text-amber-400'
            : 'text-[var(--text-secondary)]'}`}>
            {rowCap > 1
                ? `Each row is tried again on its own, so waiting can add up to ${seconds}s across all ${rowCap} rows`
                : `Waiting can add up to ${seconds}s to this run`}
            {long
                ? ' — long enough to run the automation out of time before the tries run out.'
                : '.'}
        </p>
    );
}

export function RetrySection({ draft, set }: RetrySectionProps) {
    const { t } = useTranslation();
    if (!draft || !('retry' in draft)) return null;
    // `max: 0` is the runner's own "do not retry" (`retry.max > 0` gates the
    // whole loop), so it reads as off here rather than as a broken on.
    const stored = draft.retry && Number(draft.retry.max) > 0 ? draft.retry : null;
    const enabled = !!stored;
    const tries = Number(stored?.max) || 1;
    const waitMs = Number(stored?.backoffMs) || 0;
    const patch = (over: { max: number; } | { backoffMs: number; }) => set('retry', { max: tries, backoffMs: waitMs, ...over });
    return (
        <div className="rounded-lg border border-[var(--border-default)] p-3 space-y-2 mt-2">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={enabled}
                    onChange={(e) => set('retry', e.target.checked ? { ...RETRY_DEFAULT } : null)} />
                <span className="inline-flex items-center gap-1.5 font-medium text-[var(--text-primary)]">
                    <RotateCw size={13} /> {t('automations.collection_editors.try_again_if_this_step_fails', 'Try again if this step fails')}
                </span>
            </label>
            <p className="text-[11px] text-[var(--text-secondary)]">
                {t('automations.collection_editors.for_the_failures_that_pass_on', 'For the failures that pass on their own — a timeout, a service that is briefly busy, a “too many requests”. Not for a wrong password or a missing field: those fail the same way every time.')}
            </p>
            {enabled && (
                <div className="space-y-3 pt-1">
                    <FormRow label={t('automations.collection_editors.try_again', 'Try again')} htmlFor="retry-tries"
                        hint={t('automations.collection_editors.how_many_more_times_to_run', 'How many more times to run this step after the first attempt fails.')}>
                        <select
                            id="retry-tries"
                            value={tries}
                            onChange={(e) => patch({ max: Number(e.target.value) })}
                            className={inputClass()}
                        >
                            {retryChoices(RETRY_TRY_COUNTS, tries).map(n => (
                                <option key={n} value={n}>{retryTriesLabel(n)}</option>
                            ))}
                        </select>
                    </FormRow>
                    <FormRow label={t('automations.collection_editors.wait_before_trying_again', 'Wait before trying again')} htmlFor="retry-wait"
                        hint={t('automations.collection_editors.trying_again_immediately_usually_hits_the', 'Trying again immediately usually hits the same problem — a few seconds is enough for most of them to clear.')}>
                        <select
                            id="retry-wait"
                            value={waitMs}
                            onChange={(e) => patch({ backoffMs: Number(e.target.value) })}
                            className={inputClass()}
                        >
                            {retryChoices(RETRY_WAIT_MS, waitMs).map(ms => (
                                <option key={ms} value={ms}>{retryWaitLabel(ms)}</option>
                            ))}
                        </select>
                    </FormRow>
                    {/* The question every author asks next, answered before they
                        have to run it to find out. */}
                    <p className="text-[11px] text-[var(--text-secondary)]">
                        {t('automations.collection_editors.if_the_last_try_fails_too', 'If the last try fails too, the step fails and the automation stops there — exactly as it does now. Every attempt is kept in the run history, so you can see how often it took more than one.')}
                    </p>
                    <RetryWaitTotal tries={tries} waitMs={waitMs} rowCap={retryRowCap(draft.forEach)} />
                </div>
            )}
        </div>
    );
}
