import { Boxes } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { Card, EmptyInline, FilterChipBar, SectionTitle, Sparkline, TrendChip } from '../kit';
import type { ChipValue } from '../kit.types';
import type { AdoptionKind } from './adoption.types';
import { kindMeta, usageNoun } from './kindMeta';
import { fDeltaPct, fInt, fMoney } from './format';

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
    onOpen: (kind: string) => void;
}

function NoSignal() {
    const { t } = useTranslation();
    return <span className="text-[11px] italic text-[var(--text-muted)]">{t('adoption.studio_no_signal', 'no signal')}</span>;
}

function TrendCell({ k }: { k: AdoptionKind }) {
    const { t } = useTranslation();
    return (
        <span className="inline-flex items-center gap-2">
            <Sparkline values={k.trend} color="var(--text-secondary)" />
            {k.deltaPct == null
                ? <span className="text-[11px] text-[var(--text-muted)]">—</span>
                : <TrendChip delta={k.deltaPct} display={fDeltaPct(Math.abs(k.deltaPct)).replace(/^[+−]/, '')} title={t('adoption.studio_delta_title', 'Against the previous period')} />}
        </span>
    );
}

const CELL = 'px-3 py-2.5 text-right tabular-nums text-[12px] text-[var(--text-primary)]';

function KindRow({ k, currency, onOpen }: { k: AdoptionKind; currency: string; onOpen: (kind: string) => void }) {
    const { t } = useTranslation();
    const meta = kindMeta(k.kind, t);
    const Icon = meta.icon;
    const usesWhat = k.usage ? usageNoun(k.usage.label, t) : t('adoption.studio_no_signal_sub', 'no usage signal');
    return (
        <tr className="cursor-pointer border-b border-[var(--border-subtle)] last:border-b-0 hover:bg-[var(--bg-tertiary)]" onClick={() => onOpen(k.kind)}>
            <td className="px-3 py-2.5">
                <button type="button" onClick={(e) => { e.stopPropagation(); onOpen(k.kind); }} className="flex items-center gap-2 text-left"
                    aria-label={t('adoption.studio_open', 'Open {kind}', { kind: meta.label })}>
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg" style={{ background: `color-mix(in srgb, ${meta.color} 16%, transparent)`, color: meta.color }}>
                        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                    </span>
                    <span className="min-w-0">
                        <span className="block text-[12px] font-semibold text-[var(--text-primary)]">{meta.label}</span>
                        <span className="block text-[10px] text-[var(--text-muted)]">{usesWhat}</span>
                    </span>
                </button>
            </td>
            <td className={CELL}>{fInt(k.total)}</td>
            <td className={CELL}>{fInt(k.published)}</td>
            <td className={CELL}>{fInt(k.makers)}</td>
            <td className={CELL}>{k.usage ? fInt(k.usage.people) : <NoSignal />}</td>
            <td className={CELL}>{k.usage ? `${fInt(k.usage.events)} ${usageNoun(k.usage.label, t)}` : <NoSignal />}</td>
            <td className={CELL}>{k.cost == null ? '—' : fMoney(k.cost, currency)}</td>
            <td className="px-3 py-2.5"><TrendCell k={k} /></td>
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

/**
 * Studio adoption: one row per kind the organisation has (a kind with nothing
 * in it is hidden), how many exist, are published, who built them, how many
 * people use them and what their AI costs. A kind nothing records the use of
 * says "no signal" instead of a zero. A row opens the kind's drill-down.
 */
export default function StudioTable({ kinds, currency, onOpen }: StudioTableProps) {
    const { t } = useTranslation();
    const [group, setGroup] = useState<ChipValue>('all');
    const present = (kinds || []).filter(k => k.total > 0);
    const shown = group === 'all' ? present : present.filter(k => KIND_GROUP[k.kind] === group);
    const options = [
        { value: 'all', label: t('adoption.studio_filter_all', 'All') },
        { value: 'build', label: t('adoption.studio_filter_build', 'Build') },
        { value: 'ai', label: t('adoption.studio_filter_ai', 'AI') },
        { value: 'bundle', label: t('adoption.studio_filter_bundle', 'Bundle') },
    ];
    return (
        <div>
            <SectionTitle icon={Boxes} right={<FilterChipBar size="sm" value={group} onChange={setGroup} options={options} />}>
                {t('adoption.studio_title', 'Studio adoption')}
                <span className="ml-2 text-[11px] font-normal text-[var(--text-muted)]">{t('adoption.studio_count', '{n} kinds', { n: present.length })}</span>
            </SectionTitle>
            <Card>
                {shown.length === 0 ? <EmptyInline text={t('adoption.studio_empty', 'Nothing built in Studio yet.')} /> : (
                    <div className="overflow-x-auto">
                        <table className="w-full border-collapse bg-[var(--bg-primary)]">
                            <thead>
                                <tr className="border-b border-[var(--border-subtle)]">
                                    {headers(t).map((h, i) => (
                                        <th key={h} scope="col" className={`px-3 py-2 text-[10px] font-bold uppercase tracking-wide text-[var(--text-muted)] ${i === 0 || i === 7 ? 'text-left' : 'text-right'}`}>{h}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>{shown.map(k => <KindRow key={k.kind} k={k} currency={currency} onOpen={onOpen} />)}</tbody>
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
