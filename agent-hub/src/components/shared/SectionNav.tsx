// The section list in the sidebar of a StudioShell: one row per section of an
// admin area (AI configuration, Security, Integrations, ...). A row is a
// button, the current one carries aria-current="page", and the caller owns
// the URL: `onSelect` gets the id and navigates.
//
// Wide (md and up) it is a vertical list with optional group eyebrows. Below
// md it turns into one horizontally scrolling row, so it fits the top strip
// that a `StudioShell responsive` gives the sidebar on a phone.

import type { ComponentType, ReactNode } from 'react';

interface SectionNavItem {
    id: string;
    label: ReactNode;
    /** A lucide icon or any component that takes a className. */
    icon?: ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
    /** Tooltip, when the label alone does not say enough. */
    title?: string;
    /** Eyebrow above the first row of a run of rows with the same group. */
    group?: string;
    /** The group's eyebrow also gets a divider line above it. */
    groupDivider?: boolean;
    /** A small mark after the label (an icon with its own accessible name). */
    mark?: ReactNode;
    testId?: string;
}

interface SectionNavProps {
    items: readonly SectionNavItem[];
    activeId: string;
    onSelect: (id: string) => void;
    /** Accessible name of the <nav>. */
    label: string;
    className?: string;
}

const ROW = 'flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-md px-3 py-2 text-left text-sm md:w-full md:shrink';
const ROW_ACTIVE = 'bg-[var(--bg-tertiary)] font-medium text-[var(--text-primary)]';
const ROW_IDLE = 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]';
const EYEBROW = 'hidden px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--text-tertiary)] md:block';
const DIVIDER = 'mt-2 border-t border-[var(--border-subtle)]';

export default function SectionNav({ items, activeId, onSelect, label, className = '' }: SectionNavProps) {
    return (
        <nav
            aria-label={label}
            className={`flex flex-row gap-0.5 overflow-x-auto p-2 md:flex-col md:overflow-x-visible ${className}`}
        >
            {items.map((item, i) => {
                const Icon = item.icon;
                const active = item.id === activeId;
                const startsGroup = item.group && item.group !== items[i - 1]?.group;
                return (
                    <div key={item.id} className="contents">
                        {startsGroup ? <div className={`${EYEBROW} ${item.groupDivider ? DIVIDER : ''}`}>{item.group}</div> : null}
                        <button
                            type="button"
                            onClick={() => onSelect(item.id)}
                            aria-current={active ? 'page' : undefined}
                            title={item.title}
                            data-testid={item.testId}
                            className={`${ROW} ${active ? ROW_ACTIVE : ROW_IDLE}`}
                        >
                            {Icon ? <Icon className="h-4 w-4 shrink-0" aria-hidden="true" /> : null}
                            <span className="truncate">{item.label}</span>
                            {item.mark}
                        </button>
                    </div>
                );
            })}
        </nav>
    );
}
