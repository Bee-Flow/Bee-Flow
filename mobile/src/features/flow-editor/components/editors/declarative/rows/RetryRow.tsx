/**
 * "Try again if this step fails" — the web's RetrySection. The words are the
 * consequence, never the mechanism ("Wait before trying again", not
 * "backoff"); the rules are retry.ts.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { SelectField } from '@/features/flow-editor/components/fields';
import { Text } from '@/shared/ui';

import {
    activeRetry,
    RETRY_DEFAULT,
    RETRY_TRY_COUNTS,
    RETRY_WAIT_MS,
    retryChoices,
    retryRowCap,
    retryTriesLabel,
    retryWaitLabel,
    retryWaitTotal,
    type Retry,
} from './retry';
import { ToggleBox } from './ToggleBox';

function WaitTotal({ retry, rowCap }: { retry: Retry; rowCap: number }) {
    const t = useTranslation();
    const total = retryWaitTotal(retry, rowCap);
    if (!total) return null;
    const line =
        rowCap > 1
            ? t('mobile.flow.retry.total_rows', 'Each row is tried again on its own, so waiting can add up to {s}s across all {rows} rows', { s: total.seconds, rows: rowCap })
            : t('mobile.flow.retry.total', 'Waiting can add up to {s}s to this run', { s: total.seconds });
    const tail = total.long ? t('mobile.flow.retry.too_long', ' — long enough to run the automation out of time before the tries run out.') : '.';
    return (
        <Text variant="caption" weight="medium" tone={total.long ? 'warning' : 'secondary'}>
            {line + tail}
        </Text>
    );
}

export function RetryRow({ value, forEach, onChange, disabled }: { value: unknown; forEach: unknown; onChange: (next: Retry | null) => void; disabled?: boolean }) {
    const t = useTranslation();
    const retry = activeRetry(value);
    const set = (patch: Partial<Retry>) => retry && onChange({ ...retry, ...patch });
    return (
        <ToggleBox
            on={!!retry}
            onToggle={(on) => onChange(on ? { ...RETRY_DEFAULT } : null)}
            disabled={disabled}
            label={t('mobile.flow.retry.label', 'Try again if this step fails')}
            description={t(
                'mobile.flow.retry.hint',
                'For the failures that pass on their own — a timeout, a service that is briefly busy, a “too many requests”. Not for a wrong password or a missing field: those fail the same way every time.',
            )}
        >
            {retry ? (
                <>
                    <SelectField
                        label={t('mobile.flow.retry.tries', 'Try again')}
                        hint={t('mobile.flow.retry.tries_hint', 'How many more times to run this step after the first attempt fails.')}
                        value={String(retry.max)}
                        options={retryChoices(RETRY_TRY_COUNTS, retry.max).map((n) => ({ value: String(n), label: retryTriesLabel(n) }))}
                        onChange={(v) => set({ max: Number(v) })}
                        disabled={disabled}
                    />
                    <SelectField
                        label={t('mobile.flow.retry.wait', 'Wait before trying again')}
                        hint={t('mobile.flow.retry.wait_hint', 'Trying again immediately usually hits the same problem — a few seconds is enough for most of them to clear.')}
                        value={String(retry.backoffMs)}
                        options={retryChoices(RETRY_WAIT_MS, retry.backoffMs).map((ms) => ({ value: String(ms), label: retryWaitLabel(ms) }))}
                        onChange={(v) => set({ backoffMs: Number(v) })}
                        disabled={disabled}
                    />
                    <Text variant="caption" tone="secondary">
                        {t(
                            'mobile.flow.retry.after',
                            'If the last try fails too, the step fails and the automation stops there — exactly as it does now. Every attempt is kept in the run history, so you can see how often it took more than one.',
                        )}
                    </Text>
                    <WaitTotal retry={retry} rowCap={retryRowCap(forEach)} />
                </>
            ) : null}
        </ToggleBox>
    );
}
