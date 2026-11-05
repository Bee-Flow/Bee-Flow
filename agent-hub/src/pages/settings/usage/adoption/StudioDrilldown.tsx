import { Activity, Download, Euro, EyeOff, Hammer, PackageOpen, Send, Users } from 'lucide-react';
import { useState } from 'react';
import Modal from '@/components/shared/Modal';
import { useAdoptionStudioItems } from '@/api/queries/usageAdoption';
import { useTranslation } from '@/hooks/useTranslation';
import { downloadCsv } from '@/utils/usageHelpers';
import { Card, EmptyInline, FilterChipBar, MetricCard, MetricGrid, SectionTitle, ShowMore } from '../kit';
import type { ChipValue } from '../kit.types';
import type { AdoptionItem, AdoptionKind, AdoptionStudioItems, Audience } from './adoption.types';
import { itemsCsv } from './exportCsv';
import { fAgo, fDate, fInt, fMoney } from './format';
import { kindMeta, usageNoun } from './kindMeta';

type T = ReturnType<typeof useTranslation>['t'];

const PAGE = 25;

interface StudioDrilldownProps {
    kind: AdoptionKind;
    qs: string;
    currency: string;
    /** "6 Oct – 5 Nov 2026 · all groups". */
    scopeLabel: string;
    onClose: () => void;
}

function audienceLabel(a: Audience, t: T): string {
    if (a === 'org') return t('adoption.drill_aud_org', 'Whole organisation');
    if (a === 'group') return t('adoption.drill_aud_group', 'One or more groups');
    if (a === 'public') return t('adoption.drill_aud_public', 'Public');
    return t('adoption.drill_aud_private', 'Private to the maker');
}

function DrillKpis({ kind: k, data, currency }: { kind: AdoptionKind; data: AdoptionStudioItems | null; currency: string }) {
    const { t } = useTranslation();
    const noSignal = t('adoption.studio_no_signal', 'no signal');
    return (
        <MetricGrid min={150} gap={8}>
            <MetricCard icon={Send} color="#0ea5e9" label={t('adoption.drill_published', 'Published')} value={fInt(k.published)} />
            <MetricCard icon={Hammer} color="#10b981" label={t('adoption.drill_makers', 'Makers')} value={fInt(k.makers)}
                subtitle={t('adoption.drill_makers_new', '{n} new this period', { n: fInt(k.newInPeriod) })} />
            <MetricCard icon={Users} color="#0ea5e9" label={t('adoption.drill_people', 'People using')} value={k.usage ? fInt(k.usage.people) : noSignal} />
            <MetricCard icon={Activity} color="#f59e0b" label={k.usage ? usageNoun(k.usage.label, t) : t('adoption.drill_uses', 'Uses')} value={k.usage ? fInt(k.usage.events) : noSignal} />
            <MetricCard icon={Euro} color="#f59e0b" label={t('adoption.drill_cost', 'AI cost')} value={k.cost == null ? '—' : fMoney(k.cost, currency)} />
            <MetricCard icon={PackageOpen} color="#94a3b8" label={t('adoption.drill_unused', 'Unused this period')} value={data ? fInt(data.unused.length) : '—'}
                subtitle={t('adoption.drill_unused_sub', 'published, but nobody used them')} />
        </MetricGrid>
    );
}

function ItemRow({ item, currency }: { item: AdoptionItem; currency: string }) {
    const { t } = useTranslation();
    const cell = 'px-3 py-2 text-right tabular-nums text-[12px] text-[var(--text-primary)]';
    return (
        <tr className="border-b border-[var(--border-subtle)] last:border-b-0">
            <td className="px-3 py-2">
                <span className="block text-[12px] font-semibold text-[var(--text-primary)]">{item.name}</span>
                <span className="block text-[10px] text-[var(--text-muted)]">{t('adoption.drill_by', 'by {name}', { name: item.ownerName })}</span>
            </td>
            <td className="px-3 py-2 text-[11px] text-[var(--text-secondary)]">{audienceLabel(item.audience, t)}</td>
            <td className="px-3 py-2 text-[11px] text-[var(--text-secondary)]">{fDate(item.createdAt)}</td>
            <td className="px-3 py-2 text-[11px] text-[var(--text-secondary)]">{fAgo(item.lastUsedAt, t)}</td>
            <td className={cell}>{fInt(item.people)}</td>
            <td className={cell}>{fInt(item.uses)}</td>
            <td className={cell}>{item.cost == null ? '—' : fMoney(item.cost, currency)}</td>
        </tr>
    );
}

function ItemsTable({ data, currency }: { data: AdoptionStudioItems; currency: string }) {
    const { t } = useTranslation();
    const [filter, setFilter] = useState<ChipValue>('all');
    const [shown, setShown] = useState(PAGE);
    const unusedIds = new Set(data.unused.map(u => u.id));
    const rows = filter === 'unused' ? data.items.filter(i => unusedIds.has(i.id) || !i.uses) : data.items;
    const cols = [
        t('adoption.drill_col_name', 'Name'), t('adoption.drill_col_audience', 'Audience'), t('adoption.drill_col_created', 'Created'),
        t('adoption.drill_col_last', 'Last used'), t('adoption.drill_col_people', 'People'), t('adoption.drill_col_uses', 'Uses'), t('adoption.drill_col_cost', 'AI cost'),
    ];
    const options = [
        { value: 'all', label: t('adoption.studio_filter_all', 'All'), count: data.items.length },
        { value: 'unused', label: t('adoption.drill_filter_unused', 'Unused'), count: data.items.filter(i => unusedIds.has(i.id) || !i.uses).length },
    ];
    return (
        <div>
            <SectionTitle right={<FilterChipBar size="sm" value={filter} onChange={(v) => { setFilter(v); setShown(PAGE); }} options={options} />}>
                {t('adoption.drill_items_title', 'All items · {n}', { n: fInt(data.total) })}
            </SectionTitle>
            <Card>
                {rows.length === 0 ? <EmptyInline text={t('adoption.drill_items_empty', 'Nothing to list.')} /> : (
                    <div className="overflow-x-auto">
                        <table className="w-full border-collapse bg-[var(--bg-primary)]">
                            <thead><tr className="border-b border-[var(--border-subtle)]">{cols.map((c, i) => (
                                <th key={c} scope="col" className={`px-3 py-2 text-[10px] font-bold uppercase tracking-wide text-[var(--text-muted)] ${i < 4 ? 'text-left' : 'text-right'}`}>{c}</th>
                            ))}</tr></thead>
                            <tbody>{rows.slice(0, shown).map(i => <ItemRow key={i.id} item={i} currency={currency} />)}</tbody>
                        </table>
                    </div>
                )}
                {rows.length > shown && (
                    <ShowMore onMore={() => setShown(n => n + PAGE)} label={t('adoption.show_more', 'Show more ({n} remaining)', { n: rows.length - shown })} />
                )}
            </Card>
        </div>
    );
}

function SidePanels({ data, currency }: { data: AdoptionStudioItems; currency: string }) {
    const { t } = useTranslation();
    const counts = data.items.reduce<Record<string, number>>((m, i) => { m[i.audience] = (m[i.audience] || 0) + 1; return m; }, {});
    return (
        <div className="flex flex-col gap-3">
            <Card title={t('adoption.drill_audience_title', 'Who it is for')}>
                <ul className="space-y-1">{(['org', 'group', 'private', 'public'] as Audience[]).filter(a => counts[a]).map(a => (
                    <li key={a} className="flex justify-between text-[12px] text-[var(--text-secondary)]"><span>{audienceLabel(a, t)}</span><span className="tabular-nums text-[var(--text-primary)]">{fInt(counts[a])}</span></li>
                ))}</ul>
            </Card>
            <Card title={t('adoption.drill_top_title', 'Who uses it most')} right={<span className="inline-flex items-center gap-1 text-[10px] text-[var(--text-muted)]"><EyeOff className="h-3 w-3" aria-hidden="true" />{t('adoption.drill_names_hidden', 'names hidden')}</span>}>
                {data.topPeople.length === 0 ? <EmptyInline text={t('adoption.drill_top_empty', 'Nobody in this period.')} /> : (
                    <ol className="space-y-1" aria-label={t('adoption.drill_top_title', 'Who uses it most')}>{data.topPeople.map(p => (
                        <li key={p.person} className="flex justify-between gap-2 text-[12px]"><span className="text-[var(--text-primary)]">{p.person}</span>
                            <span className="tabular-nums text-[var(--text-secondary)]">{`${fInt(p.uses)} · ${fMoney(p.cost, currency)}`}</span></li>
                    ))}</ol>
                )}
                <p className="mt-2 text-[10px] text-[var(--text-muted)]">{t('adoption.drill_top_note', 'Always pseudonymous here. Reveal names on the Adoption page; every reveal is recorded.')}</p>
            </Card>
            <Card title={t('adoption.drill_unused_title', 'Published but unused · {n}', { n: data.unused.length })}>
                {data.unused.length === 0 ? <EmptyInline text={t('adoption.drill_unused_empty', 'Everything published was used.')} /> : (
                    <ul className="space-y-1.5">{data.unused.map(u => (
                        <li key={u.id} className="text-[12px]"><span className="block text-[var(--text-primary)]">{u.name}</span>
                            <span className="block text-[10px] text-[var(--text-muted)]">{t('adoption.drill_unused_by', 'by {name} · published {date}', { name: u.ownerName, date: fDate(u.publishedAt) })}</span></li>
                    ))}</ul>
                )}
                <p className="mt-2 text-[10px] text-[var(--text-muted)]">{t('adoption.drill_makers_note', 'Makers are shown by name: building something is organisational metadata, using it is not.')}</p>
            </Card>
        </div>
    );
}

/**
 * The drill-down of one Studio kind: its numbers, every item with who built
 * it and how much it was used, who uses the kind most (pseudonymous, always)
 * and what was published but not used in the period.
 */
export default function StudioDrilldown({ kind, qs, currency, scopeLabel, onClose }: StudioDrilldownProps) {
    const { t } = useTranslation();
    const meta = kindMeta(kind.kind, t);
    const query = useAdoptionStudioItems<AdoptionStudioItems>(qs, kind.kind);
    const data = query.data ?? null;
    const exportItems = () => { if (data) downloadCsv(`adoption-${kind.kind}.csv`, itemsCsv(data)); };
    return (
        <Modal open onClose={onClose} placement="right" size="xl"
            title={t('adoption.drill_title', '{kind} · {n} in the organisation', { kind: meta.label, n: fInt(kind.total) })}
            description={scopeLabel}
            headerActions={data ? (
                <button type="button" onClick={exportItems} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] px-2.5 py-1 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]">
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />{t('adoption.export_csv', 'Export CSV')}
                </button>
            ) : null}>
            <div className="flex flex-col gap-4">
                <DrillKpis kind={kind} data={data} currency={currency} />
                {query.isLoading && <EmptyInline text={t('adoption.loading', 'Loading…')} />}
                {!query.isLoading && !data && <EmptyInline text={t('adoption.drill_error', 'The items of this kind could not be read.')} boxed />}
                {data && (
                    <div className="grid gap-3 [grid-template-columns:minmax(0,1fr)] lg:[grid-template-columns:minmax(0,1fr)_260px]">
                        <ItemsTable data={data} currency={currency} />
                        <SidePanels data={data} currency={currency} />
                    </div>
                )}
            </div>
        </Modal>
    );
}
