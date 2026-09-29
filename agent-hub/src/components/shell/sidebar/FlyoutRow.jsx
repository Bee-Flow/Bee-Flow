import { ChevronRight, Lock } from 'lucide-react';
import React from 'react';
import { ACCENT_BAR, ICON_ACTIVE, ICON_IDLE, ROW_ACTIVE, ROW_IDLE, SECTION_LBL } from './sidebarTokens';
import { formatRelativeTime } from '../../../utils/dateFormatters';

    /* ── Row inside a flyout panel (Studio sections, published apps): plain
       icon + label with a short muted description underneath — the marketing
       mega-menu item, minus the icon tile.

       Studio rows additionally carry (Studio Nav artboard, Sep 2026):
         iconColor — the section's kind colour (shared/kindColors.kindColorVar);
                     inline so the glyph keeps its kind in both states. Absent
                     → the accent/tertiary pair every other row uses.
         count     — the section's item count, right-aligned in tertiary 12px.
                     ABSENT until known: the artboard draws bare text, no
                     skeleton, and a row that promises a number it does not
                     have yet is the same mistake as `hasSub` below.
         locked    — the section's gate failed on a licence/capability
                     (see studioApps.resolveStudioNav): the row stays so the
                     org learns the section exists, but it is an inert
                     button with a lock glyph, `lockHint` as a visible line
                     under the label (and as the tooltip), no navigation and
                     no sub-panel. NOT the `disabled` attribute: a disabled
                     button cannot be focused from the keyboard and Firefox
                     shows no title tooltip on it, so the hint the row exists
                     to deliver would reach nobody; aria-disabled + a no-op
                     click keeps it reachable. ── */
const FlyoutRow = ({
    item,
    recentItemsFor, subFlyout, closeFlyout,
    loadSectionItems, hoverSubFlyout, scheduleSubFlyoutClose,
    onNavigate, t, locale,
}) => {
        const {
            key, label, desc, icon: Icon, iconNode, onClick, active, subKey, subSegment, subLabel,
            iconColor, count, locked, lockHint,
        } = item;
        const recent = subKey && !locked ? recentItemsFor(subKey) : [];
        // A section only advertises a sub-panel once it has something to show.
        // Announcing one that then opens empty is worse than not announcing it,
        // and every section starts empty until its first fetch lands.
        const hasSub = !!subKey && !locked && recent.length > 0;
        const subOpen = hasSub && subFlyout?.key === subKey;
        const hasCount = typeof count === 'number' && Number.isFinite(count);
        const iconClass = iconColor ? '' : (active ? ICON_ACTIVE : ICON_IDLE);
        const row = (
            <button
                key={key}
                onClick={locked ? () => {} : () => { closeFlyout(); onClick?.(); }}
                title={locked ? (lockHint || undefined) : undefined}
                className={`w-full flex items-start gap-2.5 px-2.5 py-2 rounded-lg text-left relative transition-all duration-150 ${active ? ROW_ACTIVE : ROW_IDLE} ${locked ? 'opacity-60 cursor-not-allowed' : ''}`}
                aria-current={active ? 'page' : undefined}
                aria-disabled={locked ? 'true' : undefined}
                aria-expanded={hasSub ? subOpen : undefined}
                aria-haspopup={hasSub ? 'true' : undefined}
                data-testid={`nav-${key}`}
                data-locked={locked ? 'true' : undefined}
            >
                {active && <div className={ACCENT_BAR} />}
                {iconNode || (Icon
                    ? <Icon className={`w-4 h-4 flex-shrink-0 mt-0.5 ${iconClass}`} style={iconColor ? { color: iconColor } : undefined} strokeWidth={active ? 2.25 : 1.75} />
                    : null)}
                <span className="flex-1 min-w-0">
                    <span className={`block text-[13px] leading-tight ${active ? 'font-semibold' : 'font-medium'} text-[var(--text-primary)]`}>{label}</span>
                    {/* No `block` here: line-clamp needs its own -webkit-box
                        display, and a competing display utility silently
                        disables the clamp (seen live: a full app description
                        filling the panel). */}
                    {desc && <span className="line-clamp-2 text-[11.5px] leading-snug mt-0.5 text-[var(--text-tertiary)]">{desc}</span>}
                    {locked && lockHint && (
                        <span className="block text-[11.5px] leading-snug mt-0.5 text-[var(--text-tertiary)]" data-testid={`nav-${key}-lock-hint`}>
                            {lockHint}
                        </span>
                    )}
                </span>
                {locked
                    ? <Lock className="w-3.5 h-3.5 flex-shrink-0 mt-1 text-[var(--text-tertiary)]" strokeWidth={1.75} aria-hidden="true" data-testid={`nav-${key}-lock`} />
                    : (
                        <>
                            {hasCount && (
                                <span className="flex-shrink-0 mt-0.5 text-[12px] leading-tight tabular-nums text-[var(--text-tertiary)]" data-testid={`nav-${key}-count`}>
                                    {count}
                                </span>
                            )}
                            {hasSub && <ChevronRight className="w-3.5 h-3.5 flex-shrink-0 mt-1 text-[var(--text-tertiary)]" strokeWidth={1.75} />}
                        </>
                    )}
            </button>
        );
        if (!subKey || locked) return row;
        return (
            <div
                key={key}
                className="relative"
                // Hovering loads on first sight, so the panel is populated by
                // the time the pointer arrives — and the load is what makes
                // hasSub true, so a section is never fetched more than once
                // before it can show anything.
                onMouseEnter={(e) => {
                    loadSectionItems(subKey);
                    const btn = e.currentTarget.querySelector('button');
                    if (btn) hoverSubFlyout(subKey, btn);
                }}
                onMouseLeave={() => scheduleSubFlyoutClose(subKey)}
            >
                {row}
                {subOpen && subFlyout && (
                    <div
                        className="fixed z-50 w-72 rounded-2xl border overflow-hidden"
                        style={{
                            top: Math.max(8, Math.min(subFlyout.top, (typeof window !== 'undefined' ? window.innerHeight : 800) - 360)),
                            left: subFlyout.left,
                            borderColor: 'var(--border-default)',
                            boxShadow: 'var(--shadow-popover, 0 20px 60px rgba(15,23,42,0.18))',
                            animation: 'sidebarMenuIn .18s cubic-bezier(0.16, 1, 0.3, 1)',
                        }}
                        data-surface="opaque"
                        data-testid={`subflyout-${subKey}`}
                    >
                        <div className="p-1.5 max-h-[70vh] overflow-y-auto custom-scrollbar">
                            <div className={`px-2.5 pt-1.5 pb-1 ${SECTION_LBL}`}>
                                {t('sidebar.recently_edited', 'Recently edited')}
                            </div>
                            {recent.map(entry => (
                                <button
                                    key={entry.id}
                                    onClick={() => { closeFlyout(); onNavigate && onNavigate(`studio/${subSegment}/${entry.id}`); }}
                                    className={`w-full flex items-start gap-2.5 px-2.5 py-2 rounded-lg text-left relative transition-all duration-150 ${ROW_IDLE}`}
                                    data-testid={`nav-recent-${subKey}-${entry.id}`}
                                >
                                    <span className="flex-1 min-w-0">
                                        <span className="block truncate text-[13px] leading-tight font-medium text-[var(--text-primary)]">
                                            {entry.name || t('sidebar.recent_untitled', 'Untitled')}
                                        </span>
                                        {/* What it IS beats when it changed, when you
                                            are picking one of five. The timestamp is
                                            the fallback for the sections that carry no
                                            description (Meeting Notes). No `block`
                                            here — it would kill line-clamp. */}
                                        {(entry.description || entry.updatedAt) && (
                                            <span className="line-clamp-2 text-[11.5px] leading-snug mt-0.5 text-[var(--text-tertiary)]">
                                                {entry.description || formatRelativeTime(entry.updatedAt, { locale })}
                                            </span>
                                        )}
                                    </span>
                                </button>
                            ))}
                            <div className="my-1 mx-2.5 border-t" style={{ borderColor: 'var(--border-subtle)' }} />
                            <button
                                onClick={() => { closeFlyout(); onNavigate && onNavigate(`studio/${subSegment}`); }}
                                className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-all duration-150 ${ROW_IDLE}`}
                                data-testid={`nav-recent-${subKey}-all`}
                            >
                                <span className="text-[13px] font-medium text-[var(--text-secondary)]">
                                    {t('sidebar.recent_show_all', 'All {section}', { section: subLabel || label })}
                                </span>
                            </button>
                        </div>
                    </div>
                )}
            </div>
        );
};

export default FlyoutRow;
