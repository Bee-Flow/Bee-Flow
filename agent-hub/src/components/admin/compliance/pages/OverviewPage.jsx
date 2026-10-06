import React, { useCallback, useMemo } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { sectionById } from '../sections';
import { splitByToday } from '../shared/calendarMath';
import RegulatoryCalendar from '../shared/RegulatoryCalendar';
import TimelinePhases from '../shared/TimelinePhases';
import { OverviewSkeleton, CheckCardSkeleton } from '../shared/Skeleton';
import FrameworkScoreCard from './overview/FrameworkScoreCard';
import AttentionList from './overview/AttentionList';
import DeadlinesCard from './overview/DeadlinesCard';
import UpcomingDatesCard from './overview/UpcomingDatesCard';
import ReportsTab from './overview/ReportsTab';
import SetupCard from './overview/SetupCard';

/**
 * OverviewPage — Compliance › Overview (artboard 1a + 1g, PLAN-FRONTEND C6/C13).
 *
 * Receives the hub's ONE props object (see data/pages.jsx). Three tabs:
 *   status    three framework score cards over an attention list (1fr) and the
 *             clocks column (380px)
 *   calendar  the full regulatory calendar + the AI Act phase timeline
 *   reports   every PDF/ZIP export, behind `exportsEnabled`
 *
 * NOT SET UP (`core.onboarded === false`) is ONE path: the inline SetupCard,
 * three placeholder framework cards and the note that the clocks already run.
 * No banner, no hero, no modal — a second entry point is how the old screen
 * ended up with two "start setup" buttons that disagreed.
 */

// The three core frameworks, in artboard order. `fw` is the framework id the
// server scores under (`frameworks_detail`, `verification_summary_by_framework`,
// MiniBars); `section` is where a click lands; `legacy` is the pre-frameworks
// overview key that still ships. `law` is the national/standard name printed
// after the in-force date — plain data, not a translatable sentence.
export const FRAMEWORK_CARDS = Object.freeze([
    Object.freeze({ fw: 'gdpr', section: 'gdpr', legacy: 'gdpr', law: 'UAVG', unit: 'checks' }),
    Object.freeze({ fw: 'aia', section: 'aia', legacy: 'aia', law: null, unit: 'checks' }),
    Object.freeze({ fw: 'iso27001', section: 'iso', legacy: 'iso', law: 'ISO/IEC 27001:2022 + Amd 1:2024', unit: 'controls' }),
]);

export default function OverviewPage({
    section, tab, navigate, onNavigate, exportsEnabled = true, dl, api = '/api/compliance',
    isMobile = false, data = {}, setHeaderActions,
}) {
    const { t } = useTranslation();
    const core = data.core || {};
    const overview = core.overview || null;
    const counts = data.counts || null;
    const attention = data.attention || {};
    const deadlines = data.deadlines || {};
    const frameworks = data.frameworks || {};
    const calendar = data.calendar || {};

    const milestones = calendar.milestones ?? null;
    const activeTab = tab || section?.tabs?.[0] || 'status';
    const setupNeeded = core.onboarded === false;

    const upcoming = useMemo(() => (Array.isArray(milestones) ? splitByToday(milestones).upcoming : []), [milestones]);
    const nextAia = useMemo(() => upcoming.find(m => m.framework_id === 'aia') || null, [upcoming]);

    const openCalendar = useCallback(() => {
        // The full calendar lives on Frameworks › Calendar. The tab travels
        // with the navigation: a host that pushes a new URL re-reads `?tab=`
        // from it, so a tab set beforehand would be lost.
        navigate?.('frameworks', undefined, 'calendar');
    }, [navigate]);

    if (core.loading && !overview) {
        return (
            <div className="flex flex-col gap-4 p-4" data-testid="overview-loading">
                <OverviewSkeleton />
                <CheckCardSkeleton count={3} />
            </div>
        );
    }

    // Both clocks work before setup, so they render on either path — stacked in
    // the 380px column next to the attention list, side by side without it.
    const clockCards = (
        <>
            <DeadlinesCard
                items={deadlines.items ?? null}
                emptyKinds={deadlines.emptyKinds || []}
                failed={!!deadlines.failed}
                navigate={navigate}
            />
            <UpcomingDatesCard
                milestones={milestones}
                failed={!!calendar.failed}
                onOpenCalendar={openCalendar}
            />
        </>
    );

    if (activeTab === 'reports') {
        return (
            <div className="flex flex-col gap-3 p-4" data-testid="overview-page" data-tab="reports">
                <ReportsTab
                    api={api}
                    dl={dl}
                    exportsEnabled={exportsEnabled}
                    isoEnabled={frameworks.frameworks ? frameworks.isEnabled?.('iso27001') ?? null : null}
                />
            </div>
        );
    }

    if (activeTab === 'calendar') {
        const phases = aiaPhases(upcoming, milestones, frameworks, t);
        return (
            <div className="flex flex-col gap-3 p-4" data-testid="overview-page" data-tab="calendar">
                <section
                    className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] px-4 py-3.5"
                    style={{ boxShadow: 'var(--shadow-sm)' }}
                    data-testid="overview-calendar"
                    aria-label={t('compliance.ovw_calendar_title', 'Regulatory calendar')}
                >
                    <h3 className="m-0 text-[13px] font-semibold text-[var(--text-primary)]">
                        {t('compliance.ovw_calendar_title', 'Regulatory calendar')}
                    </h3>
                    <p className="m-0 mt-0.5 mb-2 text-[11px] text-[var(--text-tertiary)]">
                        {t('compliance.ovw_calendar_hint', 'Only the frameworks that affect you — not legal advice.')}
                    </p>
                    {milestones === null ? (
                        <p className="m-0 text-xs text-[var(--text-tertiary)]" data-testid="overview-calendar-unavailable">
                            {calendar.failed
                                ? t('compliance.ovw_calendar_unavailable', 'Could not read the regulatory calendar right now.')
                                : t('compliance.ovw_calendar_loading', 'Reading the calendar…')}
                        </p>
                    ) : (
                        <RegulatoryCalendar variant="full" milestones={milestones} testId="overview-calendar-full" />
                    )}
                </section>
                {phases ? (
                    <section
                        className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] px-4 py-3.5"
                        style={{ boxShadow: 'var(--shadow-sm)' }}
                        data-testid="overview-aia-phases"
                        aria-label={t('compliance.ovw_aia_phases_title', 'AI Act — phasing')}
                    >
                        <h3 className="m-0 mb-3 text-[13px] font-semibold text-[var(--text-primary)]">
                            {t('compliance.ovw_aia_phases_title', 'AI Act — phasing')}
                        </h3>
                        <TimelinePhases phases={phases} testId="overview-aia-timeline" />
                    </section>
                ) : null}
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-3 p-4" data-testid="overview-page" data-tab="status" data-setup={setupNeeded ? 'true' : undefined}>
            {setupNeeded ? (
                <SetupCard
                    settings={core.settings}
                    orgUsers={data.orgUsers ?? null}
                    onAutoDetect={core.autoDetect}
                    onFinish={core.finishSetup}
                    onStepChange={(step) => setHeaderActions?.({ setupStep: step })}
                />
            ) : null}

            {/* Three across down to an 880px page: at 1180 the cards stacked on every
                1440px laptop (a 300px rail leaves ~1140) and pushed "Needs attention"
                below the fold. Below 880 two across, below 600 one. */}
            <div className={`grid gap-3 ${isMobile ? 'grid-cols-1' : 'grid-cols-3 @max-[880px]/cpage:grid-cols-2 @max-[600px]/cpage:grid-cols-1'}`} data-testid="overview-scores">
                {FRAMEWORK_CARDS.map(card => {
                    const meta = sectionById(card.section);
                    const fwRecord = frameworks.byId?.(card.fw) || null;
                    const name = meta ? t(meta.labelKey, meta.labelFallback) : card.fw;
                    if (setupNeeded) {
                        return (
                            <FrameworkScoreCard
                                key={card.fw}
                                frameworkId={card.fw}
                                name={name}
                                icon={meta?.icon}
                                placeholder
                                placeholderNote={card.fw === 'iso27001'
                                    ? t('compliance.setup_iso_note', 'ISMS evidence starts with the first run — every day counts towards Stage 2.')
                                    : t('compliance.setup_score_after', 'Score after setup — {n} checks are ready', { n: fwRecord?.checks_count ?? '—' })}
                                testId={`fw-score-card-${card.fw}`}
                            />
                        );
                    }
                    return (
                        <FrameworkScoreCard
                            key={card.fw}
                            frameworkId={card.fw}
                            name={name}
                            icon={meta?.icon}
                            score={overview?.frameworks_detail?.[card.fw] ?? overview?.[card.legacy] ?? null}
                            verification={overview?.verification_summary_by_framework?.[card.fw] ?? null}
                            soa={card.fw === 'iso27001' ? (counts?.soa ?? null) : null}
                            history={core.scoreHistory || []}
                            inForceSince={fwRecord?.in_force_since ?? null}
                            law={card.law}
                            nextMilestone={card.fw === 'aia' && nextAia
                                ? { date: nextAia.date, label: nextAia.label ?? (nextAia.label_key ? t(nextAia.label_key, '') : '') }
                                : null}
                            unit={card.unit}
                            onOpen={() => navigate?.(card.section)}
                            testId={`fw-score-card-${card.fw}`}
                        />
                    );
                })}
            </div>

            {setupNeeded ? (
                <p className="m-0 text-[11px] leading-relaxed text-[var(--text-tertiary)]" data-testid="overview-clocks-note">
                    {t('compliance.setup_clocks_note', 'Deadlines and the regulatory calendar already work before setup: a request through /dsr starts its clock now too.')}
                </p>
            ) : null}

            {setupNeeded ? (
                <div className={`grid gap-3 ${isMobile ? 'grid-cols-1' : 'grid-cols-2 @max-[960px]/cpage:grid-cols-1'}`} data-testid="overview-clocks">
                    {clockCards}
                </div>
            ) : (
                <div className={`grid gap-3 ${isMobile ? 'grid-cols-1' : 'grid-cols-[minmax(0,1fr)_380px] @max-[960px]/cpage:grid-cols-1'}`}>
                    <AttentionList
                        attention={attention.attention ?? null}
                        items={attention.items ?? null}
                        failed={!!attention.failed}
                        onAutoFix={core.autoFix}
                        autoFixingId={core.autoFixingId ?? null}
                        navigate={navigate}
                        onNavigate={onNavigate}
                    />
                    <div className="flex flex-col gap-3" data-testid="overview-clocks">{clockCards}</div>
                </div>
            )}

            {!setupNeeded ? (
                <p className="m-0 text-[11px] leading-relaxed text-[var(--text-tertiary)]" data-testid="overview-formula">
                    {t('compliance.ovw_score_formula',
                        'Score = Σ(weight × status) / Σ weight × 100 — passing 1 · attention ½ · failing 0 · n/a does not count. Self-attested items are always listed separately, so a green number never promises more than the tooling has seen. The figures support your ISMS, internal auditor and certification body — they do not replace them.')}
                </p>
            ) : null}
        </div>
    );
}

/**
 * AI Act phases for `TimelinePhases`: the calendar milestones of framework
 * `aia` when the server sent them, else the static `phases[]` on the framework
 * record. The state is the CALLER's word — a dated milestone in the past is
 * `done`, the first future one is `upcoming`, the rest are `future`.
 */
export function aiaPhases(upcoming, milestones, frameworks, t) {
    const rows = Array.isArray(milestones)
        ? milestones.filter(m => m.framework_id === 'aia' && m.date)
        : (frameworks?.byId?.('aia')?.phases || []).filter(p => p?.date);
    if (!rows.length) return null;
    const upcomingIds = new Set((upcoming || []).filter(m => m.framework_id === 'aia').map(m => m.id));
    const nextId = (upcoming || []).find(m => m.framework_id === 'aia')?.id ?? null;
    return rows
        .slice()
        .sort((a, b) => String(a.date).localeCompare(String(b.date)))
        .map((row) => {
            const title = row.label ?? (row.label_key ? t(row.label_key, row.id || '') : row.id || '');
            const subtitle = row.detail ?? (row.detail_key ? t(row.detail_key, '') : '');
            const isUpcoming = row.id != null ? upcomingIds.has(row.id) : new Date(row.date).getTime() >= Date.now();
            return {
                date: row.date,
                title,
                subtitle: subtitle || undefined,
                state: !isUpcoming ? 'done' : (row.id != null && row.id === nextId ? 'upcoming' : 'future'),
            };
        });
}
