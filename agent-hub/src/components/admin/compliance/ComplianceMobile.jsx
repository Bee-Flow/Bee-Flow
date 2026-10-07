/**
 * ComplianceMobile — the Compliance Center on a phone (artboard 1h, 390×844).
 *
 * The hub (index.jsx) mounts this chunk through `ComplianceMobileGate` and
 * hands it the SAME data object every page receives, plus the page node it
 * already built for the active section. Nothing is fetched here: the frame
 * is chrome around the hub's state.
 *
 *   ┌ top bar ─ 44px back · 28px kind tile · "Compliance" + "run 09:12 · 7 open" · 44px Play       ┐
 *   │ at HOME (active === 'overview'):                                                             │
 *   │   SegmentedControl  Overview | Frameworks | Registers   ← a VIEW state, not a route          │
 *   │   overview  → MobileHomeOverview (framework rows · needs attention · deadlines)               │
 *   │   frameworks→ MobileRailList groups=['frameworks']                                          │
 *   │   registers → MobileRailList groups=['registers','admin']                                    │
 *   │ in a SECTION:                                                                                │
 *   │   ComplianceHeader layout="phone": title bar + tab menu, then a wrapping action row          │
 *   │   + the `page` node (pages render DataTable's renderCard list on mobile)                     │
 *   └──────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * Back: at home → `onBack` (the settings host closes the detail view); inside
 * a section → home. Every row is ≥ 44px (MOBILE_ROW_CLASS). The subtitle
 * prints only the parts the counts endpoint stated — no "0 open" invented.
 */
import { ChevronLeft, Play, Scale } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import ComplianceHeader from './ComplianceHeader';
import { countFor } from './data/useComplianceCounts';
import MobileHomeOverview from './mobile/MobileHomeOverview';
import MobileRailList from './mobile/MobileRailList';
import { formatClock } from './railMeta';
import { sectionById } from './sections';
import { formatDay } from './shared/formatDates';
import { useTranslation } from '../../../hooks/useTranslation';
import SegmentedControl from '../../shared/SegmentedControl';

export const MOBILE_VIEWS = Object.freeze(['overview', 'frameworks', 'registers']);

const ICON_BUTTON = 'w-11 h-11 grid place-items-center rounded-lg flex-shrink-0 disabled:opacity-40';

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/**
 * 'run 09:12 · 7 open' for a run today, 'run 5 Oct 09:12 · 7 open' for one on
 * another day — each half only when the counts stated it; null when neither did.
 */
export function mobileSubtitle(counts, t, { locale, now = Date.now() } = {}) {
    const parts = [];
    const at = countFor(counts, 'last_run.at');
    const hhmm = formatClock(at, locale);
    if (hhmm) {
        parts.push(sameDay(new Date(at), new Date(now))
            ? t('compliance.rail_meta_run', 'run {time}', { time: hhmm })
            : t('compliance.mob_run_at', 'run {date} {time}', { date: formatDay(at, locale || 'en', now), time: hhmm }));
    }
    const open = countFor(counts, 'attention_open');
    if (typeof open === 'number') parts.push(t('compliance.rail_meta_open', '{n} open', { n: open }));
    return parts.length ? parts.join(' · ') : null;
}

// Props (from ComplianceMobileGate): { active, navigate, onBack, data, tab, onTab,
// exportsEnabled, dl, page, section, headerCtx }. `exportsEnabled`/`dl` are the
// page's concern (the hub already applied them to `page`) — accepted, unused.
export default function ComplianceMobile({
    active = 'overview', navigate, onBack = null, data, tab, onTab, page = null, section = null, headerCtx = {},
}) {
    const { t, resolvedLocale } = useTranslation();
    const atHome = active === 'overview';
    const sec = section || sectionById(active);
    const [view, setView] = useState('overview');
    // Coming back home from a section lands on the overview segment again.
    useEffect(() => { if (!atHome) setView('overview'); }, [atHome]);

    const counts = data?.counts || null;
    const core = data?.core || {};
    const subtitle = mobileSubtitle(counts, t, { locale: resolvedLocale });
    const canRun = typeof core.runNow === 'function';

    const goBack = () => { if (atHome) onBack?.(); else navigate?.('overview'); };

    const segments = [
        { value: 'overview', label: t('compliance.mob_seg_overview', 'Overview') },
        { value: 'frameworks', label: t('compliance.mob_seg_frameworks', 'Frameworks') },
        { value: 'registers', label: t('compliance.mob_seg_registers', 'Registers') },
    ];

    return (
        <div data-testid="compliance-mobile" data-view={atHome ? view : 'section'} className="flex flex-col h-full min-h-0" style={{ background: 'var(--bg-primary)' }}>
            {/* ── Top bar ── */}
            <div className="flex items-center gap-2.5 px-4 py-1.5 flex-shrink-0" style={{ background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-default)' }}>
                <button type="button" data-testid="mobile-back" onClick={goBack} className={`${ICON_BUTTON} -ml-2.5`} style={{ color: 'var(--text-secondary)' }}
                    aria-label={atHome ? t('compliance.back_to_settings', 'Back to settings') : t('compliance.mob_back_home', 'Back to overview')}>
                    <ChevronLeft size={20} aria-hidden="true" />
                </button>
                <div className="w-7 h-7 rounded-lg grid place-items-center flex-shrink-0"
                    style={{ background: 'color-mix(in srgb, var(--kind-compliance) 18%, transparent)', color: 'var(--kind-compliance)' }}>
                    <Scale size={15} aria-hidden="true" />
                </div>
                <div className="flex-1 min-w-0">
                    <div className="text-[15px] font-semibold leading-[18px] truncate" style={{ color: 'var(--text-primary)' }}>
                        {t('settings.compliance', 'Compliance')}
                    </div>
                    {subtitle && (
                        <div data-testid="mobile-subtitle" className="text-[11px] truncate" style={{ color: 'var(--text-tertiary)' }}>{subtitle}</div>
                    )}
                </div>
                <button type="button" data-testid="mobile-run-now" onClick={() => core.runNow?.()} disabled={!canRun || !!core.running}
                    className={`${ICON_BUTTON} -mr-2.5`} style={{ color: 'var(--text-secondary)' }}
                    aria-label={core.running ? t('compliance.running', 'Running...') : t('compliance.run_now', 'Run checks now')}>
                    <Play size={18} aria-hidden="true" className={core.running ? 'animate-pulse' : ''} />
                </button>
            </div>

            {atHome ? (
                <>
                    <div className="px-4 pt-3 flex-shrink-0">
                        <SegmentedControl fullWidth size="sm" value={view} onChange={setView} options={segments}
                            ariaLabel={t('compliance.mob_views_aria', 'Compliance views')} />
                    </div>
                    <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3.5">
                        {view === 'overview' && <MobileHomeOverview data={data} navigate={navigate} />}
                        {view === 'frameworks' && (
                            <MobileRailList groups={['frameworks']} counts={counts} frameworks={data?.frameworks} active={active} onSelect={(id) => navigate?.(id)} />
                        )}
                        {view === 'registers' && (
                            <MobileRailList groups={['registers', 'admin']} counts={counts} frameworks={data?.frameworks} active={active} onSelect={(id) => navigate?.(id)} showHeads />
                        )}
                    </div>
                </>
            ) : (
                <div className="@container/cmobile flex-1 min-h-0 flex flex-col" data-testid="mobile-section">
                    <ComplianceHeader section={sec} tab={tab} onTab={onTab} ctx={headerCtx} layout="phone" />
                    <div className="@container/cpage flex-1 min-h-0 overflow-y-auto">{page}</div>
                </div>
            )}
        </div>
    );
}
