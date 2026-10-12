// The one header every project content tab opens with: the Studio section
// header (kind tile, title, count, the ONE primary action, extras) and, below
// it, the search box. Below desktop width the actions move to a second row
// so the primary action stays reachable.

import { Search } from 'lucide-react';
import React from 'react';
import { useViewport } from '../../../hooks/useViewport';
import { StudioSectionHeader } from './studioParts';

export interface SectionToolbarProps {
    /** One of the two: a kindColors key ('document' | 'meeting' | 'kb' | …) or a lucide glyph. */
    kind?: string;
    icon?: React.ComponentType<Record<string, unknown>>;
    title: string;
    /** Absent (undefined/null) = not known yet: no chip. */
    count?: number | null;
    search?: string;
    onSearch?: (value: string) => void;
    searchLabel?: string;
    /** The ONE primary action (filled button). */
    primary?: React.ReactNode;
    /** Secondary actions (outlined buttons, menus). */
    extras?: React.ReactNode;
    testId?: string;
}

export default function SectionToolbar({ kind, icon, title, count, search, onSearch, searchLabel, primary, extras, testId }: SectionToolbarProps) {
    const { isDesktop } = useViewport();
    const hasActions = Boolean(primary || extras);
    return (
        <div>
            <StudioSectionHeader
                kind={kind} icon={icon} title={title} testId={testId}
                statusChip={count == null ? undefined : <span data-testid="content-count">{count}</span>}
                primary={isDesktop ? primary : undefined}
                extras={isDesktop ? extras : undefined}
            />
            {(onSearch || (!isDesktop && hasActions)) && <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-[var(--border-subtle)]">
                {onSearch && <label className="relative block flex-1 min-w-40 max-w-sm">
                    <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" aria-hidden="true" />
                    <input type="search" value={search || ''} onChange={e => onSearch(e.target.value)} aria-label={searchLabel} placeholder={searchLabel}
                        className="w-full pl-8 pr-2 py-1.5 rounded-lg text-xs border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-primary)]" />
                </label>}
                {!isDesktop && hasActions && <div className="flex flex-wrap gap-2">{primary}{extras}</div>}
            </div>}
        </div>
    );
}
