import React from 'react';

/**
 * StudioShell — two-pane layout (left sidebar + main content) used by the
 * three Studio panels: Automations, Skills, Knowledge Bases. Replaces the
 * duplicated chrome in:
 *   - components/admin/Studio/AutomationsStudio/
 *   - components/admin/Studio/SkillsStudio/index.jsx
 *   - components/admin/Studio/KBsStudio/index.jsx
 *
 * Slot-based on purpose: list-item rendering, empty states, and detail
 * views diverge per Studio, so we only standardize the chrome (widths,
 * borders, sidebar header bar) rather than forcing a single list shape.
 */

export interface StudioShellProps {
    /** Header text shown at the top of the sidebar. */
    sidebarTitle?: React.ReactNode;
    /** Action element rendered to the right of the title (typically a + button). */
    sidebarActions?: React.ReactNode;
    /** Body of the sidebar (search input + scrollable list). */
    sidebar: React.ReactNode;
    /** Main content slot — renders the selected item's detail or an EmptyState. */
    children: React.ReactNode;
    /** Sidebar width in Tailwind sizing units; default 'w-64' (256px). Ignored when `responsive`. */
    sidebarWidthClass?: string;
    /**
     * Below md the sidebar becomes a strip across the top (no title bar, its
     * content scrolls sideways: SectionNav lays itself out for that) and the
     * main pane takes the full width. From md up it is the usual 256px column.
     */
    responsive?: boolean;
    className?: string;
}

export default function StudioShell({
    sidebarTitle,
    sidebarActions,
    sidebar,
    children,
    sidebarWidthClass = 'w-64',
    responsive = false,
    className = '',
}: StudioShellProps) {
    const asideClass = responsive
        ? 'w-full md:w-64 flex-shrink-0 border-b md:border-b-0 md:border-r border-[var(--border-default)] flex flex-col'
        : `${sidebarWidthClass} flex-shrink-0 border-r border-[var(--border-default)] flex flex-col`;
    return (
        <div className={`flex h-full bg-[var(--bg-primary)] ${responsive ? 'flex-col md:flex-row' : ''} ${className}`}>
            <aside className={asideClass}>
                {(sidebarTitle != null || sidebarActions != null) && (
                    <header className={`px-4 py-3 border-b border-[var(--border-default)] items-center justify-between ${responsive ? 'hidden md:flex' : 'flex'}`}>
                        <span className="text-sm font-semibold text-[var(--text-primary)] truncate">
                            {sidebarTitle}
                        </span>
                        {sidebarActions != null && (
                            <div className="flex-shrink-0">{sidebarActions}</div>
                        )}
                    </header>
                )}
                <div className={responsive ? 'md:flex-1 md:overflow-y-auto' : 'flex-1 overflow-y-auto'}>{sidebar}</div>
            </aside>
            <main className={`flex-1 overflow-y-auto ${responsive ? 'min-h-0' : ''}`}>{children}</main>
        </div>
    );
}
