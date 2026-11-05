import { Download, Users } from 'lucide-react';
import { useState } from 'react';
import {
    AdoptionAuditUnavailableError, useAdoptionAreas, useAdoptionGroups, useAdoptionPeople, useAdoptionStudio, useAdoptionSummary,
} from '@/api/queries/usageAdoption';
import { useTranslation } from '@/hooks/useTranslation';
import { USAGE_ALL_DAYS, downloadCsv, type RangeParams } from '@/utils/usageHelpers';
import { AlertBanner, EmptyInline, TabHeader } from '../kit';
import { formatDateRange } from '../format';
import type { AdoptionAreas, AdoptionGroups, AdoptionPerson, AdoptionStudio, AdoptionSummary } from './adoption.types';
import AdoptionHero from './AdoptionHero';
import AdoptionNotes from './AdoptionNotes';
import AreasSection from './AreasSection';
import { adoptionCsv } from './exportCsv';
import GroupsTable from './GroupsTable';
import PeopleTable from './PeopleTable';
import StudioDrilldown from './StudioDrilldown';
import StudioTable from './StudioTable';

type T = ReturnType<typeof useTranslation>['t'];

export interface AdoptionTabProps {
    rangeParams: RangeParams;
    /** The range picker's preset: only a custom range is sent as an absolute window. */
    rangePreset?: string;
    showTokens: boolean;
    /** The subscription's currency symbol; € when unknown. */
    currency?: string;
}

/**
 * The query string of every adoption read. A preset period goes as `days`, so
 * the server can read "signed in" and "dormant" from the last sign-in; only a
 * custom range is an absolute window (and then those two read "—").
 */
export function adoptionQuery(range: RangeParams, preset: string | undefined, group: string): string {
    const p = new URLSearchParams();
    if (preset === 'custom' && range.startDate && range.endDate) {
        p.set('startDate', range.startDate);
        p.set('endDate', range.endDate);
    } else {
        p.set('days', String(range.days ?? USAGE_ALL_DAYS));
    }
    if (group) p.set('group', group);
    return p.toString();
}

function useAdoptionData(baseQs: string, qs: string, reveal: boolean) {
    const summary = useAdoptionSummary<AdoptionSummary>(qs);
    const areas = useAdoptionAreas<AdoptionAreas>(qs);
    const studio = useAdoptionStudio<AdoptionStudio>(qs);
    const groups = useAdoptionGroups<AdoptionGroups>(qs);
    const groupOptions = useAdoptionGroups<AdoptionGroups>(baseQs);
    const people = useAdoptionPeople<AdoptionPerson>(qs, reveal);
    const view = people.data ?? null;
    const auditFailed = reveal && (people.error instanceof AdoptionAuditUnavailableError || (!!view && view.reveal && !view.auditRecorded));
    return { summary, areas, studio, groups, groupOptions, people, view, auditFailed };
}

function GroupSelect({ value, onChange, options, total }: { value: string; onChange: (v: string) => void; options: AdoptionGroups | null; total: number | null }) {
    const { t } = useTranslation();
    return (
        <label className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--text-muted)]">
            {t('adoption.group_label', 'Group')}
            <select value={value} onChange={(e) => onChange(e.target.value)}
                className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-2 py-1.5 text-[12px] font-normal text-[var(--text-primary)]">
                <option value="">{total != null ? t('adoption.group_all_n', 'All groups ({n} members)', { n: total }) : t('adoption.group_all', 'All groups')}</option>
                {(options?.groups || []).map(g => <option key={g.id} value={g.id}>{`${g.name} (${g.members})`}</option>)}
            </select>
        </label>
    );
}

function trendStatus(s: AdoptionSummary | null, t: T) {
    if (!s?.prev) return undefined;
    const d = s.adoptionRate - s.prev.adoptionRate;
    if (d >= 1) return { label: t('adoption.status_growing', 'Growing'), color: '#10b981' };
    if (d <= -1) return { label: t('adoption.status_declining', 'Declining'), color: '#ef4444' };
    return { label: t('adoption.status_steady', 'Steady'), color: '#94a3b8' };
}

function headerText(s: AdoptionSummary | null, t: T): string {
    const base = t('adoption.description', 'Who uses Bee Flow, what they build, and where the AI spend goes');
    if (!s) return base;
    const range = formatDateRange(s.range.startDate, s.range.endDate);
    const prev = s.prev && s.range.days != null ? t('adoption.description_prev', 'compared with the {n} days before', { n: s.range.days }) : null;
    return [base, range, prev].filter(Boolean).join(' · ');
}

function Skeleton() {
    return (
        <div className="flex flex-col gap-3" aria-hidden="true">
            <div className="h-[180px] animate-pulse rounded-[14px] bg-[var(--bg-tertiary)]" />
            <div className="h-[220px] animate-pulse rounded-xl bg-[var(--bg-tertiary)]" />
        </div>
    );
}

type Data = ReturnType<typeof useAdoptionData>;

function exportAll(d: Data, reveal: boolean) {
    const csv = adoptionCsv({
        summary: d.summary.data ?? null, areas: d.areas.data ?? null, studio: d.studio.data ?? null,
        groups: d.groups.data ?? null, people: d.auditFailed ? null : d.view, revealed: reveal,
    });
    const r = d.summary.data?.range;
    downloadCsv(`adoption-${r ? `${r.startDate.slice(0, 10)}-${r.endDate.slice(0, 10)}` : 'report'}.csv`, csv);
}

function isPartial(d: Data): boolean {
    return [d.summary.data, d.areas.data, d.studio.data, d.groups.data].some(x => !!x?.partial);
}

interface BodyProps { d: Data; props: AdoptionTabProps; qs: string; scopeLabel: string; reveal: boolean; setReveal: (v: boolean) => void }

function AdoptionBody({ d, props, qs, scopeLabel, reveal, setReveal }: BodyProps) {
    const { t } = useTranslation();
    const [openKind, setOpenKind] = useState<string | null>(null);
    const currency = props.currency || '€';
    const summary = d.summary.data;
    if (!summary) return <EmptyInline boxed text={t('adoption.unavailable', 'The adoption report could not be read. It needs the Monitoring permission and an organisation.')} />;
    const showCalls = props.showTokens && summary.spend.calls != null;
    const kind = openKind ? d.studio.data?.kinds.find(k => k.kind === openKind) ?? null : null;
    return (
        <>
            {isPartial(d) && <AlertBanner severity="amber" title={t('adoption.partial_title', 'Incomplete')} message={t('adoption.partial', 'Some figures could not be read; the numbers shown leave them out.')} />}
            <AdoptionHero summary={summary} currency={currency} showCalls={showCalls} />
            {d.areas.data && <AreasSection data={d.areas.data} currency={currency} showCalls={showCalls} />}
            {d.studio.data && <StudioTable kinds={d.studio.data.kinds} currency={currency} onOpen={setOpenKind} />}
            {kind && <StudioDrilldown kind={kind} qs={qs} currency={currency} scopeLabel={scopeLabel} onClose={() => setOpenKind(null)} />}
            {d.groups.data && <GroupsTable data={d.groups.data} currency={currency} />}
            <PeopleTable
                view={d.view} loading={d.people.isFetching} revealed={reveal} auditFailed={d.auditFailed}
                revealedAt={reveal && d.view?.reveal ? d.people.dataUpdatedAt : null} scopeLabel={scopeLabel}
                currency={currency} showCalls={showCalls} hasMore={!!d.people.hasNextPage}
                onLoadMore={() => { void d.people.fetchNextPage(); }} onReveal={() => setReveal(true)} onHide={() => setReveal(false)}
            />
            <AdoptionNotes />
        </>
    );
}

/**
 * Settings → Organisation → Usage & Monitoring → Adoption: who uses Bee Flow,
 * what they build in Studio and where the AI spend goes, for an org admin.
 * The period comes from the page's range picker; the tab has its own group
 * filter (the page's user/agent/model filters do not apply here) and a CSV
 * export of what is on screen.
 */
export default function AdoptionTab(props: AdoptionTabProps) {
    const { t } = useTranslation();
    const [group, setGroup] = useState('');
    const [reveal, setReveal] = useState(false);
    const baseQs = adoptionQuery(props.rangeParams, props.rangePreset, '');
    const qs = adoptionQuery(props.rangeParams, props.rangePreset, group);
    const d = useAdoptionData(baseQs, qs, reveal);
    const summary = d.summary.data ?? null;
    const groupName = d.groupOptions.data?.groups.find(g => g.id === group)?.name;
    const range = summary ? formatDateRange(summary.range.startDate, summary.range.endDate) : '';
    const scopeLabel = [range, groupName || t('adoption.group_all_lower', 'all groups')].filter(Boolean).join(' · ');
    return (
        <div className="flex flex-col gap-4">
            <TabHeader icon={Users} iconColor="#10b981" title={t('adoption.title', 'Adoption')} description={headerText(summary, t)} status={trendStatus(summary, t)}
                actions={(
                    <>
                        <GroupSelect value={group} onChange={setGroup} options={d.groupOptions.data ?? null} total={group ? null : summary?.members.total ?? null} />
                        <button type="button" onClick={() => exportAll(d, reveal)} disabled={!summary}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-2.5 py-1.5 text-[12px] font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50">
                            <Download className="h-3.5 w-3.5" aria-hidden="true" />{t('adoption.export_csv', 'Export CSV')}
                        </button>
                    </>
                )} />
            {d.summary.isLoading ? <Skeleton /> : <AdoptionBody d={d} props={props} qs={qs} scopeLabel={scopeLabel} reveal={reveal} setReveal={setReveal} />}
        </div>
    );
}
