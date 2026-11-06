import { useState } from 'react';
import {
    AdoptionAuditUnavailableError, useAdoptionAreas, useAdoptionGroups, useAdoptionPeople, useAdoptionStudio, useAdoptionSummary,
} from '@/api/queries/usageAdoption';
import { useTranslation } from '@/hooks/useTranslation';
import { USAGE_ALL_DAYS, type RangeParams } from '@/utils/usageHelpers';
import { AlertBanner, EmptyInline } from '../kit';
import { SubTabs } from '../shell';
import { formatDateRange } from '../format';
import type { AdoptionAreas, AdoptionGroups, AdoptionPerson, AdoptionStudio, AdoptionSummary } from './adoption.types';
import AdoptionHero from './AdoptionHero';
import AreasSection from './AreasSection';
import GroupsTable from './GroupsTable';
import PeopleTable, { shownView } from './PeopleTable';
import StudioTable from './StudioTable';

export interface AdoptionTabProps {
    rangeParams: RangeParams;
    /** The range picker's preset: only a custom range is sent as an absolute window. */
    rangePreset?: string;
    showTokens: boolean;
    /** The subscription's currency symbol; € when unknown. */
    currency?: string;
    /** Page-wide compare switch: off hides every change against the previous period. */
    compare?: boolean;
    /** Sub-tab to open first (studio, people, groups or areas); Studio by default. */
    initialSubTab?: string;
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
    // A hidden read never shows a revealed answer, not even as a placeholder.
    const view = shownView(people.data ?? null, reveal);
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

function Skeleton() {
    return (
        <div className="flex flex-col gap-3" aria-hidden="true">
            <div className="h-[180px] animate-pulse rounded-[14px] bg-[var(--bg-tertiary)]" />
            <div className="h-[220px] animate-pulse rounded-xl bg-[var(--bg-tertiary)]" />
        </div>
    );
}

type Data = ReturnType<typeof useAdoptionData>;

function isPartial(d: Data): boolean {
    return [d.summary.data, d.areas.data, d.studio.data, d.groups.data].some(x => !!x?.partial);
}

interface BodyProps { sub: SubId; setSub: (s: SubId) => void; d: Data; props: AdoptionTabProps; qs: string; scopeLabel: string; reveal: boolean; setReveal: (v: boolean) => void }

const SUB_IDS = ['studio', 'people', 'groups', 'areas'] as const;
type SubId = (typeof SUB_IDS)[number];

function seedSubTab(id: string | undefined): SubId {
    return SUB_IDS.find(s => s === id) ?? 'studio';
}

function subTabLabels(t: ReturnType<typeof useTranslation>['t']) {
    return {
        options: [
            { id: 'studio', label: t('adoption.sub_studio', 'Studio') },
            { id: 'people', label: t('adoption.sub_people', 'People') },
            { id: 'groups', label: t('adoption.sub_groups', 'Groups') },
            { id: 'areas', label: t('adoption.sub_areas', 'Areas') },
        ],
        descriptions: {
            studio: t('adoption.sub_studio_desc', 'Studio: what people build in Bee Flow and whether it gets used.'),
            people: t('adoption.sub_people_desc', 'People: who uses AI, who only signs in and who is dormant. Names stay pseudonymous until revealed.'),
            groups: t('adoption.sub_groups_desc', 'Groups: how each group adopts AI. Small groups are folded into one row.'),
            areas: t('adoption.sub_areas_desc', 'Areas: where the AI spend goes, by area of the product.'),
        } satisfies Record<SubId, string>,
    };
}

interface ViewProps extends BodyProps { currency: string; showCalls: boolean; compare: boolean }

function AdoptionView({ sub, d, qs, scopeLabel, reveal, setReveal, currency, showCalls, compare }: ViewProps) {
    if (sub === 'studio') return d.studio.data ? <StudioTable kinds={d.studio.data.kinds} currency={currency} qs={qs} scopeLabel={scopeLabel} compare={compare} /> : null;
    if (sub === 'groups') return d.groups.data ? <GroupsTable data={d.groups.data} currency={currency} /> : null;
    if (sub === 'areas') return d.areas.data ? <AreasSection data={d.areas.data} currency={currency} showCalls={showCalls} /> : null;
    return (
        <PeopleTable
            view={d.view} loading={d.people.isFetching} revealed={reveal} auditFailed={d.auditFailed}
            revealedAt={reveal && d.view?.reveal ? d.people.dataUpdatedAt : null} scopeLabel={scopeLabel}
            currency={currency} showCalls={showCalls} hasMore={!!d.people.hasNextPage}
            onLoadMore={() => { void d.people.fetchNextPage(); }} onReveal={() => setReveal(true)} onHide={() => setReveal(false)}
        />
    );
}

function AdoptionBody(body: BodyProps) {
    const { t } = useTranslation();
    const { sub, setSub, d, props } = body;
    const summary = d.summary.data;
    if (!summary) return <EmptyInline boxed text={t('adoption.unavailable', 'The adoption report could not be read. It needs the Monitoring permission and an organisation.')} />;
    const currency = props.currency || '€';
    const compare = props.compare ?? true;
    const showCalls = props.showTokens && summary.spend.calls != null;
    const { options, descriptions } = subTabLabels(t);
    return (
        <>
            {isPartial(d) && <AlertBanner severity="amber" title={t('adoption.partial_title', 'Incomplete')} message={t('adoption.partial', 'Some figures could not be read; the numbers shown leave them out.')} />}
            <AdoptionHero summary={summary} currency={currency} showCalls={showCalls} compare={compare} onOpenAreas={sub === 'areas' ? undefined : () => setSub('areas')} />
            <SubTabs value={sub} onChange={(id) => setSub(seedSubTab(id))} options={options} description={descriptions[sub]} aria-label={t('adoption.sub_label', 'Adoption views')} />
            <AdoptionView {...body} currency={currency} showCalls={showCalls} compare={compare} />
        </>
    );
}

/**
 * Settings → Organisation → Usage & Monitoring → Adoption: who uses Bee Flow,
 * what they build in Studio and where the AI spend goes, for an org admin,
 * as a hero plus four sub-tabs (Studio, People, Groups, Areas).
 * The period comes from the page's range picker; the tab has its own group
 * filter (the page's user/agent/model filters do not apply here) and a CSV
 * export of what is on screen.
 */
export default function AdoptionTab(props: AdoptionTabProps) {
    const { t } = useTranslation();
    const [group, setGroup] = useState('');
    const [reveal, setReveal] = useState(false);
    // The shell remounts this tab when a tile elsewhere opens a sub-tab, so the seed is read once. The state
    // lives here, not in the body: the body unmounts while a new group loads.
    const [sub, setSub] = useState<SubId>(() => seedSubTab(props.initialSubTab));
    const baseQs = adoptionQuery(props.rangeParams, props.rangePreset, '');
    const qs = adoptionQuery(props.rangeParams, props.rangePreset, group);
    const d = useAdoptionData(baseQs, qs, reveal);
    const summary = d.summary.data ?? null;
    const groupName = d.groupOptions.data?.groups.find(g => g.id === group)?.name;
    const range = summary ? formatDateRange(summary.range.startDate, summary.range.endDate) : '';
    const scopeLabel = [range, groupName || t('adoption.group_all_lower', 'all groups')].filter(Boolean).join(' · ');
    return (
        <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <div className="flex flex-wrap items-center gap-2">
                    <GroupSelect value={group} onChange={setGroup} options={d.groupOptions.data ?? null} total={group ? null : summary?.members.total ?? null} />
                </div>
                <p className="m-0 text-xs text-[var(--text-muted)]">{t('adoption.header_note', 'Names are pseudonymous (Member · K7Q2) until you reveal them; a reveal is written to the audit log.')}</p>
            </div>
            {d.summary.isLoading ? <Skeleton /> : <AdoptionBody sub={sub} setSub={setSub} d={d} props={props} qs={qs} scopeLabel={scopeLabel} reveal={reveal} setReveal={setReveal} />}
        </div>
    );
}
