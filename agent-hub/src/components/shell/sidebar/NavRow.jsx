import React from 'react';
import { ROW, ROW_ACTIVE, ROW_IDLE, SECTION_LBL } from './sidebarTokens';

    /* ── Nav row: plain icon + label. Rows with a `flyout` open a floating
       panel beside the sidebar (the marketing header's mega-menu, turned
       sideways) on hover or click instead of navigating; on phones the same
       row falls back to its onClick. Collapsed sidebar keeps the icon-only
       power bar. ──

       data-testid comes from `key`, never from `label` (NAV-20). It used to be
       slugified from the TRANSLATED label, which made the selector a function
       of the install's UI language: the moment
       server/migrations/add-nl-approvals-translations.js sets sidebar.approvals
       to 'Goedkeuringen', nav-approvals is nav-goedkeuringen in the DOM and
       every test looking for it fails on a Dutch install — not eventually, but
       today. In English the two forms are byte-identical for all nine rows
       (new-chat/'New Chat', cowork/'Cowork', approvals/'Approvals',
       search/'Search', agents/'Agents', studio/'Studio', apps/'Apps',
       forms/'Forms', notebooks/'Notebooks'), so no existing selector moves —
       the key form is simply the one that survives translation. It also matches
       data-tour and FlyoutRow, which were already key-based. ── */
const NavRow = ({
    item, isOpen, isMobile,
    flyout, openFlyout, hoverFlyout, closeFlyout, scheduleFlyoutClose,
    renderFlyoutRow,
}) => {
        const { key, label, icon: Icon, onClick, active, primary, kbd, badge, flyout: flyoutDef } = item;
        if (!isOpen) {
            return (
                <button
                    key={key}
                    onClick={onClick}
                    className={`group relative flex items-center w-10 h-10 rounded-xl justify-center transition-all ${active ? 'bg-[var(--accent-primary)] text-[var(--accent-primary-fg,#fff)] shadow-lg' : primary ? 'bg-[var(--accent-primary)]/10 text-[var(--accent-primary)] hover:bg-[var(--accent-primary)] hover:text-[var(--accent-primary-fg,#fff)]' : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'}`}
                    title={label}
                    aria-label={label}
                    aria-current={active ? 'page' : undefined}
                    data-testid={`nav-${key}`}
                    data-tour={`nav-${key}`}
                >
                    <Icon className="w-5 h-5" strokeWidth={active || primary ? 2.25 : 1.75} />
                </button>
            );
        }
        const hasFlyout = !!flyoutDef && !isMobile;
        const flyoutOpen = hasFlyout && flyout?.key === key;
        const row = (
            <button
                key={key}
                onClick={hasFlyout
                    ? (e) => (flyoutOpen ? closeFlyout() : openFlyout(key, e.currentTarget))
                    : onClick}
                className={`group relative flex items-center ${ROW} ${active ? ROW_ACTIVE : ROW_IDLE}`}
                aria-label={label}
                aria-current={active ? 'page' : undefined}
                aria-expanded={hasFlyout ? flyoutOpen : undefined}
                aria-haspopup={hasFlyout ? 'true' : undefined}
                data-testid={`nav-${key}`}
                data-tour={`nav-${key}`}
            >
                {active && <div className="absolute left-0 top-2.5 bottom-2.5 w-[3px] rounded-r-full bg-[var(--accent-primary)]" />}
                <Icon className={`w-4 h-4 ${active ? 'text-[var(--accent-primary)]' : 'text-[var(--text-tertiary)]'}`} strokeWidth={active || primary ? 2.25 : 1.75} />
                <span className={`text-[13px] ${active ? 'font-semibold' : ''}`} style={{ color: active ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{label}</span>
                {kbd && <kbd className="ml-auto inline-flex items-center px-1.5 py-0.5 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-[10px] font-medium text-[var(--text-tertiary)] group-hover:text-[var(--text-secondary)] transition-colors">{kbd}</kbd>}
                {typeof badge === 'number' && badge > 0 && (
                    <span
                        className="ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded-md tabular-nums"
                        style={{
                            background: 'color-mix(in srgb, var(--accent-primary) 12%, transparent)',
                            color: 'var(--accent-primary)',
                        }}
                    >
                        {badge}
                    </span>
                )}
            </button>
        );
        if (!hasFlyout) return row;
        return (
            <div
                key={key}
                className="relative"
                onMouseEnter={(e) => {
                    const btn = e.currentTarget.querySelector('button');
                    if (btn) hoverFlyout(key, btn);
                }}
                onMouseLeave={() => scheduleFlyoutClose(key)}
            >
                {row}
                {flyoutOpen && flyout && (
                    <div
                        className="fixed z-50 w-72 rounded-2xl border overflow-hidden"
                        style={{
                            top: Math.max(8, Math.min(flyout.top, (typeof window !== 'undefined' ? window.innerHeight : 800) - 360)),
                            left: flyout.left,
                            borderColor: 'var(--border-default)',
                            boxShadow: 'var(--shadow-popover, 0 20px 60px rgba(15,23,42,0.18))',
                            animation: 'sidebarMenuIn .18s cubic-bezier(0.16, 1, 0.3, 1)',
                        }}
                        data-surface="opaque"
                        data-testid={`flyout-${key}`}
                    >
                        <div className="p-1.5 max-h-[70vh] overflow-y-auto custom-scrollbar">
                            {/* A grouped panel (Studio) renders a heading per
                                category; the flat ones (Apps, Forms) are
                                unchanged — one list, no headings. */}
                            {flyoutDef.groups
                                ? flyoutDef.groups.map((group, i) => (
                                    <div key={group.key} className={i > 0 ? 'mt-1' : undefined} data-testid={`flyout-group-${group.key}`}>
                                        <div className={`px-2.5 pt-1.5 pb-1 ${SECTION_LBL}`}>{group.label}</div>
                                        {group.children.map(renderFlyoutRow)}
                                    </div>
                                ))
                                : flyoutDef.children.map(renderFlyoutRow)}
                        </div>
                    </div>
                )}
            </div>
        );
};

export default NavRow;
