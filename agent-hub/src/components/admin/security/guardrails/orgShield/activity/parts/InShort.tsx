/**
 * "In short": the period in one sentence, then the same numbers as a stacked
 * bar and a legend whose pills filter on the outcome.
 *
 * The sentence counts what is logged: times the shield ACTED on a message,
 * and calls to outside services. It never claims a number of messages
 * checked — messages the shield found nothing in leave no record — and it
 * only says no call carried personal data when some calls were checked.
 *
 * The counts here ignore the outcome filter itself (the pills are that
 * filter), so choosing "Stopped" dims the others instead of zeroing them.
 */

import React from 'react';

import { OUTCOME_WORDS, wordFor } from '../activityLabels';
import { OUTCOME_ORDER, type Outcome } from '../outcomes';
import type { Totals } from '../shieldTotals';
import { OUTCOME_FILL, OUTCOME_TEXT } from '../../shieldPalette';
import type { TranslateFn } from '../../../../../../../hooks/useTranslation';
import { SegmentBar } from './miniCharts';
import { needsOutline, outcomeDot } from './outcomeDot';
import { Eyebrow, Slots } from './Panel';

/** 'passed', 'unchecked' and 'other' get a pill only when they happened. */
const ALWAYS: Outcome[] = ['replaced', 'stopped', 'tool', 'clean'];

interface Props {
    totals: Totals;
    selected: Outcome | null;
    onToggle: (outcome: Outcome) => void;
    fmt: (n: number) => string;
    t: TranslateFn;
}

function Sentence({ totals, fmt, t }: Pick<Props, 'totals' | 'fmt' | 't'>) {
    const o = totals.outcomes;
    const n = (value: number, outcome?: Outcome) => (
        <b className={outcome ? OUTCOME_TEXT[outcome] : undefined}>{fmt(value)}</b>
    );
    let template: string;
    if (o.tool > 0) template = t('shield_activity.in_short_sentence', '{events} times the shield acted on a message and {calls} calls went to outside services. The shield replaced personal data {replaced} times and stopped {stopped} — but {tool} times it left with a tool, unchanged.');
    // "No call carried personal data" only when some calls were looked in.
    else if (o.clean > 0) template = t('shield_activity.in_short_sentence_no_tool', '{events} times the shield acted on a message and {calls} calls went to outside services. The shield replaced personal data {replaced} times and stopped {stopped}, and no call to a tool was found carrying personal data.');
    else template = t('shield_activity.in_short_sentence_plain', '{events} times the shield acted on a message and {calls} calls went to outside services. The shield replaced personal data {replaced} times and stopped {stopped}.');
    return (
        <p className="m-0 max-w-[720px] text-lg leading-7 text-[var(--text-primary)] [text-wrap:pretty]">
            <Slots
                template={template}
                slots={{
                    events: n(totals.events), calls: n(totals.calls),
                    replaced: n(o.replaced, 'replaced'), stopped: n(o.stopped, 'stopped'), tool: n(o.tool, 'tool'),
                }}
            />
            {o.unchecked > 0 && (
                <>
                    {' '}
                    <Slots
                        template={o.unchecked === 1
                            ? t('shield_activity.in_short_unchecked_one', 'One call was not checked for personal data.')
                            : t('shield_activity.in_short_unchecked', '{unchecked} calls were not checked for personal data.')}
                        slots={{ unchecked: n(o.unchecked, 'unchecked') }}
                    />
                </>
            )}
            {o.passed > 0 && (
                <>
                    {' '}
                    <Slots
                        template={o.passed === 1
                            ? t('shield_activity.in_short_passed_one', 'Once, the shield let something through anyway: a person chose to send it, it was only noted, or the check could not run.')
                            : t('shield_activity.in_short_passed', '{passed} times the shield let something through anyway: a person chose to send it, it was only noted, or the check could not run.')}
                        slots={{ passed: n(o.passed, 'passed') }}
                    />
                </>
            )}
        </p>
    );
}

export function InShort({ totals, selected, onToggle, fmt, t }: Props) {
    const shown = OUTCOME_ORDER.filter(o => ALWAYS.includes(o) || totals.outcomes[o] > 0);
    return (
        <div className="flex flex-col gap-4 self-start px-5 py-[18px]">
            <Eyebrow>{t('shield_activity.in_short', 'In short')}</Eyebrow>
            <Sentence totals={totals} fmt={fmt} t={t} />
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
