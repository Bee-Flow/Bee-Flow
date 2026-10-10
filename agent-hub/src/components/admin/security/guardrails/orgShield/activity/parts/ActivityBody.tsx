/**
 * The pane once there is something to show: the filter bar, then one of four
 * parts behind a tab bar of its own.
 *
 *   Where it went   the map beside the findings ("Worth a look")
 *   Figures         the outcome strip, the four figures, day by day
 *   Kinds & people  the three ranked lists
 *   Log             every message and call
 *
 * One scroll with all of it was a very long page; the parts are tabs now, the
 * map first because it is the one picture an admin opens this pane for. The
 * filters are ONE set across the parts: a pin clicked on the map narrows the
 * log, and the chips above the tabs say so wherever you are.
 */

import { Globe, MessageSquareText, ScanSearch, Users } from 'lucide-react';
import React, { useState } from 'react';

import type { TranslateFn } from '../../../../../../../hooks/useTranslation';
import Tabs from '../../../../../../shared/Tabs';
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

/** The parts of the pane, in tab order. */
export const ACTIVITY_PARTS = ['map', 'figures', 'lists', 'log'] as const;
export type ActivityPart = typeof ACTIVITY_PARTS[number];

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

/** The map, with the findings beside it where there are any. */
function MapAndFindings(props: BodyProps) {
    const { view, filters, set, onGoTo, fmt, t } = props;
    const hasFindings = view.findings.length > 0;
    return (
        <div className={`grid items-start gap-3.5 ${hasFindings ? '@min-[1100px]/pane:grid-cols-[minmax(0,1fr)_380px] @min-[1400px]/pane:grid-cols-[minmax(0,1fr)_440px]' : ''}`}>
            <WhereItWent {...props} />
            {hasFindings && (
                <Panel className="overflow-hidden" label={t('shield_activity.worth_a_look', 'Worth a look')}>
                    <WorthALook
                        findings={view.findings}
                        filters={filters}
                        onShow={(a: FindingAction) => set(a.axis, a.value)}
                        onGoTo={onGoTo}
                        fmt={fmt}
                        t={t}
                    />
                </Panel>
            )}
        </div>
    );
}

/** The outcome bar and its pills: the pane's outcome filter, in one strip. */
function Outcomes({ view, filters, set, fmt, t }: BodyProps) {
    return (
        <Panel className="overflow-hidden" label={t('shield_activity.in_short', 'In short')}>
            <InShort
                totals={view.inShort}
                selected={(filters.outcome as Outcome) || null}
                onToggle={o => set('outcome', o)}
                fmt={fmt}
                t={t}
            />
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
        <div className="grid min-w-0 items-start gap-3.5 @min-[700px]/pane:grid-cols-3">
            <RankCard
                icon={ScanSearch}
                title={t('shield_activity.kinds_title', 'Kinds of data found')}
                items={view.kinds}
                active={(filters.kind as string) || null}
                onPick={v => set('kind', v)}
                pickLabel={i => t('admin.shield_activity_filter_kind', 'Filter on {kind}', { kind: i.label })}
                empty={empty}
                note={view.kindsSampled ? note : undefined}
                totalOnlyNote={view.specialTotalOnly
                    ? t('shield_activity.special_category_total_only', 'Health data is shown as an organisation total only, never per person.')
                    : undefined}
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

/** The outcome strip, the four figures and the day chart. */
function Figures(props: BodyProps) {
    const { view, filters, set, locale, fmt, t } = props;
    const selectedDay = (filters.day as string) || null;
    return (
        <>
            <Outcomes {...props} />
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
        </>
    );
}

function Log(props: BodyProps) {
    const { view, set, clearAll, limit, locale, fmt, t } = props;
    return (
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
    );
}

const PART_BODY: Record<ActivityPart, (props: BodyProps) => React.ReactElement> = {
    map: MapAndFindings,
    figures: Figures,
    lists: Ranks,
    log: Log,
};

export function ActivityBody(props: BodyProps) {
    const { view, chips, remove, clearAll, limit, fmt, t } = props;
    // Which part is open. Local to the pane: a reload lands on the map again.
    const [part, setPart] = useState<ActivityPart>('map');
    const items = [
        { id: 'map' as const, label: t('shield_activity.map_title', 'Where it went') },
        { id: 'figures' as const, label: t('shield_activity.part_figures', 'Figures') },
        { id: 'lists' as const, label: t('shield_activity.part_lists', 'Kinds & people') },
        // The count the filters leave, so the log's size is known before opening it.
        { id: 'log' as const, label: t('shield_activity.log_title', 'Log'), badge: fmt(view.filtered.length) },
    ];
    const Body = PART_BODY[part];
    return (
        <>
            <Tabs
                value={part}
                onChange={setPart}
                items={items}
                size="sm"
                ariaLabel={t('shield_activity.parts_label', 'Parts of What happened')}
            />
            <FilterBar chips={chips} onRemove={remove} onClear={clearAll} shown={view.filtered.length} total={view.stream.length} capped={view.coverage.capped} t={t} />
            {view.sampled && view.coverage.capped && <SampleNotice limit={limit} t={t} />}
            <Body {...props} />
        </>
    );
}
