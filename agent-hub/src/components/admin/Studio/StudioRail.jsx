import { ArrowLeft, Lock, Search, ShieldCheck } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { groupStudioApps, studioLockHint } from './studioApps';
import { studioSectionLabel } from './studioNav';
import { STUDIO_START } from './studioStart';
import { countFor } from '../../../hooks/useStudioCounts';
import { useTranslation } from '../../../hooks/useTranslation';
import { kindColorVar } from '../../shared/kindColors';
import SidebarFooter from '../../shell/sidebar/SidebarFooter';
import StudioSearchOverlay from '../../shell/StudioSearchOverlay';

/**
 * StudioRail — the 240px rail that REPLACES the workspace sidebar on
 * /app/studio* (Bee Flow Builder redesign, Track H1).
 *
 * Rendered by Sidebar.jsx, not by AuthedApp: AuthedApp does not mount the
 * sidebar at all (AgentHub does), so the swap lives at the one place that
 * already knows both the current page and whether it is below the mobile
 * breakpoint. Sidebar hands over the sections it has already resolved — the
 * same resolveStudioNav output the Studio flyout renders from — so the rail
 * and the flyout cannot answer the gate question differently.
 *
 * Two deliberate differences from the sidebar's rows:
 *
 *   ACTIVE IS A RAISED CARD (--bg-card + --shadow-sm) and carries NO accent
 *   bar. Every other nav surface in the app draws that 3px bar (NavRow.jsx's
 *   inline div, FlyoutRow.jsx's ACCENT_BAR token). Inside the rail the bar
 *   would sit against the rail's own right border on a 240px column with
 *   nothing else competing for the eye, so the artboard lifts the row instead.
 *   It is a deviation, it is only here, and it is written down.
 *
 *   LOCKED ROWS keep FlyoutRow's contract verbatim, because it is the part
 *   that is easy to get wrong: aria-disabled rather than `disabled` (a
 *   disabled button takes no focus and shows no title tooltip in Firefox, so
 *   the hint the row exists to deliver would reach nobody), a visible hint
 *   line under the label, and no navigation.
 *
 * COUNTS ARE ABSENT UNTIL KNOWN. `countFor` returns undefined for a key the
 * server left out — a kind this caller may not see — and for every key before
 * the first poll answers. A row that shows 0 because it does not know yet is
 * a claim it cannot support.
 */

/** The 24px ink tile: a flat-top hexagon in the primary ink. */
function StudioMark() {
    return (
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" className="flex-shrink-0">
            <polygon points="12,2 21,7 21,17 12,22 3,17 3,7" fill="var(--text-primary)" />
            <polygon points="12,7 16.5,9.5 16.5,14.5 12,17 7.5,14.5 7.5,9.5" fill="var(--bg-secondary)" />
        </svg>
    );
}

/**
 * The right-hand end of a row: a lock, a count, or nothing.
 *
 * "Nothing" is the important branch. `countFor` answers undefined both before
 * the first poll lands and for every key the server omitted, and a row that
 * fills that silence with a 0 is making a claim it cannot support.
 */
function RailRowMeta({ locked, count, testId }) {
    if (locked) {
        return <Lock className="w-3.5 h-3.5 flex-shrink-0 mt-1 text-[var(--text-tertiary)]" strokeWidth={1.75} aria-hidden="true" data-testid={`${testId}-lock`} />;
    }
    if (typeof count !== 'number' || !Number.isFinite(count)) return null;
    return (
        <span className="flex-shrink-0 mt-0.5 text-[12px] leading-tight tabular-nums text-[var(--text-tertiary)]" data-testid={`${testId}-count`}>
            {count}
        </span>
    );
}

/** One rail row. Same behaviour contract as FlyoutRow, different active skin. */
function RailRow({ label, Icon, iconColor, count, locked, lockHint, active, onClick, testId, tourId }) {
    return (
        <button
            type="button"
            onClick={locked ? () => {} : onClick}
            title={locked ? (lockHint || undefined) : undefined}
            aria-current={active ? 'page' : undefined}
            aria-disabled={locked ? 'true' : undefined}
            data-testid={testId}
            data-tour={tourId}
            data-locked={locked ? 'true' : undefined}
            className={`w-full flex items-start gap-2.5 px-2.5 py-2 rounded-lg text-left transition-all duration-150 ${
                active ? 'bg-[var(--bg-card)] shadow-sm' : 'hover:bg-[var(--item-hover-bg)]'
            } ${locked ? 'opacity-60 cursor-not-allowed' : ''}`}
        >
            {Icon && (
                <Icon
                    className="w-4 h-4 flex-shrink-0 mt-0.5"
                    style={iconColor ? { color: iconColor } : undefined}
                    strokeWidth={active ? 2.25 : 1.75}
                />
            )}
            <span className="flex-1 min-w-0">
                <span className={`block text-[13px] leading-tight ${active ? 'font-semibold' : 'font-medium'} text-[var(--text-primary)]`}>
                    {label}
                </span>
                {locked && lockHint && (
                    <span className="block text-[11.5px] leading-snug mt-0.5 text-[var(--text-tertiary)]" data-testid={`${testId}-lock-hint`}>
                        {lockHint}
                    </span>
                )}
            </span>
            <RailRowMeta locked={locked} count={count} testId={testId} />
        </button>
    );
}

export default function StudioRail({
    sections = [],
    studioCounts = null,
    activeSection = null,
    onNavigate,
    // The account footer is the sidebar's, unchanged — its menu state and the
    // outside-click ref stay on Sidebar's fiber and arrive here as props.
    user, onLogout, currentPage, showSettings, isMobile = false, simpleMode = false,
    profileRef, showProfileMenu, setShowProfileMenu,
    // Approvals is not a Studio SECTION (it is `hiddenFromNav`, and deciding is
    // a member act) — so it never arrives in `sections`. It travels as its own
    // pair of props from the same sidebar state the top-level row reads.
    canBrowseApprovals = false, pendingApprovalCount = 0,
}) {
    const { t, locale } = useTranslation();
    const [searchOpen, setSearchOpen] = useState(false);

    /* ⌘K — bound in the CAPTURE phase, and it stops the event there.
       Two other window listeners already claim this chord: the hub's global
       conversation search (AgentHub/useAgentHubData.js) and the embedded
       builder's quick switcher (automation/index.jsx), both on the bubble
       phase — so on /app/studio/automations one keystroke used to open two
       things at once. A capture listener on window is the first node in the
       path, so stopping propagation there means that while the rail is
       mounted ⌘K opens exactly ONE thing.

       WHICH one is the part that took a second pass. Taking the chord
       unconditionally made the builder's quick switcher unreachable on
       /app/studio/automations, and Studio's search does not list what is
       inside an open automation — so the chord stopped answering the question
       of the person standing there. A surface that owns the chord for its
       own content says so with `data-quick-open-owner`; while one is on
       screen the rail keeps its hands off entirely (no preventDefault, no
       stopPropagation) and the owner's own bubble-phase listener runs. The
       rail's search is not lost: it is a visible row on the rail itself. */
    useEffect(() => {
        const onKey = (e) => {
            if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
            if (String(e.key || '').toLowerCase() !== 'k') return;
            // Checked per keystroke, not once on mount: the builder mounts and
            // unmounts underneath a rail that never re-renders for it.
            if (typeof document !== 'undefined' && document.querySelector('[data-quick-open-owner]')) return;
            e.preventDefault();
            e.stopPropagation();
            if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
            setSearchOpen((open) => !open);
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, []);

    return (
        <div
            className="h-full w-60 flex flex-col flex-shrink-0 bg-[var(--bg-secondary)] border-r border-[var(--border-subtle)]"
            data-testid="studio-rail"
            data-surface="subtle"
            data-static
        >
            {/* ── Brand row ── */}
            <div className="flex items-center gap-2 px-3 h-14 flex-shrink-0">
                <StudioMark />
                <span
                    className="flex-1 min-w-0 truncate text-[14px] font-semibold text-[var(--text-primary)]"
                    // The tour's 'nav-studio' anchor lives on the sidebar's
                    // Studio row — which is not rendered here. Carrying it on
                    // the rail's brand row keeps the lesson pointing at
                    // something real on /app/studio instead of silently
                    // falling back to a centred card.
                    data-tour="nav-studio"
                >
                    {t('studio.sidebar_link', 'Studio')}
                </span>
                <button
                    type="button"
                    onClick={() => onNavigate?.('agents')}
                    className="flex items-center gap-1 px-1.5 py-1 rounded-lg text-[12px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)] transition-colors"
                    data-testid="studio-rail-back-to-chat"
                >
                    <ArrowLeft className="w-3.5 h-3.5" strokeWidth={1.75} />
                    {t('studio.rail.back_to_chat', 'Chat')}
                </button>
            </div>

            {/* ── Search pill ── */}
            <div className="px-2 pb-2 flex-shrink-0">
                <button
                    type="button"
                    onClick={() => setSearchOpen(true)}
                    className="w-full flex items-center gap-2 px-2.5 h-9 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] text-left hover:border-[var(--border-default)] transition-colors"
                    data-testid="studio-rail-search"
                >
                    <Search className="w-3.5 h-3.5 flex-shrink-0 text-[var(--text-tertiary)]" strokeWidth={1.75} />
                    <span className="flex-1 min-w-0 truncate text-[12.5px] text-[var(--text-tertiary)]">
                        {t('studio.rail.search', 'Search…')}
                    </span>
                    <kbd className="flex-shrink-0 text-[11px] text-[var(--text-tertiary)] font-sans">⌘K</kbd>
                </button>
            </div>

            {/* ── Sections ──
                A row is its NAME and nothing else. No descriptions here,
                unlike the sidebar's flyout: that panel is a 288px menu you
                visit, this is a 240px column you live in, and ten two-line
                rows would push the last group below the fold on a laptop. A
                locked row's hint is the one exception — a lock nobody can
                read is just a closed door.

                The name itself comes from studioNav.studioSectionLabel, the
                one place that knows a runtime module carries a locale-aware
                label() where a built-in carries an i18n key. This file used
                to answer that question itself, which is how the rail and the
                flyout could end up calling one section two things. */}
            <nav aria-label="Studio navigation" data-testid="studio-rail-nav" className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-2 pb-2 flex flex-col gap-0.5">
                <RailRow
                    label={t(STUDIO_START.labelKey, STUDIO_START.labelFallback)}
                    Icon={STUDIO_START.Icon}
                    iconColor="var(--text-secondary)"
                    active={activeSection === STUDIO_START.id}
                    onClick={() => onNavigate?.(`studio/${STUDIO_START.urlSegment}`)}
                    testId={`rail-${STUDIO_START.id}`}
                />
                {groupStudioApps(sections).map(({ category, apps }) => (
                    <div key={category.id} className="mt-3">
                        <div className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--text-tertiary)]">
                            {t(category.labelKey, category.labelFallback)}
                        </div>
                        <div className="flex flex-col gap-0.5">
                            {apps.map((app) => (
                                <RailRow
                                    key={app.id}
                                    label={studioSectionLabel(app, t, locale)}
                                    Icon={app.Icon}
                                    // A runtime module has no kind and gets the neutral ink.
                                    iconColor={app.kind ? kindColorVar(app.kind) : 'var(--text-secondary)'}
                                    // A runtime module never falls back to its id: one whose
                                    // id happens to equal a first-party key would wear that
                                    // number.
                                    count={app.runtime ? countFor(studioCounts, app.countKey) : countFor(studioCounts, app.countKey || app.id)}
                                    locked={!!app.locked}
                                    lockHint={app.locked ? studioLockHint(app.locked, t) : undefined}
                                    active={activeSection === app.id}
                                    onClick={() => onNavigate?.(`studio/${app.urlSegment}`)}
                                    testId={`rail-${app.id}`}
                                />
                            ))}
                        </div>
                    </div>
                ))}

                {/* ── Approvals ──
                    Its own block, under the groups and above the footer,
                    because it is not one of them: every row above builds
                    something, this one decides something, and deciding is a
                    member act rather than a builder one.

                    It has to be HERE at all because the rail REPLACES the
                    sidebar on /app/studio*, and the sidebar's top-level
                    Approvals row is the only entrance there is — the Studio
                    panel stopped listing it. Without this block a builder who
                    walked into Studio lost both the way in and the pending
                    badge until they left again, which is exactly the wrong
                    moment to hide a queue somebody is waiting on.

                    Shown whenever the org can browse approvals, not only while
                    something is pending: the decided ones are a record people
                    go looking for. The BADGE is the opposite — it appears only
                    when something is actually waiting, so an empty queue says
                    nothing rather than "0". */}
                {canBrowseApprovals && (
                    <div className="mt-3 pt-3 border-t border-[var(--border-subtle)]">
                        <RailRow
                            label={t('sidebar.approvals', 'Approvals')}
                            Icon={ShieldCheck}
                            iconColor="var(--text-secondary)"
                            count={pendingApprovalCount > 0 ? pendingApprovalCount : undefined}
                            active={activeSection === 'approvals'}
                            onClick={() => onNavigate?.('studio/approvals')}
                            testId="rail-approvals"
                        />
                    </div>
                )}
            </nav>

            <SidebarFooter
                isOpen
                isMobile={isMobile}
                user={user}
                t={t}
                profileRef={profileRef}
                showProfileMenu={showProfileMenu}
                setShowProfileMenu={setShowProfileMenu}
                _simpleMode={simpleMode}
                currentPage={currentPage}
                showSettings={showSettings}
                onNavigate={onNavigate}
                onLogout={onLogout}
            />

            <StudioSearchOverlay
                isOpen={searchOpen}
                onClose={() => setSearchOpen(false)}
                onNavigate={onNavigate}
            />
        </div>
    );
}
