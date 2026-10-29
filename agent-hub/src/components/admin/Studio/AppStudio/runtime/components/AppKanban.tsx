import { DndContext, DragOverlay, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragStartEvent, type DragEndEvent } from '@dnd-kit/core';
import { useCallback, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import useTranslation from '@/hooks/useTranslation';
import { resolveBinding, walkPath } from '../resolveBinding';
import { useRuntime } from '../RuntimeContext';
import { isFill } from '../styleResolver.helpers';
import { HEIGHT_PX } from '../styleResolver.constants';
import { EmptyText, ErrorText, SkeletonLines, useStickyBinding } from '../uiBits';
import type { NodeProps } from './appNode.types';
import type { KanbanRow, KanbanColumn, KanbanLane, KanbanProps } from './AppKanban.types';
import { NO_LANE, laneCollision, normalizeAxisRows, kanbanColumns, kanbanSwimlanes, LANE_SEP, accentFor, bucketCells, cardMovePayload, gridStyleFor, toggledInSet } from './AppKanban.helpers';
import { KanbanCard } from './KanbanCard';
import { KanbanCell, KanbanColumnHeader, KanbanGrid, OverlayCard } from './KanbanBoardParts';
export {  columnDroppableId, parseColumnDroppableId, normalizeAxisRows, kanbanColumns, kanbanSwimlanes, resolveCardDrop, rankForSlot } from './AppKanban.helpers';

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
    const cells = useMemo(() => bucketCells(rows, laneOf, groupOf), [rows, groupOf, laneOf]);

    const cellOf = (lane: string, col: string) => cells.get(`${lane}${LANE_SEP}${col}`) || [];

    if (error) return <ErrorText error={error} errorCode={errorCode} />;
    if (isLoading) return <SkeletonLines lines={4} />;
    if (cols.length === 0) return <EmptyText text={emptyText || t('studio_apps_runtime.ui.nothing_to_show', 'Nothing to show yet.')} />;

    const isRun = mode === 'run';
    const dragEnabled = isRun && allowDrag !== false && !!node.onCardMove;
    const clickable = isRun && !!node.onRowClick;
    const fill = isFill(node);
    const maxHeight = fill ? null : (HEIGHT_PX[node.style?.height ?? ''] || null);

    const accentOf = (row: KanbanRow) => accentFor(row, colorKey, cardColorMap);

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
        const payload = cardMovePayload({ active, over, rows, laneOf, groupOf, cellOf, rankKey, laned });
        if (payload) runAction(node.onCardMove as string, { formValues: payload, ...payload });
    };

    const toggleCollapsed = (value: string) => setCollapsed((prev) => toggledInSet(prev, value));

    // Column widths are shared by every lane, so the board reads as a grid
    // rather than N independently-sized rows.
    const gridStyle = gridStyleFor(cols.length);

    const renderHeader = (column: KanbanColumn) => (
        <KanbanColumnHeader
            key={column.value} t={t} column={column} collapsible={collapsible}
            total={lanes.reduce((n, l) => n + cellOf(l.value, column.value).length, 0)}
            isCollapsed={collapsed.has(column.value)} onToggle={() => toggleCollapsed(column.value)}
        />
    );

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
        <KanbanGrid
            t={t} cols={cols} lanes={lanes} laned={laned} fill={fill} gridStyle={gridStyle} renderHeader={renderHeader} renderCell={renderCell}
            laneCount={(lane) => cols.reduce((n, c) => n + cellOf(lane.value, c.value).length, 0)}
        />
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
                    {activeRow ? <OverlayCard row={activeRow} titleKey={titleKey} subtitleKey={subtitleKey} badgeKey={badgeKey} badgeToneMap={badgeToneMap} cardFields={cardFields} /> : null}
                </DragOverlay>,
                document.body,
            )}
        </DndContext>
    );
}
