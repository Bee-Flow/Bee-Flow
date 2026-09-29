/**
 * The pane once there is something to show, top to bottom as the design
 * lays it out: filters, "In short" beside "Worth a look", the four figures,
 * day by day, where it went beside the ranked lists, and the log.
 */

import { Globe, MessageSquareText, ScanSearch, Users } from 'lucide-react';
import React from 'react';

import type { TranslateFn } from '../../../../../../../hooks/useTranslation';
import type { ActivityView } from '../activityView';
import EgressMapCard from '../egressMap/EgressMapCard';
import type { EgressMapFilters } from '../egressMap/egressMapContract';
import type { Outcome } from '../outcomes';
import type { FindingAction } from '../shieldFindings';
import { ActivityLog } from './ActivityLog';
import { FilterBar, SampleNotice, type Chip } from './FilterBar';
import { InShort } from './InShort';
import { KpiRow } from './KpiRow';
import { DayChart } from './DayChart';
import { Panel, PanelHead } from './Panel';
import { RankCard } from './RankCard';
import { WorthALook } from './WorthALook';

export interface BodyProps {
    view: ActivityView;
    filters: Record<string, unknown>;
    chips: Chip[];
    set: (key: string, value: unknown) => void;
    remove: (key: string) => void;
    clearAll: () => void;
    shown: number;
    onMore: () => void;
    openRow: string | null;
    onOpenRow: (id: string) => void;
    mapFilters: EgressMapFilters;
    integMap: { origin?: unknown; attribution?: { text?: string | null; url?: string | null } | null; geo_db?: { available?: boolean | null } | null };
    onGoTo?: (pane: string) => void;
    catLabel: (id: string) => string;
    limit: number;
    locale: string;
    fmt: (n: number) => string;
    t: TranslateFn;
}

function Summary({ view, filters, set, onGoTo, fmt, t }: BodyProps) {
    const hasFindings = view.findings.length > 0;
    return (
        <Panel className={`grid overflow-hidden ${hasFindings ? '@min-[900px]/pane:grid-cols-[minmax(0,1fr)_minmax(0,400px)] @min-[1400px]/pane:grid-cols-[minmax(0,1fr)_520px]' : ''}`}>
            <InShort
                totals={view.inShort}
                selected={(filters.outcome as Outcome) || null}
                onToggle={o => set('outcome', o)}
                fmt={fmt}
                t={t}
            />
            {hasFindings && (
                <WorthALook
                    findings={view.findings}
                    filters={filters}
                    onShow={(a: FindingAction) => set(a.axis, a.value)}
                    onGoTo={onGoTo}
                    fmt={fmt}
                    t={t}
                />
            )}
        </Panel>
    );
}

function WhereItWent({ view, filters, set, mapFilters, integMap, onGoTo, t }: BodyProps) {
    const pct = view.totals.stayedPct;
    return (
        <Panel className="flex flex-col overflow-hidden" label={t('shield_activity.map_title', 'Where it went')}>
            <PanelHead
                icon={Globe}
                title={t('shield_activity.map_title', 'Where it went')}
                hint={pct === null ? undefined : t('shield_activity.map_stayed', '{p}% stayed in Europe', { p: pct })}
                right={t('shield_activity.map_hint', 'click a pin or a row to filter')}
            />
            <EgressMapCard
                mapDestinations={view.mapDests}
                listDestinations={view.listDests}
                origin={integMap.origin as never}
                attribution={integMap.attribution}
                geoDb={integMap.geo_db}
                selected={(filters.dest as string) || null}
                onSelect={(dest: string) => set('dest', dest)}
                onGoTo={onGoTo}
                filters={mapFilters}
                t={t}
            />
        </Panel>
    );
}

function Ranks({ view, filters, set, fmt, t }: BodyProps) {
    const empty = t('admin.shield_activity_nothing_here', 'Nothing in this selection.');
    // Counted over the loaded rows, and those are not the whole window.
    const note = view.coverage.capped
        ? t('shield_activity.rank_sampled', 'Counted over the latest {n} messages & calls', { n: fmt(view.stream.length) })
        : undefined;
    return (
        <div className="grid min-w-0 items-start gap-3.5 @min-[700px]/pane:grid-cols-3 @min-[1100px]/pane:grid-cols-1">
            <RankCard
                icon={ScanSearch}
                title={t('shield_activity.kinds_title', 'Kinds of data found')}
                items={view.kinds}
                active={(filters.kind as string) || null}
                onPick={v => set('kind', v)}
                pickLabel={i => t('admin.shield_activity_filter_kind', 'Filter on {kind}', { kind: i.label })}
                empty={empty}
                note={view.kindsSampled ? note : undefined}
                fmt={fmt}
            />
            <RankCard
                icon={MessageSquareText}
                title={t('shield_activity.places_title', 'Where it started')}
                items={view.places}
                active={(filters.place as string) || null}
                onPick={v => set('place', v)}
                pickLabel={i => t('admin.shield_activity_filter_place', 'Filter on {place}', { place: i.label })}
                empty={empty}
                note={note}
                fmt={fmt}
            />
            <RankCard
                icon={Users}
                title={t('shield_activity.people_title', 'People')}
                hint={t('shield_activity.people_hint', 'by messages with personal data')}
                items={view.people}
                active={(filters.person as string) || null}
                onPick={v => set('person', v)}
                pickLabel={i => t('admin.shield_activity_filter_person', 'Filter on {person}', { person: i.label })}
                empty={empty}
                note={note}
                fmt={fmt}
            />
        </div>
    );
}

export function ActivityBody(props: BodyProps) {
    const { view, filters, chips, set, remove, clearAll, limit, locale, fmt, t } = props;
    const selectedDay = (filters.day as string) || null;
    return (
        <>
            <FilterBar chips={chips} onRemove={remove} onClear={clearAll} shown={view.filtered.length} total={view.stream.length} capped={view.coverage.capped} t={t} />
            {view.sampled && view.coverage.capped && <SampleNotice limit={limit} t={t} />}
            <Summary {...props} />
            <KpiRow
                totals={view.totals}
                series={view.series}
                selectedDay={selectedDay ? view.days.indexOf(selectedDay) : null}
                filters={filters}
                onToggle={set}
                fmt={fmt}
                t={t}
            />
            <DayChart stacks={view.stacks} selectedDay={selectedDay} onToggleDay={d => set('day', d)} since={view.chartSince} locale={locale} fmt={fmt} t={t} />
            <div className="grid items-start gap-3.5 @min-[1100px]/pane:grid-cols-[minmax(0,1fr)_320px] @min-[1400px]/pane:grid-cols-[minmax(0,1fr)_380px]">
                <WhereItWent {...props} />
                <Ranks {...props} />
            </div>
            <ActivityLog
                rows={view.filtered}
                shown={props.shown}
                onMore={props.onMore}
                openRow={props.openRow}
                onOpenRow={props.onOpenRow}
                onPickKind={k => set('kind', k)}
                onClear={clearAll}
                catLabel={props.catLabel}
                capped={view.coverage.capped}
                limit={limit}
                locale={locale}
                fmt={fmt}
                t={t}
            />
        </>
    );
}
