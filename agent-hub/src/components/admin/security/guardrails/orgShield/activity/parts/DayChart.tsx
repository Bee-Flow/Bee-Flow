/**
 * "Day by day": one stacked bar per day, split by outcome, drawn from the
 * loaded rows. Hover or focus a day for its breakdown; click it to filter
 * the pane on that day (the other days fade).
 *
 * Each bar is a real <button> (keyboard reachable, named by its date and
 * total) holding an SVG whose segment heights are attributes, so a data-
 * driven height costs no inline style object.
 */

import { ChartColumnStacked } from 'lucide-react';
import React, { useId, useState } from 'react';

import type { TranslateFn } from '../../../../../../../hooks/useTranslation';
import { OUTCOME_SHORT_WORDS, wordFor } from '../activityLabels';
import { OUTCOME_ORDER, type Outcome } from '../outcomes';
import { dayKey, formatDay } from '../shieldDates';
import { axisMax, labelStep, peakDay, type DayStack } from '../shieldTotals';
import { OUTCOME_FILL } from '../../shieldPalette';
import { OUTLINE } from './miniCharts';
import { needsOutline, outcomeDot } from './outcomeDot';
import { Panel, PanelHead } from './Panel';

const H = 150;
const ALWAYS: Outcome[] = ['replaced', 'stopped', 'tool', 'clean'];

interface Props {
    stacks: DayStack[];
    selectedDay: string | null;
    onToggleDay: (day: string) => void;
    /** When a fetch was capped: the first moment both samples cover. */
    since: string | null;
    locale: string;
    fmt: (n: number) => string;
    t: TranslateFn;
}

function tipPlace(i: number, count: number): string {
    if (i < 3) return 'left-0';
    if (i > count - 4) return 'right-0';
    return 'left-1/2 -translate-x-1/2';
}

function Tooltip({ id, stack, index, count, locale, fmt, t }: { id: string; stack: DayStack; index: number; count: number } & Pick<Props, 'locale' | 'fmt' | 't'>) {
    const rows = OUTCOME_ORDER.filter(o => ALWAYS.includes(o) || stack.outcomes[o] > 0);
    return (
        <div
            id={id}
            role="tooltip"
            className={`pointer-events-none absolute bottom-[calc(100%+10px)] z-10 w-[190px] rounded-[10px] bg-[var(--text-primary)] px-3 py-2.5 text-[11px] leading-[18px] text-[rgb(from_var(--bg-card)_r_g_b_/_1)] shadow-[var(--shadow-md)] ${tipPlace(index, count)}`}
        >
            <div className="mb-1 font-semibold">
                {t('shield_activity.day_total', '{day} · {n} total', { day: formatDay(stack.day, locale, { weekday: true }), n: fmt(stack.total) })}
            </div>
            {rows.map(o => (
                <div key={o} className="grid grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-[7px]">
                    <span aria-hidden="true" className={outcomeDot(o)} />
                    <span>{wordFor(OUTCOME_SHORT_WORDS, o, t)}</span>
                    <b className="tabular-nums">{fmt(stack.outcomes[o])}</b>
                </div>
            ))}
        </div>
    );
}

function Bar({ stack, scale }: { stack: DayStack; scale: number }) {
    let y = H;
    return (
        <svg aria-hidden="true" width="100%" height={H} viewBox={`0 0 10 ${H}`} preserveAspectRatio="none" className="block">
            {OUTCOME_ORDER.filter(o => stack.outcomes[o] > 0).map(o => {
                const h = Math.max(1, Math.round(stack.outcomes[o] * scale) - 1);
                y -= h + 1;
                return <rect key={o} x={0} y={y + 1} width={10} height={h} fill={OUTCOME_FILL[o]} {...(needsOutline(o) ? OUTLINE : {})} />;
            })}
        </svg>
    );
}

/**
 * Under narrow bars a date is wider than its bar, so the first and last
 * labels hang inwards instead of past the card's edges.
 */
function labelAlign(i: number, count: number): string {
    if (count <= 10) return 'justify-center';
    if (i === 0) return 'justify-start';
    return i === count - 1 ? 'justify-end' : 'justify-center';
}

const GAP = (n: number) => (n <= 10 ? 'gap-2' : n <= 45 ? 'gap-1' : 'gap-px');

function Bars({ stacks, selectedDay, onToggleDay, locale, fmt, t }: Omit<Props, 'since'>) {
    const [active, setActive] = useState<number | null>(null);
    const tipId = useId();
    const scale = H / axisMax(stacks);
    return (
        <div className={`absolute inset-0 flex items-end ${GAP(stacks.length)}`}>
            {stacks.map((s, i) => {
                const chosen = selectedDay === s.day;
                const label = t('shield_activity.day_bar_label', '{day}: {n} messages and calls', { day: formatDay(s.day, locale, { weekday: true }), n: s.total });
                return (
                    <div key={s.day} className="relative flex h-full min-w-0 flex-1 items-end" onMouseEnter={() => setActive(i)} onMouseLeave={() => setActive(null)}>
                        <button
                            type="button"
                            aria-pressed={chosen}
                            aria-label={label}
                            aria-describedby={active === i ? tipId : undefined}
                            disabled={s.total === 0 && !chosen}
                            onClick={() => onToggleDay(s.day)}
                            onFocus={() => setActive(i)}
                            onBlur={() => setActive(null)}
                            className={`h-full w-full overflow-hidden rounded-t-[3px] disabled:cursor-default ${active === i ? 'bg-[color-mix(in_srgb,var(--text-primary)_5%,transparent)]' : ''} ${selectedDay && !chosen ? 'opacity-35' : ''}`}
                        >
                            <Bar stack={s} scale={scale} />
                        </button>
                        {active === i && <Tooltip id={tipId} stack={s} index={i} count={stacks.length} locale={locale} fmt={fmt} t={t} />}
                    </div>
                );
            })}
        </div>
    );
}

export function DayChart(props: Props) {
    const { stacks, since, locale, fmt, t } = props;
    const peak = peakDay(stacks);
    const max = axisMax(stacks);
    const step = labelStep(stacks.length);
    return (
        <Panel className="flex flex-col gap-3.5 px-[18px] pb-3 pt-3.5" label={t('shield_activity.day_title', 'Day by day')}>
            <PanelHead
                className=""
                icon={ChartColumnStacked}
                title={t('shield_activity.day_title', 'Day by day')}
                hint={t('shield_activity.day_hint', 'hover a day for details · click to filter on it')}
                right={peak ? t('shield_activity.day_peak', 'peak {n} on {day}', { n: fmt(peak.total), day: formatDay(peak.day, locale) }) : null}
            />
            <div className="grid grid-cols-[30px_minmax(0,1fr)] gap-x-2 gap-y-1.5 pt-4">
                <div aria-hidden="true" className="relative h-[150px] text-[10px] tabular-nums text-[var(--text-tertiary)]">
                    <span className="absolute right-0 top-[-6px]">{max}</span>
                    <span className="absolute right-0 top-[69px]">{max / 2}</span>
                    <span className="absolute bottom-[-6px] right-0">0</span>
                </div>
                <div className="relative h-[150px]">
                    <div aria-hidden="true" className="absolute inset-x-0 top-0 border-t border-dashed border-[var(--border-subtle)]" />
                    <div aria-hidden="true" className="absolute inset-x-0 top-[75px] border-t border-dashed border-[var(--border-subtle)]" />
                    <div aria-hidden="true" className="absolute inset-x-0 bottom-0 border-t border-[var(--border-default)]" />
                    <Bars {...props} />
                </div>
                <div />
                <div aria-hidden="true" className={`flex text-[10px] text-[var(--text-tertiary)] ${GAP(stacks.length)}`}>
                    {stacks.map((s, i) => (
                        <span key={s.day} className={`flex min-w-0 flex-1 whitespace-nowrap ${labelAlign(i, stacks.length)}`}>
                            {(stacks.length - 1 - i) % step === 0 ? formatDay(s.day, locale) : ''}
                        </span>
                    ))}
                </div>
            </div>
            {since && (
                <p className="m-0 text-[11px] text-[var(--text-tertiary)]">
                    {t('shield_activity.day_since', 'Only the most recent rows are loaded, so this covers {date} onwards.', { date: formatDay(dayKey(since) || '', locale, { weekday: true }) })}
                </p>
            )}
        </Panel>
    );
}
