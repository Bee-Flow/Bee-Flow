import { Activity, ArrowRight } from 'lucide-react';

import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import type { ShieldEvidence } from '../activity/useShieldEvidence';
import { OUTCOME_TEXT } from '../shieldPalette';
import { toolGapCount } from '../tabs/checks/checksModel';
import type { GoTo } from './types';

interface Props {
    evidence: ShieldEvidence;
    t: TranslateFn;
    onGoTo: GoTo;
}

/**
 * Three numbers from the last 30 days, each in its outcome colour, and the
 * way into "What happened". Rendered only when the figures are KNOWN: the
 * caller leaves it out when the mount has no activity pane, the plan has no
 * monitoring, or the fetch failed — an unknown is never drawn as a zero.
 *
 * "Left with a tool" counts calls to outside services that carried personal
 * data; clean messages are not logged, so there is deliberately no "checked"
 * total here. When no call in the window was checked its zero means "not
 * looked", so it reads as a dash (checksModel.toolGapCount).
 */
export default function LastThirtyDays({ evidence, t, onGoTo }: Props) {
    const figures = [
        { id: 'replaced', n: evidence.replaced, cls: OUTCOME_TEXT.replaced, label: t('shield_overview.kpi_replaced', 'replaced') },
        { id: 'stopped', n: evidence.stopped, cls: OUTCOME_TEXT.stopped, label: t('shield_overview.kpi_stopped', 'stopped') },
        { id: 'tool', n: toolGapCount(evidence), cls: OUTCOME_TEXT.tool, label: t('shield_overview.kpi_tool', 'left with a tool') },
    ];
    return (
        <section
            aria-labelledby="org-shield-last-days"
            className="rounded-xl bg-[var(--bg-card)] border border-[var(--border-default)] shadow-[var(--shadow-sm)] px-4 py-3.5 flex flex-col gap-2.5"
        >
            <div className="flex items-center gap-2">
                <Activity className="w-[15px] h-[15px] text-[var(--text-secondary)]" aria-hidden="true" />
                <h4 id="org-shield-last-days" className="m-0 text-[13px] font-semibold text-[var(--text-primary)]">
                    {t('shield_overview.last_days', 'Last {days} days', { days: evidence.days })}
                </h4>
                <button
                    type="button"
                    onClick={() => onGoTo('activity')}
                    className="ml-auto text-xs font-semibold text-[var(--info-ink)] inline-flex items-center gap-1 hover:underline"
                >
                    {t('admin.shield_tab_activity', 'What happened')}
                    <ArrowRight className="w-3 h-3" aria-hidden="true" />
                </button>
            </div>
            <dl className="m-0 grid grid-cols-3 gap-2">
                {figures.map(f => (
                    // Column-reverse keeps the label first in the DOM (a dt before
                    // its dd) while the number is drawn on top; `justify-end` pins
                    // the pair to the TOP of the cell, so a label that wraps to two
                    // lines no longer pushes its number above the other two.
                    <div key={f.id} className="flex flex-col-reverse justify-end min-w-0">
                        <dt className="text-[11px] text-[var(--text-secondary)]">{f.label}</dt>
                        <dd className={`m-0 text-[22px] leading-7 font-bold tabular-nums ${f.n === null ? 'text-[var(--text-tertiary)]' : f.cls}`}>
                            {f.n === null ? '—' : f.n.toLocaleString()}
                        </dd>
                    </div>
                ))}
            </dl>
        </section>
    );
}
