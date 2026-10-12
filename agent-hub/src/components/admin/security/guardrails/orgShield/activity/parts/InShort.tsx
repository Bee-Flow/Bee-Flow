/**
 * "In short": the period's outcomes as one stacked bar and a legend whose
 * pills filter on the outcome.
 *
 * It used to open with a paragraph that put the same numbers in prose; the
 * KPI cards and these pills already carry them, so the bar and the pills are
 * the whole card now. The counts ignore the outcome filter itself (the pills
 * are that filter), so choosing "Stopped" dims the others instead of zeroing
 * them.
 */

import React from 'react';

import { OUTCOME_WORDS, wordFor } from '../activityLabels';
import { OUTCOME_ORDER, type Outcome } from '../outcomes';
import type { Totals } from '../shieldTotals';
import { OUTCOME_FILL, OUTCOME_TEXT } from '../../shieldPalette';
import type { TranslateFn } from '../../../../../../../hooks/useTranslation';
import { SegmentBar } from './miniCharts';
import { needsOutline, outcomeDot } from './outcomeDot';
import { Eyebrow } from './Panel';

/** 'passed', 'unchecked' and 'other' get a pill only when they happened. */
const ALWAYS: Outcome[] = ['replaced', 'stopped', 'tool', 'clean'];

interface Props {
    totals: Totals;
    selected: Outcome | null;
    onToggle: (outcome: Outcome) => void;
    fmt: (n: number) => string;
    t: TranslateFn;
}

export function InShort({ totals, selected, onToggle, fmt, t }: Props) {
    const shown = OUTCOME_ORDER.filter(o => ALWAYS.includes(o) || totals.outcomes[o] > 0);
    return (
        <div className="flex flex-col gap-2.5 px-[18px] py-3.5">
            <Eyebrow>{t('shield_activity.in_short', 'In short')}</Eyebrow>
            <div className="flex flex-col gap-2">
                <div className="overflow-hidden rounded">
                    <SegmentBar
                        height={12}
                        segments={shown.map(o => ({
                            key: o, value: totals.outcomes[o], fill: OUTCOME_FILL[o], dim: !!selected && selected !== o, outline: needsOutline(o),
                        }))}
                    />
                </div>
                <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('shield_activity.outcomes_label', 'Filter on what happened')}>
                    {shown.map(o => (
                        <button
                            key={o}
                            type="button"
                            aria-pressed={selected === o}
                            onClick={() => onToggle(o)}
                            className={`inline-flex items-center gap-[7px] rounded-full border px-2.5 py-1 text-xs text-[var(--text-primary)] transition-opacity ${
                                selected === o
                                    ? 'border-[var(--text-primary)] bg-[var(--bg-secondary)]'
                                    : 'border-[var(--border-default)] bg-[var(--bg-card)] hover:bg-[var(--bg-secondary)]'
                            } ${selected && selected !== o ? 'opacity-55' : ''}`}
                        >
                            <span aria-hidden="true" className={outcomeDot(o)} />
                            {wordFor(OUTCOME_WORDS, o, t)}
                            <b className="tabular-nums">{fmt(totals.outcomes[o])}</b>
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}
