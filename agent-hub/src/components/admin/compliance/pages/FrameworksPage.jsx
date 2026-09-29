import React, { useCallback, useEffect, useMemo } from 'react';
import { CalendarClock } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import RegulatoryCalendar from '../shared/RegulatoryCalendar';
import AiActPhasesCard from './frameworks/AiActPhasesCard';
import FrameworkCandidateCard, { OwnFrameworkCard } from './frameworks/FrameworkCandidateCard';
import PerAutomationTab from './frameworks/PerAutomationTab';

/**
 * FrameworksPage — "frameworks as a growing set + regulatory calendar"
 * (artboard frame 1e, PLAN-FRONTEND C11).
 *
 * Coded against the hub's page props object:
 *   { section, tab, onTab, navigate, onNavigate, focusId, isMobile, setHeaderActions,
 *     data: { core, counts, bump, frameworks, calendar } }
 * with `data.frameworks = { frameworks, active, candidates, custom, byId, isEnabled, busyId,
 * enable(id), disable(id), setRelevance(id, v, note), refresh }` and
 * `data.calendar = { milestones | null, failed }`.
 *
 * Tabs: `all` (phases card + candidate grid + calendar) · `calendar` (full-width
 * calendar) · `per_automation` (AI Act ladder outcomes; the modal is fe-8's —
 * `props.onOpenLadder(kind, id)` is called, nothing else).
 *
 * Route to the licence page for "View plan ↗": `settings/organisation/license`
 * (authedApp/settingsRoutes.js — the organisation `license` tab).
 */
export const LICENSE_PATH = 'settings/organisation/license';

/** Every non-core framework, enabled or not, locked or not — the design shows locked cards, it never hides them. */
export function candidateList(frameworks) {
    if (!Array.isArray(frameworks)) return null;
    return frameworks.filter(f => f && !f.core);
}

export default function FrameworksPage(props) {
    const { tab = 'all', navigate, onNavigate, isMobile = false, setHeaderActions, onOpenLadder, data = {}, now } = props;
    const { t } = useTranslation();
    const fw = data.frameworks || {};
    const cal = data.calendar || {};
    const core = data.core || {};
    const list = fw.frameworks ?? null;
    const candidates = useMemo(() => candidateList(list), [list]);
    const aia = useMemo(() => (Array.isArray(list) ? list.find(f => f.id === 'aia') : null) || null, [list]);
    const milestones = cal.milestones ?? null;

    const openCustom = useCallback(() => navigate?.('custom'), [navigate]);
    useEffect(() => {
        setHeaderActions?.({ onAddFramework: openCustom });
        return () => setHeaderActions?.({});
    }, [setHeaderActions, openCustom]);

    const afterMutation = useCallback(async () => {
        data.bump?.();
        await core.refresh?.();
    }, [data, core]);

    const enable = async (id) => {
        try { await fw.enable?.(id); await afterMutation(); } catch { /* the hook already toasted */ }
    };
    const disable = async (id) => {
        try { await fw.disable?.(id); await afterMutation(); } catch { /* toasted by the hook */ }
    };
    const relevance = async (id, value) => {
        try { await fw.setRelevance?.(id, value); } catch { /* toasted by the hook */ }
    };
    const viewPlan = () => { if (typeof onNavigate === 'function') onNavigate(LICENSE_PATH); else navigate?.(LICENSE_PATH); };

    if (tab === 'per_automation') return <PerAutomationTab onOpenLadder={onOpenLadder} isMobile={isMobile} />;

    const calendarCard = (
        <section
            className="rounded-xl bg-[var(--bg-card)] border border-[var(--border-default)] flex flex-col min-h-0 overflow-hidden"
            style={{ boxShadow: 'var(--shadow-sm)' }}
            data-testid="fw-calendar-card"
            aria-label={t('compliance.fw_calendar_title', 'Regulatory calendar')}
        >
            <div className="flex items-center gap-2 px-3.5 py-3 border-b border-[var(--border-default)]">
                <CalendarClock size={15} className="text-[var(--text-secondary)]" aria-hidden="true" />
                <span className="font-semibold text-xs">{t('compliance.fw_calendar_title', 'Regulatory calendar')}</span>
                <span className="ml-auto text-[11px] text-[var(--text-tertiary)]">{t('compliance.fw_calendar_hint', 'only frameworks that affect you')}</span>
            </div>
            <div className="px-3.5 pt-1.5 pb-2.5 min-h-0 overflow-y-auto text-xs">
                {cal.failed && milestones === null ? (
                    <div className="py-2 text-[11px] text-[var(--text-tertiary)]" data-testid="fw-calendar-failed">
                        {t('compliance.fw_calendar_failed', 'The regulatory calendar could not be read.')}
                    </div>
                ) : milestones === null ? (
                    <div className="py-2 text-[11px] text-[var(--text-tertiary)] animate-pulse" data-testid="fw-calendar-loading">
                        {t('common.loading', 'Loading...')}
                    </div>
                ) : (
                    <RegulatoryCalendar milestones={milestones} now={now} variant="full" testId="fw-calendar" />
                )}
            </div>
        </section>
    );

    if (tab === 'calendar') {
        return (
            <div className="h-full min-h-0 overflow-y-auto p-3.5 @[1100px]/cpage:px-7 @[1100px]/cpage:py-[18px]" data-testid="frameworks-page-calendar">
                {calendarCard}
            </div>
        );
    }

    return (
        <div
            className={`h-full min-h-0 overflow-y-auto p-3.5 @[1100px]/cpage:px-7 @[1100px]/cpage:py-[18px] grid gap-4 text-xs ${isMobile ? 'grid-cols-1' : 'grid-cols-1 @[1100px]/cpage:grid-cols-[1fr_380px]'}`}
            data-testid="frameworks-page"
        >
            <div className="flex flex-col gap-3.5 min-w-0">
                <AiActPhasesCard framework={aia} milestones={milestones} checks={core.checks} now={now} />

                <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] tracking-[.08em] uppercase font-semibold text-[var(--text-tertiary)]">{t('compliance.fw_candidates', 'Candidates')}</span>
                    <span className="text-[11px] text-[var(--text-tertiary)]">{t('compliance.fw_candidates_hint', 'not enabled yet — enabling a framework adds checks, registers and calendar dates')}</span>
                </div>

                {fw.failed && candidates === null ? (
                    <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] px-3.5 py-3 text-xs text-[var(--text-tertiary)]" data-testid="fw-failed">
                        {t('compliance.fw_read_failed', 'The framework list could not be read.')}
                    </div>
                ) : candidates === null ? (
                    <div className={`grid gap-2.5 ${isMobile ? 'grid-cols-1' : 'grid-cols-1 @[860px]/cpage:grid-cols-2'}`} data-testid="fw-loading" aria-busy="true">
                        {[0, 1, 2, 3].map(i => <div key={i} className="h-[132px] rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] animate-pulse" />)}
                    </div>
                ) : (
                    <div className={`grid gap-2.5 ${isMobile ? 'grid-cols-1' : 'grid-cols-1 @[860px]/cpage:grid-cols-2'}`} data-testid="fw-grid">
                        {candidates.map(f => (
                            <FrameworkCandidateCard
                                key={f.id}
                                framework={f}
                                now={now}
                                busy={fw.busyId === f.id}
                                onEnable={enable}
                                onDisable={disable}
                                onRelevance={relevance}
                                onViewPlan={viewPlan}
                            />
                        ))}
                        <OwnFrameworkCard onOpen={openCustom} />
                    </div>
                )}
            </div>
            {calendarCard}
        </div>
    );
}
