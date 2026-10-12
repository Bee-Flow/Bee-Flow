import { CalendarClock } from 'lucide-react';
import React, { useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import RegulatoryCalendar from '../shared/RegulatoryCalendar';
import { PAGE_FRAME } from './audits/auditForms';
import FrameworkCandidateCard, { OwnFrameworkCard } from './frameworks/FrameworkCandidateCard';

/**
 * FrameworksPage — "frameworks as a growing set + regulatory calendar"
 * (artboard frame 1e, PLAN-FRONTEND C11).
 *
 * Coded against the hub's page props object:
 *   { section, navigate, onNavigate, focusId, isMobile, setHeaderActions,
 *     data: { core, counts, bump, frameworks, calendar } }
 * with `data.frameworks = { frameworks, active, candidates, custom, byId, isEnabled, busyId,
 * enable(id), disable(id), setRelevance(id, v, note), refresh }` and
 * `data.calendar = { milestones | null, failed }`.
 *
 * One view, no tabs: the optional frameworks in two groups — "Enabled" and
 * "Available" (with the own-framework door last) — and the regulatory
 * calendar as the right column. What used to be tabs here moved, and the old
 * links follow (sections.js legacyTabs): `?tab=calendar` → Overview ›
 * Calendar, `?tab=per_automation` → AI Act › Systems. The AI Act phasing is
 * the AI Act's own Timeline tab, so it is not repeated here.
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

/** Pure: the non-core frameworks split into the two groups the page shows. `null` while unread. */
export function frameworkGroups(frameworks) {
    const list = candidateList(frameworks);
    if (!list) return null;
    return { enabled: list.filter(f => f.enabled === true), available: list.filter(f => f.enabled !== true) };
}

const GRID = 'grid gap-2.5 grid-cols-1 @[860px]/cpage:grid-cols-2';

function GroupHeading({ id, label, hint }) {
    return (
        <div className="flex items-center gap-2 flex-wrap">
            <h2 id={id} className="m-0 text-[10px] tracking-[.08em] uppercase font-semibold text-[var(--text-tertiary)]">{label}</h2>
            {hint ? <span className="text-[11px] text-[var(--text-tertiary)]">{hint}</span> : null}
        </div>
    );
}

export default function FrameworksPage(props) {
    const { navigate, onNavigate, isMobile = false, setHeaderActions, data = {}, now } = props;
    const { t } = useTranslation();
    const fw = data.frameworks || {};
    const cal = data.calendar || {};
    const core = data.core || {};
    const list = fw.frameworks ?? null;
    const groups = useMemo(() => frameworkGroups(list), [list]);
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

    const card = (f) => (
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
    );

    const calendarCard = (
        <section
            className="rounded-xl bg-[var(--bg-card)] border border-[var(--border-default)] flex flex-col min-h-0 overflow-hidden shadow-[var(--shadow-sm)]"
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

    let body;
    if (fw.failed && groups === null) {
        body = (
            <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] px-3.5 py-3 text-xs text-[var(--text-tertiary)]" data-testid="fw-failed">
                {t('compliance.fw_read_failed', 'The framework list could not be read.')}
            </div>
        );
    } else if (groups === null) {
        body = (
            <div className={GRID} data-testid="fw-loading" aria-busy="true">
                {[0, 1, 2, 3].map(i => <div key={i} className="h-[132px] rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] animate-pulse" />)}
            </div>
        );
    } else {
        body = (
            <>
                {groups.enabled.length > 0 && (
                    <section className="flex flex-col gap-2.5" aria-labelledby="fw-group-enabled" data-testid="fw-group-enabled">
                        <GroupHeading id="fw-group-enabled" label={t('compliance.fw_group_enabled', 'Enabled')} />
                        <div className={GRID} data-testid="fw-grid-enabled">{groups.enabled.map(card)}</div>
                    </section>
                )}
                <section className="flex flex-col gap-2.5" aria-labelledby="fw-group-available" data-testid="fw-group-available">
                    <GroupHeading
                        id="fw-group-available"
                        label={t('compliance.fw_group_available', 'Available')}
                        hint={t('compliance.fw_candidates_hint', 'not enabled yet — enabling a framework adds checks, registers and calendar dates')}
                    />
                    <div className={GRID} data-testid="fw-grid">
                        {groups.available.map(card)}
                        <OwnFrameworkCard onOpen={openCustom} />
                    </div>
                </section>
            </>
        );
    }

    return (
        <div className={`h-full min-h-0 overflow-y-auto ${PAGE_FRAME}`} data-testid="frameworks-page">
            <div className={`grid gap-4 ${isMobile ? 'grid-cols-1' : 'grid-cols-1 @[1100px]/cpage:grid-cols-[1fr_380px]'}`}>
                <div className="flex flex-col gap-3.5 min-w-0">{body}</div>
                {calendarCard}
            </div>
        </div>
    );
}
