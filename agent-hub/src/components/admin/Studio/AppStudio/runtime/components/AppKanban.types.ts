import type { BindingInput } from '../resolveBinding.types';
import type React from 'react';

/**
 * App Studio runtime — 'kanban'. Spec: server/appStudio/componentSpecs.js.
 *
 * Rows group into COLUMNS by groupByField and, optionally, into SWIMLANES by
 * swimlaneField. Both axes can be pinned as literal props OR bound to a table
 * (columnsSource / swimlanesSource) — the latter is what lets the people using
 * an app configure its board without opening the builder, which is the right
 * split: adding an "In review" column is configuration, not development.
 *
 * DRAGGING. A card is draggable AND droppable; a column is droppable. Dropping
 * on a column appends to it; dropping on a card takes that card's slot. Either
 * way the move fires:
 *
 *   runAction(node.onCardMove, { formValues: {
 *     item, value, lane, index, beforeId, afterId,
 *   }, item, value, lane, index, beforeId, afterId })
 *
 * so one update_record sequence can write BOTH the new column (`form.value`)
 * and a new rank: `beforeId`/`afterId` are the rows that end up immediately
 * above and below the card, and a midpoint of their ranks is a stable order
 * that never needs to renumber its neighbours. A board that only knows which
 * column a card is in cannot express a prioritised backlog, which is most of
 * what sprint planning IS.
 *
 * Cards are deliberately NOT @dnd-kit/sortable: a lane's cards live inside an
 * overflow container and sortable's transforms fight it (the same reason the
 * DragOverlay exists below). Draggable + droppable gives positional drops
 * without that.
 *
 * badgeToneMap (list's shape: [{ value, label, tone }]) turns the badge into a
 * coloured DOT when the value maps — a traffic light, not a word — with the
 * mapped label as its tooltip/sr text. Unmapped values keep the text pill so
 * data never silently vanishes.
 */

/** One record of the board's source table. */
export type KanbanRow = { id?: string; [key: string]: unknown };

export interface KanbanCellEntry {
    row: KanbanRow;
    index: number;
}

export interface KanbanColumn {
    value: string;
    label: string;
    color: string | null;
    wipLimit: number | null;
}

export interface KanbanLane {
    value: string;
    label: string | null;
    color: string | null;
}

/** One entry of a badgeToneMap / cardColorMap: a row value and the tone it maps to. */
export interface ToneMapEntry {
    value?: unknown;
    label?: string | null;
    tone: string;
}

export interface CardFieldSpec {
    key: string;
    label: string;
    slot: string;
    format: string;
}

export interface KanbanProps {
    source?: BindingInput;
    columnsSource?: BindingInput;
    swimlanesSource?: BindingInput;
    groupByField?: string;
    columns?: { value: string; label: string; color?: string | null; wipLimit?: number | null }[];
    titleKey?: string;
    subtitleKey?: string | null;
    badgeKey?: string | null;
    badgeToneMap?: ToneMapEntry[];
    allowDrag?: boolean;
    swimlaneField?: string | null;
    swimlanes?: { value: string; label: string; color?: string | null }[];
    cardFields?: CardFieldSpec[];
    colorKey?: string | null;
    cardColorMap?: ToneMapEntry[];
    collapsible?: boolean;
    emptyText?: string | null;
    rankKey?: string | null;
    cardLook?: string;
}

/**
 * Where a drop lands, as plain data.
 *
 * `cell` is the target column+lane's rows in render order, INCLUDING the moved
 * row if it started there. `overIndex` is the flat index of the card the
 * pointer released on, or null for a drop on the column itself (append).
 *
 * Returns { index, beforeId, afterId } describing the card's resulting
 * position — index counted in the list with the moved row already lifted out,
 * which is what makes beforeId/afterId a correct rank bracket in both
 * directions of travel.
 */
export interface ResolveCardDropArgs {
    cell: KanbanCellEntry[];
    activeIndex: number;
    overIndex: number | null;
}

/** One extra card fact, rendered per its slot. */
export interface CardFieldProps {
    field: CardFieldSpec;
    row: KanbanRow;
}

/** Card content, shared by the in-lane card and the drag overlay's copy. */
export interface CardBodyProps {
    row: KanbanRow;
    titleKey: string;
    subtitleKey: string | null;
    badgeKey: string | null;
    badgeToneMap: ToneMapEntry[];
    cardFields: CardFieldSpec[];
}

export interface KanbanCardProps {
    row: KanbanRow;
    index: number;
    titleKey: string;
    subtitleKey: string | null;
    badgeKey: string | null;
    badgeToneMap: ToneMapEntry[];
    cardFields: CardFieldSpec[];
    accent: string | null;
    dragEnabled: boolean;
    clickable: boolean;
    onClick: () => void;
    cardLook: string;
}

/** The droppable body of one column within one lane. */
export interface KanbanCellProps {
    column: KanbanColumn;
    lane: string;
    children?: React.ReactNode;
    maxHeight: string | null;
    fill: boolean;
    laned: boolean;
}
