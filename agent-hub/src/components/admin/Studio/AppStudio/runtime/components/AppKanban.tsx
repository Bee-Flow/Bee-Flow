import { DndContext, DragOverlay, KeyboardSensor, PointerSensor, useDroppable, useSensor, useSensors, type DragStartEvent, type DragEndEvent } from '@dnd-kit/core';
import { useCallback, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import useTranslation from '@/hooks/useTranslation';
import { resolveBinding, walkPath } from '../resolveBinding';
import { useRuntime } from '../RuntimeContext';
import { isFill } from '../styleResolver.helpers';
import { HEIGHT_PX, ROLE_COLORS } from '../styleResolver.constants';
import { EmptyText, ErrorText, SkeletonLines, useStickyBinding } from '../uiBits';
import type { BindingInput } from '../resolveBinding.types';
import type { NodeProps } from './appNode.types';
import type { KanbanRow, KanbanCellEntry, KanbanColumn, KanbanLane, ToneMapEntry, CardFieldSpec, KanbanProps, KanbanCellProps } from './AppKanban.types';
import { CARD_PREFIX, CardBody, KanbanCard } from './KanbanCard';
import { LANE_SEP, NO_LANE, columnDroppableId, parseColumnDroppableId, laneCollision, normalizeAxisRows, kanbanColumns, kanbanSwimlanes, resolveCardDrop, rankForSlot } from './AppKanban.helpers';
export {  columnDroppableId, parseColumnDroppableId, normalizeAxisRows, kanbanColumns, kanbanSwimlanes, resolveCardDrop, rankForSlot } from './AppKanban.helpers';

function KanbanCell({ column, lane, children, maxHeight, fill, laned }: KanbanCellProps) {
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

export default function AppKanban({ node }: NodeProps<KanbanProps>) {
    const { t } = useTranslation();
    const { mode, runAction, actionState, dataState, scope } = useRuntime();
    const {
        groupByField = 'status', columns = [], titleKey = 'title',
        subtitleKey = null, badgeKey = null, badgeToneMap = [], allowDrag = true,
        swimlaneField = null, swimlanes = [], cardFields = [],
        colorKey = null, cardColorMap = [], collapsible = false, emptyText = null,
        rankKey = null, cardLook = 'default',
    } = node.props || {};

    const { value: source, isLoading, error, errorCode } = useStickyBinding(
        resolveBinding(node.props?.source, { actionState, dataState, scope }),
    );
    // The two CONFIG axes. Each resolves independently of the card data, so a
    // board whose config table is still loading keeps rendering its designed
    // default columns rather than flashing an empty page.
    const boundColumns = normalizeAxisRows(
        resolveBinding(node.props?.columnsSource, { actionState, dataState, scope })?.value,
        { withWip: true },
    );
    const boundSwimlanes = normalizeAxisRows(
        resolveBinding(node.props?.swimlanesSource, { actionState, dataState, scope })?.value,
    );

    // KeyboardSensor as well as Pointer: the cards advertise themselves as
    // draggable to a screen reader, so they have to actually be draggable
    // from the keyboard.
    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
        useSensor(KeyboardSensor),
    );

    // The row riding in the DragOverlay while a drag is live.
    const [activeRow, setActiveRow] = useState<KanbanRow | null>(null);
    const [collapsed, setCollapsed] = useState(() => new Set());
    // A drag's pointerup also dispatches a CLICK on whatever the browser deems
    // the common ancestor — without this guard, dropping a card near its own
    // slot immediately opened the workspace. A plain click never starts a drag
    // (4px activation distance), so it never sets the flag.
    const suppressClick = useRef(false);

    const rows = useMemo<KanbanRow[]>(
        () => (Array.isArray(source) ? source : []).filter((r) => r && typeof r === 'object'),
        [source],
    );

    const cols = useMemo(
        () => kanbanColumns(boundColumns && boundColumns.length ? boundColumns : columns, rows, groupByField),
        [boundColumns, columns, rows, groupByField],
    );
    const lanes = useMemo(
        () => kanbanSwimlanes(boundSwimlanes && boundSwimlanes.length ? boundSwimlanes : swimlanes, rows, swimlaneField),
        [boundSwimlanes, swimlanes, rows, swimlaneField],
    );

    const laned = !!swimlaneField;

    const groupOf = useCallback((row: KanbanRow) => {
        const v = walkPath(row, groupByField);
        return v == null || v === '' ? '' : String(v);
    }, [groupByField]);
    const laneOf = useCallback((row: KanbanRow) => {
        if (!laned) return NO_LANE;
        const v = walkPath(row, swimlaneField);
        return v == null || v === '' ? '' : String(v);
    }, [laned, swimlaneField]);

    // Every card bucketed once, keyed by lane+column, in source order — which
    // is the order the binding's sort produced, i.e. the board's rank.
    const cells = useMemo(() => {
        const map = new Map<string, KanbanCellEntry[]>();
        rows.forEach((row, index) => {
            const key = `${laneOf(row)}${LANE_SEP}${groupOf(row)}`;
            const bucket = map.get(key);
            if (bucket) bucket.push({ row, index });
            else map.set(key, [{ row, index }]);
        });
        return map;
    }, [rows, groupOf, laneOf]);

    const cellOf = (lane: string, col: string) => cells.get(`${lane}${LANE_SEP}${col}`) || [];

    if (error) return <ErrorText error={error} errorCode={errorCode} />;
    if (isLoading) return <SkeletonLines lines={4} />;
    if (cols.length === 0) return <EmptyText text={emptyText || t('studio_apps_runtime.ui.nothing_to_show', 'Nothing to show yet.')} />;

    const isRun = mode === 'run';
    const dragEnabled = isRun && allowDrag !== false && !!node.onCardMove;
    const clickable = isRun && !!node.onRowClick;
    const fill = isFill(node);
    const maxHeight = fill ? null : (HEIGHT_PX[node.style?.height ?? ''] || null);

    const accentOf = (row: KanbanRow) => {
        if (!colorKey) return null;
        const v = walkPath(row, colorKey);
        if (v == null || v === '') return null;
        const hit = (Array.isArray(cardColorMap) ? cardColorMap : [])
            .find((m) => m && String(m.value) === String(v));
        return hit ? (ROLE_COLORS[hit.tone] || ROLE_COLORS.neutral) : null;
    };

    const onDragStart = (event: DragStartEvent) => {
        suppressClick.current = true;
        setActiveRow(event?.active?.data?.current?.row || null);
    };

    // The synthetic click fires synchronously after pointerup — a macrotask
    // later is after it, and before any next intentional click can happen.
    const releaseClickSoon = () => { setTimeout(() => { suppressClick.current = false; }, 0); };

    const onDragCancel = () => {
        setActiveRow(null);
        releaseClickSoon();
    };

    const onDragEnd = (event: DragEndEvent) => {
        setActiveRow(null);
        releaseClickSoon();
        const { active, over } = event || {};
        if (!over || typeof over.id !== 'string') return;
        const row = active?.data?.current?.row;
        if (!row) return;
        const activeIndex = typeof active.id === 'string' && active.id.startsWith(CARD_PREFIX)
            ? Number(active.id.slice(CARD_PREFIX.length))
            : -1;

        let lane: string | null = null;
        let value: string | null = null;
        let overIndex: number | null = null;

        const asColumn = parseColumnDroppableId(over.id);
        if (asColumn) {
            ({ lane, value } = asColumn);
        } else if (over.id.startsWith(CARD_PREFIX)) {
            overIndex = Number(over.id.slice(CARD_PREFIX.length));
            if (overIndex === activeIndex) return;           // dropped on itself
            const target = rows[overIndex];
            if (!target) return;
            lane = laneOf(target);
            value = groupOf(target);
        } else {
            return;
        }

        const sameCell = groupOf(row) === value && laneOf(row) === lane;
        const { index, beforeId, afterId } = resolveCardDrop({
            cell: cellOf(lane, value),
            activeIndex,
            overIndex,
        });
        // A drop that changes neither the column nor the position is a no-op —
        // firing the action anyway would write a record for a gesture that did
        // nothing, and on a shared board that is a spurious "moved by" event.
        if (sameCell && beforeId === null && afterId === null) return;
        const currentCell = cellOf(lane, value);
        const currentPos = currentCell.findIndex((c: { index: number; }) => c.index === activeIndex);
        if (sameCell && currentPos === index) return;

        const rankOf = (id: string | null) => {
            if (!rankKey || !id) return null;
            const hit = rows.find((r) => r.id === id);
            const v = hit ? Number(walkPath(hit, rankKey)) : NaN;
            return Number.isFinite(v) ? v : null;
        };

        const payload = {
            item: row,
            value,
            lane: laned ? lane : null,
            index,
            beforeId,
            afterId,
            // Ready to write: `values: { rank: {kind:'formula', expr:'form.rank'} }`.
            // null when the board declares no rankKey, so a board that does not
            // order its cards never writes a column it does not have.
            rank: rankKey ? rankForSlot(rankOf(beforeId), rankOf(afterId)) : null,
        };
        runAction(node.onCardMove as string, { formValues: payload, ...payload });
    };

    const toggleCollapsed = (value: string) => {
        setCollapsed((prev) => {
            const next = new Set(prev);
            if (next.has(value)) next.delete(value);
            else next.add(value);
            return next;
        });
    };

    // Column widths are shared by every lane, so the board reads as a grid
    // rather than N independently-sized rows.
    const gridStyle = {
        display: 'grid',
        gridTemplateColumns: `repeat(${cols.length}, minmax(220px, 1fr))`,
        alignItems: 'start',
        gap: '0.75rem',
    };

    const renderHeader = (column: KanbanColumn) => {
        const dot = column.color ? ROLE_COLORS[column.color] : null;
        const total = lanes.reduce((n, l) => n + cellOf(l.value, column.value).length, 0);
        const over = column.wipLimit != null && total > column.wipLimit;
        const isCollapsed = collapsed.has(column.value);
        return (
            <div
                key={column.value}
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
                        onClick={() => toggleCollapsed(column.value)}
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
    };

    const renderCell = (lane: KanbanLane, column: KanbanColumn) => {
        if (collapsed.has(column.value)) {
            return <div key={`${lane.value}-${column.value}`} aria-hidden="true" />;
        }
        const cell = cellOf(lane.value, column.value);
        return (
            <KanbanCell
                key={`${lane.value}-${column.value}`}
                column={column}
                lane={lane.value}
                maxHeight={maxHeight}
                fill={fill}
                laned={laned}
            >
                {cell.map(({ row, index }) => (
                    <KanbanCard
                        key={row.id ?? index}
                        row={row}
                        index={index}
                        titleKey={titleKey}
                        subtitleKey={subtitleKey}
                        badgeKey={badgeKey}
                        badgeToneMap={badgeToneMap}
                        cardFields={cardFields}
                        accent={accentOf(row)}
                        cardLook={cardLook}
                        dragEnabled={dragEnabled}
                        clickable={clickable}
                        onClick={() => {
                            if (suppressClick.current) return;
                            runAction(node.onRowClick as string, { formValues: row, item: row });
                        }}
                    />
                ))}
            </KanbanCell>
        );
    };

    const board = (
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
                                    {cols.reduce((n, c) => n + cellOf(lane.value, c.value).length, 0)}
                                </span>
                            </div>
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

    return (
        <DndContext
            sensors={sensors}
            collisionDetection={laneCollision}
            onDragStart={onDragStart}
            onDragCancel={onDragCancel}
            onDragEnd={onDragEnd}
        >
            {board}
            {/* The moving copy lives OUTSIDE the lanes' scroll containers, so it
                stays visible across the whole board instead of being clipped at
                the first overflow edge — which read as "drag doesn't work".
                PORTALED to <body>: the overlay positions itself with fixed
                coordinates, and any transformed ancestor (the builder's canvas
                chrome) becomes its containing block — the copy then floats a
                constant offset away from the cursor. On <body> the viewport is
                the containing block everywhere the board can be embedded.
                <body> is outside the AppRenderer root that stamps the app's
                theme variables, so the overlay pins the two tokens it needs
                rather than inheriting nothing and rendering unstyled. */}
            {createPortal(
                <DragOverlay dropAnimation={null}>
                    {activeRow ? (
                        <div
                            data-app-kanban-overlay="true"
                            className="border px-2.5 py-2 select-none cursor-grabbing [background:var(--bg-card)] [border-color:var(--accent-primary,#0F766E)] [border-radius:var(--radius-md,8px)] [box-shadow:0_8px_24px_rgba(0,0,0,0.25)]"
                        >
                            <CardBody
                                row={activeRow}
                                titleKey={titleKey}
                                subtitleKey={subtitleKey}
                                badgeKey={badgeKey}
                                badgeToneMap={badgeToneMap}
                                cardFields={cardFields}
                            />
                        </div>
                    ) : null}
                </DragOverlay>,
                document.body,
            )}
        </DndContext>
    );
}
