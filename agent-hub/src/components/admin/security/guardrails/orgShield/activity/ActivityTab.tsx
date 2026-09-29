// The Privacy Shield "What happened" tab — evidence, where the other panes
// are policy.
//
// ── One cross-filter, not a dashboard ────────────────────────────────────
// Every panel here is both a READOUT and a CONTROL: an outcome pill, a
// finding, a KPI, a day in the chart, a pin or destination on the map, a
// person, a place, and every category chip — including the ones inside a log
// row. Filters STACK across eight axes, show as removable chips at the top,
// and every panel recounts, so you can always see what is left.
//
// The question an admin arrives with is a conjunction ("what did Sanne send
// to Gmail that day"); answering one axis at a time made you start over for
// the next.
//
// ── Where the numbers come from ──────────────────────────────────────────
// Unfiltered: the server's aggregates for the whole window. Filtered: the
// loaded rows (≤200 per ledger), with a notice when that is not the whole
// window. The rules live in activityView.ts, shieldTotals.ts and
// shieldFindings.ts, which are pure and tested; this file holds the state.

import { Lock } from 'lucide-react';
import React, { useCallback, useMemo, useState } from 'react';

import { OUTCOME_WORDS, REGION_WORDS, surfaceLabel, useCategoryLabels, wordFor } from './activityLabels';
import { buildView, type ActivityView, type ViewInput } from './activityView';
import { ActivityBody } from './parts/ActivityBody';
import { ActivityHeader, type RangePreset } from './parts/ActivityHeader';
import { PAGE } from './parts/ActivityLog';
import type { Chip } from './parts/FilterBar';
import { FILTER_KEYS, removeFilter, toggleFilter } from './shieldFilters';
import { formatDay, formatPeriod, intlLocale } from './shieldDates';
import { toStreamRows } from './shieldStream';
import useShieldActivityData from './useShieldActivity';
import { ALERT_SCORE_THRESHOLD, SAFETY_PII_ALERT } from '../../../../../../config/analyticsConfig';
import { useTranslation, type TranslateFn } from '../../../../../../hooks/useTranslation';
import { defaultRange } from '../../../../../../pages/settings/usage/RangeControl';
import { deriveRangeParams } from '../../../../../../utils/usageHelpers';
import LicenceLock from '../parts/LicenceLock';
import type { Region } from '../shieldPalette';

type Filters = Record<string, unknown>;

interface Props {
    t: TranslateFn;
    shieldEnabled: boolean;
    licensed: boolean;
    upgradeUrl?: string | null;
    onGoTo?: (pane: string) => void;
    /** Kinds of personal data tools hold back, of all kinds (from the form). */
    toolHoldBack?: { held: number; total: number } | null;
}

function Locked({ upgradeUrl, t }: Pick<Props, 'upgradeUrl' | 't'>) {
    return (
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] p-6 text-center">
            <Lock className="mx-auto mb-2 h-6 w-6 text-[var(--text-muted)]" aria-hidden="true" />
            <p className="mb-1 text-sm font-medium text-[var(--text-primary)]">
                {t('admin.shield_activity_locked_title', 'See what actually happened')}
            </p>
            <p className="mb-2 text-xs text-[var(--text-secondary)]">
                {t('admin.shield_activity_locked_body', 'Activity reporting is part of the Enterprise plan.')}
            </p>
            <div className="inline-block"><LicenceLock upgradeUrl={upgradeUrl} t={t}>{''}</LicenceLock></div>
        </div>
    );
}

function Notes({ shieldEnabled, error, loading, empty, t }: { shieldEnabled: boolean; error: unknown; loading: boolean; empty: boolean; t: TranslateFn }) {
    return (
        <>
            {!shieldEnabled && (
                <p className="m-0 rounded-lg bg-[var(--bg-tertiary)] px-3 py-2 text-xs text-[var(--text-secondary)]">
                    {t('admin.shield_activity_off_note', 'The shield is off right now — nothing new is being checked. You are looking at past activity.')}
                </p>
            )}
            {!!error && (
                <p role="alert" className="m-0 rounded-lg bg-[color-mix(in_srgb,var(--error)_8%,transparent)] px-3 py-2 text-xs text-[var(--error-ink)]">
                    {t('admin.shield_activity_error', 'Could not load activity. Reload the page to try again.')}
                </p>
            )}
            {loading && !error && (
                <p className="m-0 py-6 text-center text-xs text-[var(--text-tertiary)]">{t('admin.shield_loading', 'Loading settings...')}</p>
            )}
            {empty && !error && !loading && (
                <p className="m-0 rounded-xl bg-[var(--bg-tertiary)] py-8 text-center text-xs text-[var(--text-secondary)]">
                    {t('admin.shield_activity_empty', 'Nothing to show yet. Activity appears here once people start using the assistant.')}
                </p>
            )}
        </>
    );
}

/** The active filters as chips, in axis order, each named in words. */
function useChips(filters: Filters, view: ActivityView, catLabel: (id: string) => string, locale: string, t: TranslateFn): Chip[] {
    return useMemo(() => {
        const person = (id: string) => view.stream.find(r => r.person === id)?.personLabel || id;
        const words: Record<string, (v: string) => [string, string]> = {
            kind: v => [t('admin.shield_activity_d_kind', 'Kind'), catLabel(v)],
            person: v => [t('admin.shield_activity_col_person', 'Person'), person(v)],
            place: v => [t('shield_activity.col_started', 'Started in'), v],
            dest: v => [t('shield_activity.axis_dest', 'Destination'), v],
            region: v => [t('shield_activity.axis_region', 'Region'), wordFor(REGION_WORDS, v, t)],
            outcome: v => [t('shield_activity.axis_outcome', 'Outcome'), wordFor(OUTCOME_WORDS, v, t)],
            pii: () => ['', t('shield_activity.chip_pii', 'Contains personal data')],
            day: v => [t('shield_activity.axis_day', 'Day'), formatDay(v, locale, { weekday: true })],
        };
        return (FILTER_KEYS as string[]).filter(k => Object.hasOwn(filters, k)).map(key => {
            const [axis, label] = words[key](String(filters[key]));
            return { key, axis, label };
        });
    }, [filters, view.stream, catLabel, locale, t]);
}

export default function ActivityTab({ t, shieldEnabled, licensed, upgradeUrl, onGoTo, toolHoldBack }: Props) {
    const { resolvedLocale: locale } = useTranslation();
    const [range, setRange] = useState(() => defaultRange('30d'));
    const rangeParams = useMemo(() => deriveRangeParams(range), [range]);
    const [filters, setFilters] = useState<Filters>({});
    const [openRow, setOpenRow] = useState<string | null>(null);
    const [shown, setShown] = useState(PAGE);
    const catLabel = useCategoryLabels(t);
    const data = useShieldActivityData({ enabled: !!licensed, rangeParams });
    const placeLabel = useCallback((row: Record<string, unknown>) => surfaceLabel(row, t), [t]);

    // The editor passes a fresh object each render; key the memo on its numbers.
    const held = toolHoldBack?.held;
    const kindsTotal = toolHoldBack?.total;
    const holdBack = useMemo(() => (held === undefined || kindsTotal === undefined ? null : { held, total: kindsTotal }), [held, kindsTotal]);

    const { guard, integ, guardRows, egressRows, limit } = data;
    const stream = useMemo(() => toStreamRows(guardRows, egressRows, { placeLabel }), [guardRows, egressRows, placeLabel]);
    const view = useMemo(() => buildView({
        guard: guard as ViewInput['guard'], integ: integ as ViewInput['integ'],
        guardRows, egressRows, limit, rangeParams, toolHoldBack: holdBack,
        thresholds: { score: ALERT_SCORE_THRESHOLD, catches: SAFETY_PII_ALERT }, placeLabel,
    }, stream, filters, catLabel), [guard, integ, guardRows, egressRows, limit, rangeParams, holdBack, placeLabel, stream, filters, catLabel]);
    const chips = useChips(filters, view, catLabel, locale, t);
    const fmt = useMemo(() => {
        const nf = new Intl.NumberFormat(intlLocale(locale));
        return (n: number) => nf.format(n);
    }, [locale]);

    const reset = () => { setOpenRow(null); setShown(PAGE); };
    const set = (key: string, value: unknown) => { setFilters(f => toggleFilter(f, key, value)); reset(); };
    const remove = (key: string) => { setFilters(f => removeFilter(f, key)); reset(); };
    const clearAll = () => { setFilters({}); reset(); };
    const mapFilters = {
        ...view.mapData, catLabel,
        selectedKind: (filters.kind as string) || null,
        onSelectKind: (id: string | null) => (id === null ? remove('kind') : set('kind', id)),
        selectedRegion: (filters.region as Region) || null,
        onSelectRegion: (region: Region) => set('region', region),
    };

    // The licence gate sits below every hook on purpose: an early return above
    // them would make the hook ORDER depend on the licence, which React
    // forbids — and with the fetch disabled, the hooks above are cheap.
    if (!licensed) return <Locked upgradeUrl={upgradeUrl} t={t} />;

    const ready = !data.loading && !view.empty && !data.error;
    return (
        <div className="flex min-h-0 flex-col gap-3.5 text-[13px] text-[var(--text-primary)]">
            <ActivityHeader
                period={formatPeriod(view.window.start, view.window.end, locale)}
                preset={range.preset}
                onPreset={(preset: RangePreset) => { setRange(r => ({ ...r, preset })); reset(); }}
                t={t}
            />
            <Notes shieldEnabled={shieldEnabled} error={data.error} loading={data.loading} empty={view.empty} t={t} />
            {ready && (
                <ActivityBody
                    view={view} filters={filters} chips={chips} set={set} remove={remove} clearAll={clearAll}
                    shown={shown} onMore={() => setShown(n => n + PAGE)}
                    openRow={openRow} onOpenRow={id => setOpenRow(v => (v === id ? null : id))}
                    mapFilters={mapFilters} integMap={integ.map || {}} onGoTo={onGoTo}
                    catLabel={catLabel} limit={limit} locale={locale} fmt={fmt} t={t}
                />
            )}
        </div>
    );
}
