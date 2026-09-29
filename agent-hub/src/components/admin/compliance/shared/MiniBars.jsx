import React, { useMemo } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { TONES, toneOfScore } from '../../../shared/statusTone';
import { bucketHistory, formatDelta } from './miniBarsMath';

/**
 * MiniBars — the twelve-bar score trend on a framework card (Compliance
 * Center redesign, Sep 2026; artboard 1a). Replaces `ScoreSparkline`: a
 * 12-bucket bar strip says "roughly this shape over 90 days" without
 * pretending to a per-sweep precision the reader cannot use at 26px.
 *
 * Dataviz notes: change-over-time as bars is fine at twelve points; every
 * bar is `--bg-tertiary` except the LAST, which wears the framework's tone
 * (`TONES[tone].raw`) as the single "today" emphasis; the caption carries
 * the numbers in text tokens, never in the series colour. The bars have no
 * axis and no hover — the number lives in the ring beside them.
 *
 * Bucketing (last value per window, carry-forward, empty history → twelve
 * zero bars) is `miniBarsMath.bucketHistory`, tested on its own.
 *
 * Props
 *   history      rows of GET /score-history ({captured_at, overall_score,
 *                scores?, gdpr_score?, …}); absent or empty is fine
 *   frameworkId  'gdpr' | 'aia' | 'iso27001' | … → reads scores[frameworkId]
 *                (legacy columns as fallback); omitted → overall_score
 *   days / bars  the window (90) and the bucket count (12)
 *   tone         arc tone for the last bar; defaults to toneOfScore(last)
 *   caption      overrides the "{days} days · {delta}" caption (the ISO card
 *                says "ISMS sinds 10 jun · 96 dagen" instead)
 *   now          injectable clock for tests
 */
export default function MiniBars({
    history, frameworkId, days = 90, bars = 12, tone, caption, now, className = '', testId = 'mini-bars',
}) {
    const { t } = useTranslation();
    const buckets = useMemo(
        () => bucketHistory(history, { days, bars, frameworkId, now: now ?? Date.now() }),
        [history, days, bars, frameworkId, now],
    );

    const resolvedTone = TONES[tone] ? tone : toneOfScore(buckets.last);
    const lastIdx = buckets.values.length - 1;
    const delta = formatDelta(buckets.delta);
    const text = caption
        ?? (delta === null
            ? t('compliance.ovw_trend_none', '{days} days · no trend yet', { days: buckets.days })
            : t('compliance.ovw_trend', '{days} days · {delta}', { days: buckets.days, delta }));

    return (
        <div className={`flex items-end gap-[10px] ${className}`} data-testid={testId} data-tone={resolvedTone}>
            <div className="flex flex-1 items-end gap-[2px] h-[26px]" aria-hidden="true">
                {buckets.values.map((v, i) => (
                    <div
                        key={i}
                        data-testid={`${testId}-bar`}
                        data-fill={buckets.filled[i]}
                        className="flex-1 rounded-[1px]"
                        style={{
                            height: `${v}%`,
                            background: i === lastIdx ? TONES[resolvedTone].raw : 'var(--bg-tertiary)',
                        }}
                    />
                ))}
            </div>
            <span className="text-[10px] text-[var(--text-tertiary)] whitespace-nowrap" data-testid={`${testId}-caption`}>
                {text}
            </span>
        </div>
    );
}
