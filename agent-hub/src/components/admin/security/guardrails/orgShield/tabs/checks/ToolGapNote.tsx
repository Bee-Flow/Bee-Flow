import { Wrench } from 'lucide-react';
import React from 'react';

import type { GoTo, TranslateFn } from './checksTypes';

/**
 * The foot of step 4: tool calls go around both checks, and here is where
 * they are held back instead.
 *
 * Worded around steps 3 and 4 on purpose, not "nothing on this page": with
 * "Protect web searches" on, its categories are added to what outside tools
 * may not carry, so one switch on this page does reach tool calls.
 *
 * `count` is null when it is not known (see checksModel.toolGapCount); the
 * sentence then stands on its own rather than showing a zero.
 */
export function ToolGapNote({
    count, days, onGoTo, t,
}: {
    count: number | null;
    days: number;
    onGoTo?: GoTo;
    t: TranslateFn;
}) {
    const link = (
        <button
            type="button"
            onClick={() => onGoTo?.('detection')}
            className="font-semibold underline underline-offset-2 text-[var(--info-ink)] hover:opacity-80"
        >
            {t('shield_checks.tools_gap_link', 'tool columns of the matrix')}
        </button>
    );
    return (
        <div className="flex gap-2.5 items-start px-[18px] py-3 border-t border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--warning)_8%,transparent)]">
            <Wrench aria-hidden="true" className="w-3.5 h-3.5 shrink-0 mt-0.5 text-[var(--warning-ink)]" />
            <p className="m-0 text-xs leading-[17px] text-[var(--text-secondary)]">
                {count != null && (
                    <>
                        <strong className="font-semibold text-[var(--text-primary)]">
                            {count === 1
                                ? t('shield_checks.tools_gap_count_one', '1 tool call carried personal data in the last {days} days.', { days })
                                : t('shield_checks.tools_gap_count', '{n} tool calls carried personal data in the last {days} days.', { n: count, days })}
                        </strong>{' '}
                    </>
                )}
                {t('shield_checks.tools_gap_tail', 'Tool calls go around steps 3 and 4 — hold kinds back in the')}{' '}
                {link}.
            </p>
        </div>
    );
}

export default ToolGapNote;
