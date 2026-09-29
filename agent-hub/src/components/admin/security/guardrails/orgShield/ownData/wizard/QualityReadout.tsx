import React from 'react';

import type { TranslateFn } from '../../../../../../../hooks/useTranslation';
import { falseAlarmsLine, findsLine, verdictLine } from '../ownDataCopy';
import type { Summary } from '../ownDataModel';
import { verdictFor } from '../ownDataModel';

/**
 * "Finds 19 of 20 · 1 false alarm", and one plain sentence on what that
 * means. The small print names the size of the test set on purpose: a
 * perfect score on four sentences is not a perfect type.
 */
export function QualityReadout({ summary, stale, t }: { summary: Summary; stale: boolean; t: TranslateFn }) {
    const verdict = verdictFor(summary);
    const good = verdict === 'perfect' || verdict === 'good';
    return (
        <div role="status" className="flex flex-col gap-0.5">
            <p className="m-0 flex items-baseline gap-2 flex-wrap">
                <span className="text-lg font-semibold text-[var(--text-primary)]">{findsLine(summary.found, summary.total, t)}</span>
                <span className="text-xs text-[var(--text-secondary)]">{falseAlarmsLine(summary.falseAlarms, t)}</span>
            </p>
            <p className={`m-0 text-xs ${good ? 'text-[var(--success-ink)]' : 'text-[var(--warning-ink)]'}`}>{verdictLine(verdict, t)}</p>
            <p className="m-0 text-[11px] text-[var(--text-tertiary)]">
                {t('shield_data.measured_on', 'Measured on your {n} test sentences.', { n: summary.sentences })}
                {stale && ` ${t('shield_data.result_stale', 'You changed the settings after this test. Press Test again.')}`}
            </p>
        </div>
    );
}

export default QualityReadout;
