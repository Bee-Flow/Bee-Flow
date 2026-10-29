import { useDroppable } from '@dnd-kit/core';
import type React from 'react';
import type { TranslateFn } from '@/hooks/useTranslation';
import { ROLE_COLORS } from '../styleResolver.constants';
import { columnDroppableId } from './AppKanban.helpers';
import type { CardBodyProps, KanbanCellProps, KanbanColumn, KanbanLane } from './AppKanban.types';
import { CardBody } from './KanbanCard';

// The board pieces of AppKanban: a droppable cell, a column header, a swimlane header and the drag overlay card.

export function KanbanCell({ column, lane, children, maxHeight, fill, laned }: KanbanCellProps) {
    const { setNodeRef, isOver } = useDroppable({ id: columnDroppableId(lane, column.value) });
    return (
        <div
            ref={setNodeRef}
            data-app-kanban-column={column.value}
            data-app-kanban-lane={laned ? lane : undefined}
            className={`flex flex-col gap-1.5 p-1.5 min-h-[3rem]${fill && !laned ? ' flex-1 min-h-0 overflow-y-auto' : ''}`}
            style={{
                background: isOver ? 'var(--app-primary-soft)' : 'transparent',
                borderRadius: 'var(--app-radius)',
                // Per-COLUMN scroll (not per-board): a board-level scrollbar
                // would move every column at once and hide the headers. With
                // swimlanes the lane grows to its content instead and the board
                // scrolls as a whole, because N independently scrolling boxes in
                // a grid row is unreadable.
                ...(!laned && !fill && maxHeight ? { maxHeight, overflowY: 'auto' } : null),
            }}
        >
            {children}
        </div>
    );
}

interface KanbanColumnHeaderProps {
    t: TranslateFn;
    column: KanbanColumn;
    total: number;
    collapsible: boolean;
    isCollapsed: boolean;
    onToggle: () => void;
}

/** A column's dot, name, card count (against its WIP limit) and the collapse toggle. */
export function KanbanColumnHeader({ t, column, total, collapsible, isCollapsed, onToggle }: KanbanColumnHeaderProps) {
    const dot = column.color ? ROLE_COLORS[column.color] : null;
    const over = column.wipLimit != null && total > column.wipLimit;
    return (
    <div
        className="flex items-center gap-1.5 px-1.5 pb-1"
        data-app-kanban-header={column.value}
    >
        {dot ? <span className="h-2 w-2 rounded-full shrink-0" style={{ background: dot }} aria-hidden="true" /> : null}
        <span className="text-xs font-semibold truncate text-[var(--text-primary)]">{column.label}</span>
        <span
            className="text-[11px] ml-auto tabular-nums"
            style={{ color: over ? ROLE_COLORS.danger : 'var(--text-muted)' }}
            data-app-kanban-count={column.value}
            data-app-kanban-overwip={over ? 'true' : undefined}
            title={column.wipLimit != null ? t('studio_apps_runtime.kanban.wip_limit', '{total} of a {limit} work-in-progress limit', { total, limit: column.wipLimit }) : undefined}
        >
            {column.wipLimit != null ? `${total}/${column.wipLimit}` : total}
        </span>
        {collapsible ? (
            <button
                type="button"
                onClick={onToggle}
                className="text-[11px] px-1 rounded app-focusable [color:var(--text-muted)]!"
                aria-expanded={!isCollapsed}
                data-app-kanban-collapse={column.value}
            >
                {isCollapsed ? '+' : '–'}
                <span className="sr-only">{isCollapsed ? `Expand ${column.label}` : `Collapse ${column.label}`}</span>
            </button>
        ) : null}
    </div>
    );
}

/** A swimlane's dot, name and card count. */
function SwimlaneHeader({ t, lane, count }: { t: TranslateFn; lane: KanbanLane; count: number }) {
    return (
        <div
            className="flex items-center gap-1.5 px-1.5 py-1 mt-1 border-t [border-color:var(--border-subtle,var(--border-default))]!"
        >
            {lane.color && ROLE_COLORS[lane.color] ? (
                <span className="h-2 w-2 rounded-full shrink-0" style={{ background: ROLE_COLORS[lane.color] }} aria-hidden="true" />
            ) : null}
            <span className="text-[11px] font-semibold uppercase tracking-wide truncate text-[var(--text-secondary)]">
                {lane.label ?? t('studio_apps_runtime.kanban.no_lane', '(none)')}
            </span>
            <span className="text-[11px] tabular-nums text-[var(--text-muted)]">
                {count}
            </span>
        </div>
    );
}

/** The card riding in the DragOverlay while a drag is live. */
export function OverlayCard({ row, titleKey, subtitleKey, badgeKey, badgeToneMap, cardFields }: CardBodyProps) {
    return (
            <div
                data-app-kanban-overlay="true"
                className="border px-2.5 py-2 select-none cursor-grabbing [background:var(--bg-card)] [border-color:var(--accent-primary,#0F766E)] [border-radius:var(--radius-md,8px)] [box-shadow:0_8px_24px_rgba(0,0,0,0.25)]"
            >
                <CardBody
                    row={row}
                    titleKey={titleKey}
                    subtitleKey={subtitleKey}
                    badgeKey={badgeKey}
                    badgeToneMap={badgeToneMap}
                    cardFields={cardFields}
                />
            </div>
    );
}

interface KanbanGridProps {
    t: TranslateFn;
    cols: KanbanColumn[];
    lanes: KanbanLane[];
    laned: boolean;
    fill: boolean;
    gridStyle: React.CSSProperties;
    renderHeader: (column: KanbanColumn) => React.ReactNode;
    renderCell: (lane: KanbanLane, column: KanbanColumn) => React.ReactNode;
    laneCount: (lane: KanbanLane) => number;
}

/** The board: one header row, then a grid row per swimlane (or a single one). */
export function KanbanGrid({ t, cols, lanes, laned, fill, gridStyle, renderHeader, renderCell, laneCount }: KanbanGridProps) {
    return (
    <div
        className={`overflow-x-auto${fill ? ' app-fill h-full min-h-0 flex flex-col' : ''}`}
        data-app-kanban="true"
    >
        <div
            className={fill && !laned ? 'flex flex-col min-h-0 flex-1' : undefined}
            style={{ minWidth: `${cols.length * 220}px` }}
        >
            <div style={gridStyle} className="shrink-0">
                {cols.map(renderHeader)}
            </div>
            {laned ? (
                lanes.map((lane) => (
                    <div key={lane.value} data-app-kanban-swimlane={lane.value}>
                        <SwimlaneHeader t={t} lane={lane} count={laneCount(lane)} />
                        <div style={gridStyle}>
                            {cols.map((column) => renderCell(lane, column))}
                        </div>
                    </div>
                ))
            ) : (
                <div style={gridStyle} className={fill ? 'flex-1 min-h-0' : undefined}>
                    {cols.map((column) => renderCell(lanes[0], column))}
                </div>
            )}
        </div>
    </div>
    );
}
