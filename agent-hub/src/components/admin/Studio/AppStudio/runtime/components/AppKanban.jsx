import {
    DndContext, DragOverlay, KeyboardSensor, PointerSensor,
    pointerWithin, rectIntersection,
    useDraggable, useDroppable, useSensor, useSensors,
} from '@dnd-kit/core';
import { useCallback, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { resolveBinding, walkPath } from '../resolveBinding';
import { useRuntime } from '../RuntimeContext';
import { HEIGHT_PX, isFill, ROLE_COLORS } from '../styleResolver';
import { EmptyText, ErrorText, SkeletonLines, displayValue, useStickyBinding } from '../uiBits';

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

const COL_PREFIX = 'appkanban-col:';
const CARD_PREFIX = 'appkanban-card:';
/**
 * A droppable id has to carry BOTH axes, and the separator has to be a
 * character no state key, epic name or assignee can contain — a space and a
 * colon are neither ("In review", "Ann Smith", "10:00 standup"). NUL is not
 * enterable in any of the fields these values come from, so the split stays
 * unambiguous whatever the customer names things. Written as an escape, not a
 * raw byte: an invisible control character in source is a trap for the next
 * person to read it.
 */
const LANE_SEP = '\u0000';

export const NO_LANE = '__all__';

/** Droppable id for one column within one lane. */
export function columnDroppableId(lane, value) {
    return `${COL_PREFIX}${lane ?? NO_LANE}${LANE_SEP}${value}`;
}

/**
 * The inverse. A laneless id (`appkanban-col:done`) is accepted and read as the
 * single implicit lane, so a board with no swimlanes keeps the simpler form.
 */
export function parseColumnDroppableId(id) {
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
function laneCollision(args) {
    const hits = pointerWithin(args);
    return hits.length ? hits : rectIntersection(args);
}

const firstOf = (row, keys) => {
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
export function normalizeAxisRows(rows, { withWip = false } = {}) {
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
        const entry = {
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
export function kanbanColumns(configured, rows, groupByField) {
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
            wipLimit: Number.isFinite(c.wipLimit) && c.wipLimit > 0 ? c.wipLimit : null,
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
export function kanbanSwimlanes(configured, rows, swimlaneField) {
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
export function resolveCardDrop({ cell, activeIndex, overIndex }) {
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
export function rankForSlot(beforeRank, afterRank) {
    const b = Number.isFinite(beforeRank) ? beforeRank : null;
    const a = Number.isFinite(afterRank) ? afterRank : null;
    if (b === null && a === null) return 0;
    if (b === null) return a - 1;
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

/** One extra card fact, rendered per its slot. */
function CardField({ field, row }) {
    const raw = walkPath(row, field.key);
    if (raw == null || raw === '') return null;
    let text = displayValue(raw);
    if (field.format === 'number') {
        const n = Number(raw);
        if (Number.isFinite(n)) text = String(n);
    } else if (field.format === 'date') {
        const d = new Date(raw);
        if (!Number.isNaN(d.getTime())) text = d.toLocaleDateString();
    }
    const title = field.label ? `${field.label}: ${text}` : String(text);
    if (field.slot === 'chip') {
        return (
            <span
                className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums"
                style={{ background: 'var(--app-primary-soft, var(--bg-tertiary))', color: 'var(--text-primary)' }}
                title={title}
                data-app-kanban-field={field.key}
            >
                <span className="sr-only">{field.label ? `${field.label}: ` : ''}</span>
                {text}
            </span>
        );
    }
    return (
        <span
            className="inline-flex items-center text-[11px] truncate max-w-[10rem]"
            style={{ color: 'var(--text-secondary)' }}
            title={title}
            data-app-kanban-field={field.key}
        >
            <span className="sr-only">{field.label ? `${field.label}: ` : ''}</span>
            {text}
        </span>
    );
}

/** Card content, shared by the in-lane card and the drag overlay's copy. */
function CardBody({ row, titleKey, subtitleKey, badgeKey, badgeToneMap, cardFields }) {
    const subtitle = subtitleKey ? walkPath(row, subtitleKey) : null;
    const badge = badgeKey ? walkPath(row, badgeKey) : null;
    const toneHit = badge != null && badge !== ''
        ? (Array.isArray(badgeToneMap) ? badgeToneMap : []).find((m) => m && String(m.value) === String(badge))
        : null;
    const dot = toneHit ? (ROLE_COLORS[toneHit.tone] || ROLE_COLORS.neutral) : null;
    const fields = Array.isArray(cardFields) ? cardFields.filter((f) => f && f.key) : [];

    return (
        <>
            <div className="flex items-start gap-1.5">
                <div className="text-sm font-medium break-words min-w-0 flex-1" style={{ color: 'var(--text-primary)' }}>
                    {displayValue(walkPath(row, titleKey))}
                </div>
                {dot ? (
                    <span
                        className="h-2.5 w-2.5 rounded-full shrink-0 mt-1"
                        style={{ background: dot }}
                        title={toneHit.label || String(badge)}
                        data-app-kanban-dot={toneHit.tone || 'neutral'}
                    >
                        <span className="sr-only">{toneHit.label || String(badge)}</span>
                    </span>
                ) : null}
            </div>
            {subtitle != null && subtitle !== '' ? (
                <div className="text-xs mt-0.5 break-words" style={{ color: 'var(--text-secondary)' }}>
                    {displayValue(subtitle)}
                </div>
            ) : null}
            {badge != null && badge !== '' && !toneHit ? (
                <span
                    className="inline-flex items-center rounded-full px-1.5 py-0.5 mt-1.5 text-[11px] font-medium"
                    style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                >
                    {displayValue(badge)}
                </span>
            ) : null}
            {fields.length ? (
                <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                    {fields.map((f) => <CardField key={f.key} field={f} row={row} />)}
                </div>
            ) : null}
        </>
    );
}

function KanbanCard({
    row, index, titleKey, subtitleKey, badgeKey, badgeToneMap, cardFields,
    accent, dragEnabled, clickable, onClick, cardLook,
}) {
    const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
        id: `${CARD_PREFIX}${index}`,
        data: { row },
        disabled: !dragEnabled,
    });
    // A card is a drop target as well as a drag source: without that, a drop
    // could only say WHICH column, never WHERE in it, and a rank-ordered
    // backlog is exactly "where in it".
    const { setNodeRef: setDropRef, isOver } = useDroppable({
        id: `${CARD_PREFIX}${index}`,
        data: { row, cardIndex: index },
        disabled: !dragEnabled,
    });

    const ref = (el) => { setNodeRef(el); setDropRef(el); };

    // Look pass (spec: kanban.cardLook = default | tinted | raised). 'default'
    // — and any unknown value — is the identity path: the exact style object
    // from before the look existed. This styles EVERY card the same way;
    // colorKey/cardColorMap keep coloring individual cards BY DATA (the
    // `accent` edge survives in every look).
    const look = cardLook === 'tinted' || cardLook === 'raised' ? cardLook : 'default';
    let surface = {
        background: 'var(--bg-card)',
        borderColor: isOver && !isDragging ? 'var(--app-primary)' : 'var(--border-default)',
        borderRadius: 'var(--app-radius)',
    };
    if (look === 'tinted') {
        // Soft wash from the card's own accent when it has one, the primary
        // tint otherwise; text stays var(--text-primary) via CardBody, which
        // keeps it readable on the wash in both host themes.
        surface = {
            background: accent
                ? `color-mix(in srgb, ${accent} 10%, var(--bg-card))`
                : 'var(--app-primary-soft)',
            borderColor: isOver && !isDragging ? 'var(--app-primary)' : 'transparent',
            borderRadius: 'var(--app-radius)',
        };
    } else if (look === 'raised') {
        // Semantic elevation (--app-shadow-2 degrades to a ring in high
        // contrast) replaces the hairline; slightly larger radius.
        surface = {
            background: 'var(--bg-card)',
            borderColor: isOver && !isDragging ? 'var(--app-primary)' : 'transparent',
            borderRadius: 'calc(var(--app-radius) * 1.25)',
            boxShadow: 'var(--app-shadow-2)',
        };
    }

    return (
        <div
            ref={ref}
            {...attributes}
            {...listeners}
            data-app-kanban-card={index}
            data-app-kanban-cardlook={look === 'default' ? undefined : look}
            data-app-kanban-cardover={isOver && !isDragging ? 'true' : undefined}
            onClick={clickable ? onClick : undefined}
            // dnd-kit's attributes already announce this as a button with a tab
            // stop, so a keyboard user lands here and nothing happens: Enter
            // neither opens the card nor starts a drag. Opening it is the one
            // that matters, and it is one handler.
            onKeyDown={clickable ? (e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                onClick?.();
            } : undefined}
            className={`border px-2.5 py-2 select-none app-focusable ${clickable ? 'cursor-pointer' : dragEnabled ? 'cursor-grab' : ''}`}
            // The card does NOT follow the pointer itself: it lives inside the
            // column's overflow-y-auto, so a transform beyond the lane edge is
            // clipped and the drag looks dead. The DragOverlay carries the
            // moving copy; the original stays put, dimmed to show its slot.
            style={{
                ...surface,
                borderLeft: accent ? `3px solid ${accent}` : undefined,
                opacity: isDragging ? 0.4 : 1,
                touchAction: 'none',
            }}
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

/** The droppable body of one column within one lane. */
function KanbanCell({ column, lane, children, maxHeight, fill, laned }) {
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

export default function AppKanban({ node }) {
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
    const [activeRow, setActiveRow] = useState(null);
    const [collapsed, setCollapsed] = useState(() => new Set());
    // A drag's pointerup also dispatches a CLICK on whatever the browser deems
    // the common ancestor — without this guard, dropping a card near its own
    // slot immediately opened the workspace. A plain click never starts a drag
    // (4px activation distance), so it never sets the flag.
    const suppressClick = useRef(false);

    const rows = useMemo(
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

    const groupOf = useCallback((row) => {
        const v = walkPath(row, groupByField);
        return v == null || v === '' ? '' : String(v);
    }, [groupByField]);
    const laneOf = useCallback((row) => {
        if (!laned) return NO_LANE;
        const v = walkPath(row, swimlaneField);
        return v == null || v === '' ? '' : String(v);
    }, [laned, swimlaneField]);

    // Every card bucketed once, keyed by lane+column, in source order — which
    // is the order the binding's sort produced, i.e. the board's rank.
    const cells = useMemo(() => {
        const map = new Map();
        rows.forEach((row, index) => {
            const key = `${laneOf(row)}${LANE_SEP}${groupOf(row)}`;
            const bucket = map.get(key);
            if (bucket) bucket.push({ row, index });
            else map.set(key, [{ row, index }]);
        });
        return map;
    }, [rows, groupOf, laneOf]);

    const cellOf = (lane, col) => cells.get(`${lane}${LANE_SEP}${col}`) || [];

    if (error) return <ErrorText error={error} errorCode={errorCode} />;
    if (isLoading) return <SkeletonLines lines={4} />;
    if (cols.length === 0) return <EmptyText text={emptyText || 'Nothing to show yet.'} />;

    const isRun = mode === 'run';
    const dragEnabled = isRun && allowDrag !== false && !!node.onCardMove;
    const clickable = isRun && !!node.onRowClick;
    const fill = isFill(node);
    const maxHeight = fill ? null : (HEIGHT_PX[node.style?.height] || null);

    const accentOf = (row) => {
        if (!colorKey) return null;
        const v = walkPath(row, colorKey);
        if (v == null || v === '') return null;
        const hit = (Array.isArray(cardColorMap) ? cardColorMap : [])
            .find((m) => m && String(m.value) === String(v));
        return hit ? (ROLE_COLORS[hit.tone] || ROLE_COLORS.neutral) : null;
    };

    const onDragStart = (event) => {
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

    const onDragEnd = (event) => {
        setActiveRow(null);
        releaseClickSoon();
        const { active, over } = event || {};
        if (!over || typeof over.id !== 'string') return;
        const row = active?.data?.current?.row;
        if (!row) return;
        const activeIndex = typeof active.id === 'string' && active.id.startsWith(CARD_PREFIX)
            ? Number(active.id.slice(CARD_PREFIX.length))
            : -1;

        let lane = null;
        let value = null;
        let overIndex = null;

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
        const currentPos = currentCell.findIndex((c) => c.index === activeIndex);
        if (sameCell && currentPos === index) return;

        const rankOf = (id) => {
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
        runAction(node.onCardMove, { formValues: payload, ...payload });
    };

    const toggleCollapsed = (value) => {
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

    const renderHeader = (column) => {
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
                <span className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{column.label}</span>
                <span
                    className="text-[11px] ml-auto tabular-nums"
                    style={{ color: over ? ROLE_COLORS.danger : 'var(--text-muted)' }}
                    data-app-kanban-count={column.value}
                    data-app-kanban-overwip={over ? 'true' : undefined}
                    title={column.wipLimit != null ? `${total} of a ${column.wipLimit} work-in-progress limit` : undefined}
                >
                    {column.wipLimit != null ? `${total}/${column.wipLimit}` : total}
                </span>
                {collapsible ? (
                    <button
                        type="button"
                        onClick={() => toggleCollapsed(column.value)}
                        className="text-[11px] px-1 rounded app-focusable"
                        style={{ color: 'var(--text-muted)' }}
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

    const renderCell = (lane, column) => {
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
                            runAction(node.onRowClick, { formValues: row, item: row });
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
                                className="flex items-center gap-1.5 px-1.5 py-1 mt-1 border-t"
                                style={{ borderColor: 'var(--border-subtle, var(--border-default))' }}
                            >
                                {lane.color && ROLE_COLORS[lane.color] ? (
                                    <span className="h-2 w-2 rounded-full shrink-0" style={{ background: ROLE_COLORS[lane.color] }} aria-hidden="true" />
                                ) : null}
                                <span className="text-[11px] font-semibold uppercase tracking-wide truncate" style={{ color: 'var(--text-secondary)' }}>
                                    {lane.label ?? '(none)'}
                                </span>
                                <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
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
                            className="border px-2.5 py-2 select-none cursor-grabbing"
                            style={{
                                background: 'var(--bg-card)',
                                borderColor: 'var(--accent-primary, #0F766E)',
                                borderRadius: 'var(--radius-md, 8px)',
                                boxShadow: '0 8px 24px rgba(0, 0, 0, 0.25)',
                            }}
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
