import { pointerWithin, rectIntersection, type DroppableContainer, type ClientRect, type Active } from '@dnd-kit/core';
import { walkPath } from '../resolveBinding';
import { RectMap } from '@dnd-kit/core/dist/store';
import { Coordinates } from '@dnd-kit/utilities';
import { ROLE_COLORS } from '../styleResolver.constants';
import type { DragEndEvent } from '@dnd-kit/core';
import { CARD_PREFIX } from './KanbanCard';
import type { KanbanCellEntry, KanbanRow, ResolveCardDropArgs, ToneMapEntry } from './AppKanban.types';

const COL_PREFIX = 'appkanban-col:';

/**
 * A droppable id has to carry BOTH axes, and the separator has to be a
 * character no state key, epic name or assignee can contain — a space and a
 * colon are neither ("In review", "Ann Smith", "10:00 standup"). NUL is not
 * enterable in any of the fields these values come from, so the split stays
 * unambiguous whatever the customer names things. Written as an escape, not a
 * raw byte: an invisible control character in source is a trap for the next
 * person to read it.
 */
export const LANE_SEP = '\u0000';

export const NO_LANE = '__all__';

/** Droppable id for one column within one lane. */
export function columnDroppableId(lane: string, value: string) {
    return `${COL_PREFIX}${lane ?? NO_LANE}${LANE_SEP}${value}`;
}

/**
 * The inverse. A laneless id (`appkanban-col:done`) is accepted and read as the
 * single implicit lane, so a board with no swimlanes keeps the simpler form.
 */
export function parseColumnDroppableId(id: string | null) {
    if (typeof id !== 'string' || !id.startsWith(COL_PREFIX)) return null;
    const rest = id.slice(COL_PREFIX.length);
    const cut = rest.indexOf(LANE_SEP);
    if (cut === -1) return { lane: NO_LANE, value: rest };
    return { lane: rest.slice(0, cut), value: rest.slice(cut + LANE_SEP.length) };
}

/**
 * The lane under the POINTER wins — a card is bigger than the gap between
 * lanes, so rect intersection alone picks whichever lane the card's rectangle
 * overlaps most, which is not where the person is aiming. Keyboard drags have
 * no pointer coordinates (pointerWithin returns nothing for them), so rect
 * intersection stays as the fallback.
 */
export function laneCollision(args: { active: Active; collisionRect: ClientRect; droppableRects: RectMap; droppableContainers: DroppableContainer[]; pointerCoordinates: Coordinates|null; }) {
    const hits = pointerWithin(args);
    return hits.length ? hits : rectIntersection(args);
}

const firstOf = (row: KanbanRow, keys: string[]) => {
    for (const k of keys) {
        const v = row[k];
        if (v !== undefined && v !== null && v !== '') return v;
    }
    return null;
};

/**
 * Read a BOUND axis descriptor row leniently — the table belongs to the
 * customer, not to us, so a board config table is allowed to call its columns
 * `state`/`name`/`position` instead of `value`/`label`/`order`.
 *
 * A row with no resolvable `value` is dropped rather than folded into one
 * nameless column: a half-filled config row should look missing, not merge
 * everybody's cards together.
 */
export function normalizeAxisRows(rows: unknown, { withWip = false } = {}) {
    if (!Array.isArray(rows)) return null;
    const out = [];
    let sawOrder = false;
    for (const raw of rows) {
        if (!raw || typeof raw !== 'object') continue;
        const value = firstOf(raw, ['value', 'state', 'key']);
        if (value === null) continue;
        const order = firstOf(raw, ['order', 'position', 'sort_order']);
        if (order !== null && Number.isFinite(Number(order))) sawOrder = true;
        const tone = firstOf(raw, ['color', 'colour', 'tone']);
        const entry: { value: string; label: string; color: string | null; _order: number; wipLimit?: number | null } = {
            value: String(value),
            label: String(firstOf(raw, ['label', 'name', 'title']) ?? value),
            color: tone === null ? null : String(tone),
            _order: order === null ? 0 : Number(order) || 0,
        };
        if (withWip) {
            const wip = firstOf(raw, ['wipLimit', 'wip_limit']);
            entry.wipLimit = wip === null ? null : (Number(wip) || null);
        }
        out.push(entry);
    }
    if (sawOrder) out.sort((a, b) => a._order - b._order);
    return out.map(({ _order, ...rest }) => rest);
}

/**
 * Distinct column descriptors: the configured list pins order/labels/colours,
 * then every group value it does NOT cover gets its own trailing column. An
 * unconfigured value is normal (a legacy status, a value added after the board
 * was set up) and its cards must not silently vanish from the board.
 */
export function kanbanColumns(configured: { value: string; label: string; color?: string | null; wipLimit?: number | null }[], rows: KanbanRow[], groupByField: string) {
    // ONE `seen` set across both passes, so a duplicate in the CONFIGURED list is
    // dropped too. When the columns come from a table the customer edits, two
    // rows naming the same state is an ordinary typo — and an undeduplicated
    // list rendered the column twice, mounted every card in it twice, and
    // registered the same dnd-kit droppable and draggable ids twice.
    const out = [];
    const seen = new Set();
    for (const c of (Array.isArray(configured) ? configured : [])) {
        if (!c || c.value === undefined || c.value === null) continue;
        const value = String(c.value);
        if (seen.has(value)) continue;
        seen.add(value);
        out.push({
            value,
            label: c.label || value,
            color: c.color || null,
            wipLimit: c.wipLimit != null && Number.isFinite(c.wipLimit) && c.wipLimit > 0 ? c.wipLimit : null,
        });
    }
    for (const row of rows) {
        const v = walkPath(row, groupByField);
        const key = v == null || v === '' ? '' : String(v);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ value: key, label: key === '' ? '(none)' : key, color: null, wipLimit: null });
    }
    return out;
}

/** The same derivation for the horizontal axis. Lanes carry no WIP limit. */
export function kanbanSwimlanes(configured: { value: string; label: string; color?: string | null }[], rows: KanbanRow[], swimlaneField: string | null) {
    if (!swimlaneField) return [{ value: NO_LANE, label: null, color: null }];
    const out = [];
    const seen = new Set();   // shared across both passes — see kanbanColumns
    for (const c of (Array.isArray(configured) ? configured : [])) {
        if (!c || c.value === undefined || c.value === null) continue;
        const value = String(c.value);
        if (seen.has(value)) continue;
        seen.add(value);
        out.push({ value, label: c.label || value, color: c.color || null });
    }
    for (const row of rows) {
        const v = walkPath(row, swimlaneField);
        const key = v == null || v === '' ? '' : String(v);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ value: key, label: key === '' ? '(none)' : key, color: null });
    }
    return out;
}

export function resolveCardDrop({ cell, activeIndex, overIndex }: ResolveCardDropArgs) {
    const without = cell.filter((c) => c.index !== activeIndex);
    let pos = without.length;
    if (overIndex !== null && overIndex !== undefined) {
        const at = without.findIndex((c) => c.index === overIndex);
        if (at !== -1) pos = at;
    }
    return {
        index: pos,
        beforeId: pos > 0 ? (without[pos - 1]?.row?.id ?? null) : null,
        afterId: without[pos]?.row?.id ?? null,
    };
}

/**
 * The rank for a slot, from its new neighbours' ranks.
 *
 * Fractional on purpose: inserting between two cards must not renumber anyone,
 * because every renumbered row is another write on a board other people are
 * watching. The ±1 steps at the ends keep the sequence open in both directions
 * forever; an empty column starts at 0.
 *
 * A neighbour with no usable rank (a row created before the board had one) is
 * treated as absent rather than as 0 — reading a missing rank as 0 would slam
 * the card to the middle of the column instead of the end it was dropped at.
 */
export function rankForSlot(beforeRank: number | null, afterRank: number | null) {
    const b = Number.isFinite(beforeRank) ? beforeRank : null;
    const a = Number.isFinite(afterRank) ? afterRank : null;
    if (b === null && a === null) return 0;
    if (b === null) return (a as number) - 1;
    if (a === null) return b + 1;
    const mid = (b + a) / 2;
    // A midpoint is only a midpoint if it lands STRICTLY between. Two neighbours
    // sharing a rank have no gap to land in, and float64 runs out of room after
    // ~52 halvings of one interval. In both cases (b + a) / 2 comes back equal to
    // a neighbour, the update writes the rank the card already had, and the card
    // springs back the moment the refresh lands — a drag that visibly does
    // nothing, forever, with no error.
    //
    // Landing after the pair is not exactly where the pointer was, but it is a
    // REAL move: it resolves the tie, and the next drag has somewhere to go.
    // Expressing "between two equal ranks" would mean renumbering the
    // neighbours, and there is no atomic multi-row write to do it with.
    return (mid > b && mid < a) ? mid : b + 1;
}

/** Every card bucketed once, keyed by lane+column, in source order — which is the order the binding's sort produced, i.e. the board's rank. */
export function bucketCells(rows: KanbanRow[], laneOf: (row: KanbanRow) => string, groupOf: (row: KanbanRow) => string) {
    const map = new Map<string, KanbanCellEntry[]>();
    rows.forEach((row, index) => {
        const key = `${laneOf(row)}${LANE_SEP}${groupOf(row)}`;
        const bucket = map.get(key);
        if (bucket) bucket.push({ row, index });
        else map.set(key, [{ row, index }]);
    });
    return map;
}

/** A card's accent colour from colorKey + cardColorMap, or null. */
export function accentFor(row: KanbanRow, colorKey: string | null, cardColorMap: ToneMapEntry[]) {
    if (!colorKey) return null;
    const v = walkPath(row, colorKey);
    if (v == null || v === '') return null;
    const hit = (Array.isArray(cardColorMap) ? cardColorMap : [])
        .find((m) => m && String(m.value) === String(v));
    return hit ? (ROLE_COLORS[hit.tone] || ROLE_COLORS.neutral) : null;
}

/** Column widths are shared by every lane, so the board reads as a grid rather than N independently-sized rows. */
export function gridStyleFor(columnCount: number) {
    return {
        display: 'grid',
        gridTemplateColumns: `repeat(${columnCount}, minmax(220px, 1fr))`,
        alignItems: 'start',
        gap: '0.75rem',
    };
}

type RowAxis = (row: KanbanRow) => string;

/** Which cell a drop lands in: a column droppable, or another card's slot. Null when it lands nowhere, or on the card itself. */
function dropTarget(overId: string, activeIndex: number, rows: KanbanRow[], laneOf: RowAxis, groupOf: RowAxis) {
    const asColumn = parseColumnDroppableId(overId);
    if (asColumn) return { lane: asColumn.lane, value: asColumn.value, overIndex: null };
    if (!overId.startsWith(CARD_PREFIX)) return null;
    const overIndex = Number(overId.slice(CARD_PREFIX.length));
    if (overIndex === activeIndex) return null;           // dropped on itself
    const target = rows[overIndex];
    if (!target) return null;
    return { lane: laneOf(target), value: groupOf(target), overIndex };
}

/** The rank a row carries in rankKey, or null. */
function rankOfId(rows: KanbanRow[], rankKey: string | null, id: string | null) {
    if (!rankKey || !id) return null;
    const hit = rows.find((r) => r.id === id);
    const v = hit ? Number(walkPath(hit, rankKey)) : NaN;
    return Number.isFinite(v) ? v : null;
}

/** The card being dropped (its row and index) and what it was dropped on; null when either is missing. */
function draggedCard(active: CardMoveArgs['active'], over: CardMoveArgs['over']) {
    if (!over || typeof over.id !== 'string') return null;
    const row: KanbanRow | undefined = active?.data?.current?.row;
    if (!active || !row) return null;
    const activeIndex = typeof active.id === 'string' && active.id.startsWith(CARD_PREFIX)
        ? Number(active.id.slice(CARD_PREFIX.length))
        : -1;
    return { row, activeIndex, overId: over.id };
}

interface CardMoveArgs {
    active: DragEndEvent['active'] | undefined;
    over: DragEndEvent['over'] | undefined;
    rows: KanbanRow[];
    laneOf: RowAxis;
    groupOf: RowAxis;
    cellOf: (lane: string, col: string) => KanbanCellEntry[];
    rankKey: string | null;
    laned: boolean;
}

/**
 * What a drop means, as the payload onCardMove gets: the column (and lane)
 * the card lands in, its slot, its neighbours, and a rank between them
 * (null when the board declares no rankKey, so a board that does not order
 * its cards never writes a column it does not have). Null when the drop
 * changes neither the column nor the position — firing the action anyway
 * would write a record for a gesture that did nothing, and on a shared board
 * that is a spurious "moved by" event.
 */
export function cardMovePayload({ active, over, rows, laneOf, groupOf, cellOf, rankKey, laned }: CardMoveArgs) {
    const dragged = draggedCard(active, over);
    if (!dragged) return null;
    const { row, activeIndex } = dragged;
    const target = dropTarget(dragged.overId, activeIndex, rows, laneOf, groupOf);
    if (!target) return null;
    const { lane, value, overIndex } = target;

    const sameCell = groupOf(row) === value && laneOf(row) === lane;
    const { index, beforeId, afterId } = resolveCardDrop({ cell: cellOf(lane, value), activeIndex, overIndex });
    if (sameCell && beforeId === null && afterId === null) return null;
    const currentPos = cellOf(lane, value).findIndex((c: { index: number; }) => c.index === activeIndex);
    if (sameCell && currentPos === index) return null;

    return {
        item: row,
        value,
        lane: laned ? lane : null,
        index,
        beforeId,
        afterId,
        rank: rankKey ? rankForSlot(rankOfId(rows, rankKey, beforeId), rankOfId(rows, rankKey, afterId)) : null,
    };
}

/** A copy of the set with `value` toggled in or out. */
export function toggledInSet<T>(prev: Set<T>, value: T) {
    const next = new Set(prev);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
}
