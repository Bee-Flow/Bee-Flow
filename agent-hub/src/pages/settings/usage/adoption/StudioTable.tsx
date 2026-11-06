import { ChevronRight } from 'lucide-react';
import { Fragment, useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { Card, EmptyInline, FilterChipBar, Sparkline } from '../kit';
import { DeltaPill } from '../shell';
import type { ChipValue } from '../kit.types';
import type { AdoptionKind } from './adoption.types';
import { kindMeta, usageNoun } from './kindMeta';
import { fInt, fMoney } from './format';
import StudioDrilldown from './StudioDrilldown';

type T = ReturnType<typeof useTranslation>['t'];

/** The Studio rail's three groups, plus cowork with the AI kinds. */
const KIND_GROUP: Readonly<Record<string, 'build' | 'ai' | 'bundle'>> = Object.freeze({
    automation: 'build', datatable: 'build', app: 'build', webpage: 'build', document: 'build', form: 'build',
    agent: 'ai', skill: 'ai', kb: 'ai', meeting: 'ai', cowork: 'ai',
    playbook: 'bundle', solution: 'bundle',
});

interface StudioTableProps {
    kinds: AdoptionKind[];
    currency: string;
    /** Query string of the adoption reads, for the inline drill-down. */
    qs: string;
    /** "6 Oct – 5 Nov 2026 · all groups". */
    scopeLabel: string;
    /** Page-wide compare switch: off hides the trend deltas. */
    compare?: boolean;
}

function NoSignal() {
    const { t } = useTranslation();
    return <span className="text-[11px] italic text-[var(--text-muted)]">{t('adoption.studio_no_signal', 'no signal')}</span>;
}

function TrendCell({ k, compare }: { k: AdoptionKind; compare: boolean }) {
    return (
        <span className="inline-flex items-center justify-end gap-2.5">
            <Sparkline values={k.trend} color="var(--text-secondary)" />
            {k.deltaPct == null
                ? <span className="text-[11px] text-[var(--text-muted)]">—</span>
                : <DeltaPill delta={k.deltaPct} unit="pct" compare={compare} />}
        </span>
    );
}

const CELL = 'px-3 py-2.5 text-right tabular-nums text-[12px] text-[var(--text-primary)]';
const COLS = 8;

interface KindRowProps { k: AdoptionKind; currency: string; compare: boolean; open: boolean; onToggle: (kind: string) => void; panelId: string }

function KindRow({ k, currency, compare, open, onToggle, panelId }: KindRowProps) {
    const { t } = useTranslation();
    const meta = kindMeta(k.kind, t);
    const Icon = meta.icon;
    const usesWhat = k.usage ? usageNoun(k.usage.label, t) : t('adoption.studio_no_signal_sub', 'no usage signal');
    return (
        <tr className={`border-b border-[var(--border-subtle)] last:border-b-0 hover:bg-[var(--bg-tertiary)] ${open ? 'bg-[var(--bg-secondary)]' : ''}`}>
            <td className="px-3 py-2.5">
                <button type="button" onClick={() => onToggle(k.kind)} aria-expanded={open} aria-controls={open ? panelId : undefined}
                    className="flex cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left">
                    <ChevronRight className={`h-3 w-3 shrink-0 text-[var(--text-muted)] transition-transform ${open ? 'rotate-90 text-[var(--text-primary)]' : ''}`} aria-hidden="true" />
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                    </span>
                    <span className="min-w-0">
                        <span className="block text-[13px] font-semibold text-[var(--text-primary)]">{meta.label}</span>
                        <span className="block text-[11px] text-[var(--text-muted)]">{usesWhat}</span>
                    </span>
                </button>
            </td>
            <td className={CELL}>{fInt(k.total)}</td>
            <td className={CELL}>{fInt(k.published)}</td>
            <td className={CELL}>{fInt(k.makers)}</td>
            <td className={CELL}>{k.usage ? fInt(k.usage.people) : <NoSignal />}</td>
            <td className={CELL}>{k.usage ? `${fInt(k.usage.events)} ${usageNoun(k.usage.label, t)}` : <NoSignal />}</td>
            <td className={CELL}>{k.cost == null ? '—' : fMoney(k.cost, currency)}</td>
            <td className="px-3 py-2.5 text-right"><TrendCell k={k} compare={compare} /></td>
        </tr>
    );
}

function headers(t: T): string[] {
    return [
        t('adoption.studio_col_kind', 'Kind'), t('adoption.studio_col_total', 'In org'), t('adoption.studio_col_published', 'Published'),
        t('adoption.studio_col_makers', 'Makers'), t('adoption.studio_col_people', 'People using'), t('adoption.studio_col_uses', 'Uses'),
        t('adoption.studio_col_cost', 'AI cost'), t('adoption.studio_col_trend', 'Trend'),
    ];
}

/** Chips (All kinds · Build · AI · Bundle) and the search box over the kind names. */
function Toolbar({ group, onGroup, count, query, onQuery }: { group: ChipValue; onGroup: (g: ChipValue) => void; count: number; query: string; onQuery: (q: string) => void }) {
    const { t } = useTranslation();
    const options = [
        { value: 'all', label: t('adoption.studio_filter_all_kinds', 'All kinds'), count },
        { value: 'build', label: t('adoption.studio_filter_build', 'Build') },
        { value: 'ai', label: t('adoption.studio_filter_ai', 'AI') },
        { value: 'bundle', label: t('adoption.studio_filter_bundle', 'Bundle') },
    ];
    return (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 pt-3 pb-3.5">
            <FilterChipBar size="sm" value={group} onChange={onGroup} options={options} />
            <input type="search" value={query} onChange={e => onQuery(e.target.value)} placeholder={t('adoption.studio_search_placeholder', 'Search')}
                aria-label={t('adoption.studio_search', 'Search kinds')}
                className="h-[34px] w-[200px] rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-2.5 text-[13px] text-[var(--text-primary)]" />
        </div>
    );
}

/**
 * Studio adoption: one row per kind the organisation has (a kind with nothing
 * in it is hidden), how many exist, are published, who built them, how many
 * people use them and what their AI costs. A kind nothing records the use of
 * says "no signal" instead of a zero. A row is a button that opens the kind's
 * drill-down in a full-width row right under it.
 */
export default function StudioTable({ kinds, currency, qs, scopeLabel, compare = true }: StudioTableProps) {
    const { t } = useTranslation();
    const [group, setGroup] = useState<ChipValue>('all');
    const [query, setQuery] = useState('');
    const [openKind, setOpenKind] = useState<string | null>(null);
    const present = (kinds || []).filter(k => k.total > 0);
    const needle = query.trim().toLowerCase();
    const shown = present
        .filter(k => group === 'all' || KIND_GROUP[k.kind] === group)
        .filter(k => !needle || kindMeta(k.kind, t).label.toLowerCase().includes(needle));
    const toggle = (kind: string) => setOpenKind(cur => (cur === kind ? null : kind));
    return (
        <div>
            <Card>
                <Toolbar group={group} onGroup={setGroup} count={present.length} query={query} onQuery={setQuery} />
                {shown.length === 0 ? <EmptyInline text={t('adoption.studio_empty', 'Nothing built in Studio yet.')} /> : (
                    <div className="overflow-x-auto">
                        <table className="w-full min-w-[900px] border-collapse bg-[var(--bg-primary)]">
                            <thead>
                                <tr className="border-b border-[var(--border-subtle)]">
                                    {headers(t).map((h, i) => (
                                        <th key={h} scope="col" className={`px-3 py-2 text-[11px] font-semibold uppercase tracking-[.06em] text-[var(--text-muted)] ${i === 0 ? 'text-left' : 'text-right'}`}>{h}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {shown.map(k => (
                                    <Fragment key={k.kind}>
                                        <KindRow k={k} currency={currency} compare={compare} open={openKind === k.kind} onToggle={toggle} panelId={`studio-drill-${k.kind}`} />
                                        {openKind === k.kind && (
                                            <tr id={`studio-drill-${k.kind}`} className="border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
                                                <td colSpan={COLS} className="p-0 text-left">
                                                    <StudioDrilldown kind={k} qs={qs} currency={currency} scopeLabel={scopeLabel} />
                                                </td>
                                            </tr>
                                        )}
                                    </Fragment>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </Card>
            <p className="mt-1.5 text-[11px] text-[var(--text-muted)]">
                {t('adoption.studio_people_note', 'People using: distinct members who ran, opened or chatted with something of this kind in the period (a machine run counts for the person who started it).')}{' '}
                {t('adoption.studio_no_signal_note', 'No signal: nothing records use of this kind yet; the count and the makers are still exact.')}
            </p>
        </div>
    );
}
