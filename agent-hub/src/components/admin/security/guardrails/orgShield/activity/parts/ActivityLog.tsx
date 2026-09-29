/**
 * The log: shield events and calls in one list, newest first, grouped per
 * day. It replaces the two tables behind a switch; the outcome filter now
 * does what the switch did.
 */

import { ScrollText, SearchX } from 'lucide-react';
import React from 'react';

import type { TranslateFn } from '../../../../../../../hooks/useTranslation';
import { formatDay } from '../shieldDates';
import { groupByDay, type StreamRow } from '../shieldStream';
import { LOG_GRID, LogRow, WIDE_ONLY } from './LogRow';
import { Panel, PanelHead } from './Panel';

export const PAGE = 15;

interface Props {
    rows: StreamRow[];
    shown: number;
    onMore: () => void;
    openRow: string | null;
    onOpenRow: (id: string) => void;
    onPickKind: (kind: string) => void;
    onClear: () => void;
    catLabel: (id: string) => string;
    capped: boolean;
    limit: number;
    locale: string;
    fmt: (n: number) => string;
    t: TranslateFn;
}

function Head({ t }: { t: TranslateFn }) {
    const heads = [
        t('admin.shield_activity_col_time', 'Time'),
        t('admin.shield_activity_col_person', 'Person'),
        t('shield_activity.col_started', 'Started in'),
        t('admin.shield_activity_col_found', 'What we found'),
        t('shield_activity.col_happened', 'What happened'),
        t('shield_activity.col_went', 'Went to'),
    ];
    return (
        <div className={`${LOG_GRID} border-y border-[var(--border-default)] bg-[var(--bg-secondary)] px-[18px] py-1.5 text-[10px] font-bold uppercase tracking-[0.05em] text-[var(--text-tertiary)]`}>
            {heads.map((h, i) => <span key={h} className={i === 2 ? WIDE_ONLY : undefined}>{h}</span>)}
            <span />
        </div>
    );
}

function Empty({ onClear, t }: { onClear: () => void; t: TranslateFn }) {
    return (
        <div className="flex flex-col items-center gap-1.5 p-7 text-xs text-[var(--text-tertiary)]">
            <SearchX className="h-[18px] w-[18px]" aria-hidden="true" />
            <p className="m-0">{t('shield_activity.no_rows', 'Nothing matches this combination.')}</p>
            <button type="button" onClick={onClear} className="font-semibold text-[var(--text-secondary)] underline">
                {t('admin.shield_activity_clear_all', 'Clear all')}
            </button>
        </div>
    );
}

function Footer({ rows, shown, onMore, capped, limit, fmt, t }: Pick<Props, 'rows' | 'shown' | 'onMore' | 'capped' | 'limit' | 'fmt' | 't'>) {
    const visible = Math.min(shown, rows.length);
    return (
        <div className="flex flex-wrap items-center gap-2.5 border-t border-[var(--border-default)] px-[18px] py-2.5 text-xs text-[var(--text-tertiary)]">
            <span>
                {t('shield_activity.showing', 'Showing {n} of {total}', { n: fmt(visible), total: fmt(rows.length) })}
                {capped && ` · ${t('admin.shield_activity_stops_at', 'stops at {n}', { n: limit })}`}
            </span>
            {rows.length > visible && (
                <button type="button" onClick={onMore} className="font-semibold text-[var(--text-primary)] underline">
                    {t('shield_activity.show_more', 'Show {n} more', { n: Math.min(PAGE, rows.length - visible) })}
                </button>
            )}
        </div>
    );
}

export function ActivityLog(props: Props) {
    const { rows, shown, openRow, onOpenRow, onPickKind, onClear, catLabel, locale, fmt, t } = props;
    const perDay = new Map<string | null, number>();
    for (const r of rows) perDay.set(r.day, (perDay.get(r.day) || 0) + 1);
    const groups = groupByDay(rows.slice(0, shown));
    return (
        <Panel className="flex flex-col overflow-hidden" label={t('shield_activity.log_title', 'Log')}>
            <PanelHead icon={ScrollText} title={t('shield_activity.log_title', 'Log')} hint={t('shield_activity.log_hint', 'click a row to see everything that was recorded')} />
            <div className="min-w-0 overflow-x-auto">
                <div className="min-w-[680px] @min-[1100px]/pane:min-w-[900px]">
                    <Head t={t} />
                    {rows.length === 0 && <Empty onClear={onClear} t={t} />}
                    {groups.map(g => (
                        <div key={g.day || 'none'}>
                            <div className="flex items-baseline gap-2 border-b border-[var(--border-subtle)] px-[18px] pb-1.5 pt-2.5 text-xs">
                                <b className="text-[var(--text-primary)]">{g.day ? formatDay(g.day, locale, { weekday: true }) : '—'}</b>
                                <span className="text-[11px] text-[var(--text-tertiary)]">
                                    {perDay.get(g.day) === 1
                                        ? t('shield_activity.day_count_one', '1 message or call')
                                        : t('shield_activity.day_count', '{n} messages & calls', { n: fmt(perDay.get(g.day) || 0) })}
                                </span>
                            </div>
                            <ul className="m-0 list-none p-0">
                                {g.rows.map(row => (
                                    <LogRow
                                        key={row.id}
                                        row={row}
                                        open={openRow === row.id}
                                        onToggle={() => onOpenRow(row.id)}
                                        onPickKind={onPickKind}
                                        catLabel={catLabel}
                                        locale={locale}
                                        t={t}
                                    />
                                ))}
                            </ul>
                        </div>
                    ))}
                </div>
            </div>
            {rows.length > 0 && <Footer {...props} />}
        </Panel>
    );
}
