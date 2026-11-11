// The admin dashboard's left rail, in the look of Studio's rail
// (components/admin/Studio/StudioRail): a 240px column on --bg-secondary, a
// brand row with the way back, grouped rows under small eyebrows, and the
// current row lifted as a raised card (--bg-card + shadow) with no accent bar.
// Only the recipe is shared, not the module: StudioRail pulls in Studio's
// registry, search overlay and account footer, none of which belong in the
// admin chunk.
//
// Two blocks that look different: the organisation block (its header names the
// organisation, or "Organisations" with the current choice under it), and, for a
// platform admin, the whole-server block below a divider, on the warning tint the
// whole-server scope bar uses, as one flat list.
//
// Rows are links (NavLink), so a middle-click opens a tab in a new window,
// as the old pill strip did.

import { ArrowLeft, LayoutDashboard } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import React, { useEffect, useId, useRef } from 'react';
import NavLink from '@/components/shell/NavLink';

interface AdminRailGroup {
    id: string;
    /** The eyebrow above the rows; empty for a flat list. */
    label: string;
    tabs: { id: string; label: string; icon: LucideIcon }[];
}

/** A top-level block of the rail (the organisation, or the whole server) holding the sub-groups. */
export interface AdminRailSectionView {
    id: 'org' | 'instance';
    label: string;
    /** A muted line under the header: the organisation the dashboard shows. */
    subtitle?: string;
    icon: LucideIcon;
    groups: readonly AdminRailGroup[];
}

interface AdminRailProps {
    title: string;
    sections: readonly AdminRailSectionView[];
    activeTab: string;
    onSelect: (tabId: string) => void;
    onBack?: React.MouseEventHandler<HTMLButtonElement>;
    backTitle: string;
    /** Inside the phone drawer the rail fills it instead of being a 240px column. */
    inDrawer?: boolean;
    className?: string;
}

function RailRow({ id, label, Icon, active, onSelect }: { id: string; label: string; Icon: LucideIcon; active: boolean; onSelect: (id: string) => void }) {
    return (
        <NavLink
            href={`/admin/${id}`}
            onNavigate={() => onSelect(id)}
            aria-current={active ? 'page' : undefined}
            data-testid={`admin-rail-${id}`}
            className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-all duration-150 [text-decoration:none]! ${active ? 'bg-[var(--bg-card)] shadow-sm' : 'hover:bg-[var(--item-hover-bg)]'}`}
        >
            <Icon className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" strokeWidth={active ? 2.25 : 1.75} aria-hidden="true" />
            <span className={`min-w-0 flex-1 truncate text-[13px] leading-tight text-[var(--text-primary)] ${active ? 'font-semibold' : 'font-medium'}`}>
                {label}
            </span>
        </NavLink>
    );
}

const SERVER_BLOCK = 'mt-1 rounded-xl border border-[color-mix(in_srgb,var(--warning)_30%,transparent)] bg-[color-mix(in_srgb,var(--warning)_6%,transparent)] p-1.5 pt-2.5';

function RailSection({ section, headingId, activeTab, onSelect }: { section: AdminRailSectionView; headingId: string; activeTab: string; onSelect: (id: string) => void }) {
    const server = section.id === 'instance';
    return (
        <>
            {server && <hr className="m-0 border-0 border-t border-[var(--border-default)]" aria-hidden="true" />}
            <section aria-labelledby={headingId} data-testid={`admin-rail-section-${section.id}`} className={`flex flex-col gap-3 ${server ? SERVER_BLOCK : ''}`}>
                <div className="px-2.5">
                    <h3 id={headingId} className={`m-0 flex items-center gap-1.5 text-[13px] font-bold ${server ? 'text-[var(--warning-ink)]' : 'text-[var(--text-primary)]'}`}>
                        <section.icon className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden="true" />
                        <span className="min-w-0 truncate">{section.label}</span>
                    </h3>
                    {section.subtitle && (
                        <p className="m-0 mt-0.5 truncate pl-[22px] text-[12px] text-[var(--text-tertiary)]" data-testid={`admin-rail-section-${section.id}-subtitle`}>
                            {section.subtitle}
                        </p>
                    )}
                </div>
                {section.groups.map(group => (
                    <div key={group.id}>
                        {group.label && (
                            <div className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--text-tertiary)]">
                                {group.label}
                            </div>
                        )}
                        <div className="flex flex-col gap-0.5">
                            {group.tabs.map(tab => (
                                <RailRow key={tab.id} id={tab.id} label={tab.label} Icon={tab.icon} active={tab.id === activeTab} onSelect={onSelect} />
                            ))}
                        </div>
                    </div>
                ))}
            </section>
        </>
    );
}

export default function AdminRail({ title, sections, activeTab, onSelect, onBack, backTitle, inDrawer = false, className = '' }: AdminRailProps) {
    const navRef = useRef<HTMLElement>(null);
    // The desktop rail and the drawer copy can be in the page together.
    const idPrefix = useId();
    // A long rail on a short window: keep the current row in view.
    useEffect(() => {
        const el = navRef.current?.querySelector('[aria-current="page"]');
        el?.scrollIntoView?.({ block: 'nearest' });
    }, [activeTab]);

    return (
        <div
            className={`flex h-full shrink-0 flex-col bg-[var(--bg-secondary)] ${inDrawer ? 'w-full' : 'w-60 border-r border-[var(--border-subtle)]'} ${className}`}
            data-testid={inDrawer ? 'admin-rail-drawer' : 'admin-rail'}
        >
            <div className="flex h-14 shrink-0 items-center gap-2 px-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--text-primary)] text-[var(--bg-secondary)]" aria-hidden="true">
                    <LayoutDashboard className="h-3.5 w-3.5" strokeWidth={2} />
                </span>
                <h2 className="m-0 min-w-0 flex-1 truncate text-[14px] font-semibold text-[var(--text-primary)]">{title}</h2>
                {onBack && (
                    <button
                        type="button"
                        onClick={onBack}
                        title={backTitle}
                        aria-label={backTitle}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[var(--text-tertiary)] transition-colors hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)]"
                    >
                        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                    </button>
                )}
            </div>
            <nav ref={navRef} aria-label={title} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 pb-3">
                {sections.map(section => (
                    <RailSection key={section.id} section={section} headingId={`${idPrefix}-${section.id}`} activeTab={activeTab} onSelect={onSelect} />
                ))}
            </nav>
        </div>
    );
}
