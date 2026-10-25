import { flowOrder } from './flowOrder';
import { MIN_MOVE_GAP_MS } from '../../../shared/builder/revealSchedule';
import type { DiagramDefinition } from './diagramPaneTypes';
import type { Rect } from './useBuildChoreography.types';
import type { Viewport } from '@xyflow/system';
import type { Shot, ShotForArgs, PlanCameraMoveArgs } from './buildChoreography.types';
import { COLUMNS, COL_PITCH, ROW_PITCH, WRAP_HOLD_MS, SHOTS } from './buildChoreography.constants';
import { nodesOf, contentOf, edgeKeysOf, viewportForBounds, biasTowardNewest, interpolateFor, viewportSize, frameOf, placedRect, movesFor } from './buildChoreography.helpers';
export { COL_PITCH, ROW_PITCH, WRAP_HOLD_MS, DEFAULT_SHOTS, BURST_WIDE_MIN } from './buildChoreography.constants';

/**
 * The build as a film — the pure half.
 *
 * While the AI builds an automation the server sends the WHOLE definition after
 * every mutating tool call (and again, unchanged, after a refused one). Nothing
 * on the canvas may therefore key on definition identity; every beat keys on a
 * diff of consecutive definitions, computed here. The canvas keeps rendering
 * the live draft — layout, minimap, validation stay truthful — and what lags is
 * only visibility: reveal delays, a frontier id, fresh edge keys, and a camera
 * plan the hook (`useBuildChoreography`) turns into React Flow calls.
 *
 * Everything in this module is framework-free and deterministic so it can be
 * pinned by a plain node test: no React, no DOM, no timers of its own.
 */

// Cadence constants, revealSchedule and orderAdded are shared with the App Studio
// editor (shared/builder/revealSchedule.js) and re-exported here unchanged.
export { REVEAL_STAGGER_MS, REVEAL_STAGGER_MIN_MS, REVEAL_BUDGET_MS, MIN_MOVE_GAP_MS, revealSchedule, orderAdded } from '../../../shared/builder/revealSchedule';

// Presenter mode (flow/presenterMode.js) frames tighter — higher zoom floors,
// so the pushed-in cards are legible from the back of a room — without the
// choreography hook having to know: `shotFor` reads the ACTIVE set. Module-
// level on purpose (one canvas is ever choreographed at a time); `null`
// restores the defaults. The hook's own wide and mount fits (WIDE_SHOT /
// MOUNT_SHOT in useBuildChoreography.js) do not pass through shotFor and keep
// their floors.
let activeShots: Readonly<Record<string, Readonly<Shot> | undefined>> = SHOTS;

export function setActiveShots(next: Readonly<Record<string, Readonly<Shot>>> | null) {
    activeShots = (next && next.push && next.wide) ? next : SHOTS;
}

export function getActiveShots() {
    return activeShots;
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

/**
 * What changed between two consecutive drafts.
 *
 *   added         — ids present only in `next`, in the order they RUN (flowOrder),
 *                   so a `builder_add_steps` burst reveals trigger-side first.
 *   removed       — ids present only in `prev`, in `prev`'s own order.
 *   touched       — same id, different content once `position` is ignored.
 *   addedEdgeKeys — `edgeKey`s present only in `next` (a removal that splices
 *                   prev→next yields exactly one).
 *
 * A refused call re-sends an identical definition and must diff to nothing —
 * that is the whole reason this exists instead of "did the draft object change".
 * Inline-prefixed ids (`layer/step`) and `triggers[]` are ordinary ids here.
 */
export function diffDefinitions(prev: DiagramDefinition, next: DiagramDefinition) {
    const before = nodesOf(prev);
    const after = nodesOf(next);

    const added: string[] = [];
    const seen = new Set<string>();
    for (const id of flowOrder(next)) {
        if (!after.has(id) || seen.has(id)) continue;
        seen.add(id);
        if (!before.has(id)) added.push(id);
    }
    // flowOrder is total over the ids it indexes; this only guards against a
    // future change there silently dropping a card's reveal.
    for (const id of after.keys()) if (!seen.has(id) && !before.has(id)) added.push(id);

    const removed: string[] = [];
    for (const id of before.keys()) if (!after.has(id)) removed.push(id);

    const touched: string[] = [];
    for (const [id, step] of after) {
        if (!before.has(id)) continue;
        if (contentOf(before.get(id)) !== contentOf(step)) touched.push(id);
    }

    const prevEdges = edgeKeysOf(prev);
    const addedEdgeKeys: string[] = [];
    for (const key of edgeKeysOf(next)) if (!prevEdges.has(key)) addedEdgeKeys.push(key);

    return { added, removed, touched, addedEdgeKeys };
}

// ---------------------------------------------------------------------------
// Reveal
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * Where the NEXT card will land, given the frontier card's rect: one column
 * pitch to the right, or the first column of a new row when the frontier sits
 * in the last column. Mirrors `rowLayoutPositions` (fixed columns, row pitch
 * card + ROW_GAP) so the ghost slot stands exactly where the real card will
 * appear and the camera can leave room for it.
 */
export function nextSlotFor(frontierRect: Rect, { colWidth = COL_PITCH, cols = COLUMNS, rowPitch = ROW_PITCH } = {}) {
    const x = Number(frontierRect?.x) || 0;
    const y = Number(frontierRect?.y) || 0;
    // Round, not floor: a card is placed on the grid but a measured rect may
    // sit a fraction off it, and floor would then read column 4 as column 3.
    const col = Math.round(x / colWidth);
    if (col >= cols - 1) return { x: 0, y: y + rowPitch };
    return { x: x + colWidth, y };
}

export function shotFor({ kind = 'push', rects, ghostRect, viewport, current }: ShotForArgs = {}) {
    const recipe = activeShots[kind];
    const size = viewportSize(viewport);
    if (!recipe || !size) return null;

    const cards = Array.isArray(rects) ? rects : [];
    const frame = frameOf(cards, ghostRect);
    if (!frame) return null;

    const base = viewportForBounds(frame, size, recipe);
    const newest = kind === 'push' ? placedRect(cards[cards.length - 1]) : null;
    const { x, y } = newest ? biasTowardNewest(base, frame, newest, size) : base;

    return { x, y, zoom: base.zoom, duration: recipe.duration, interpolate: interpolateFor(kind, base.zoom, current) };
}

/**
 * Is `rect` (flow coordinates) fully on screen under `viewport`, with `margin`
 * px to spare on every side? A chain growing inside the frame must not move
 * the camera; this is the test that keeps it still.
 */
export function isRectInView(rect: Rect, viewport: Viewport, size: { width: number; height: number; offsetX: number; }, margin: number = 48) {
    if (!rect || !viewport || !size) return false;
    const { x: vx = 0, y: vy = 0, zoom = 1 } = viewport;
    const { width: rw = 0, height: rh = 0 } = rect;
    // `offsetX` is a strip of the canvas that is covered by something drawn
    // over it (the plan panel): the usable region starts there, so a card
    // behind the panel is NOT in view, however much canvas is left of it.
    const { width: sw = 0, height: sh = 0, offsetX = 0 } = size;
    const left = rect.x * zoom + vx;
    const top = rect.y * zoom + vy;
    const right = (rect.x + rw) * zoom + vx;
    const bottom = (rect.y + rh) * zoom + vy;
    return left >= offsetX + margin && top >= margin && right <= offsetX + sw - margin && bottom <= sh - margin;
}

// ---------------------------------------------------------------------------
// Camera plan
// ---------------------------------------------------------------------------

export function planCameraMove({ reason, following = true, lastMoveAt = null, now = 0, rowWrapped = false }: PlanCameraMoveArgs = {}) {
    if (following === false) return null;
    const moves = movesFor(reason, rowWrapped);
    if (!moves) return null;

    const since = Number.isFinite(lastMoveAt) && Number.isFinite(now) ? now - Number(lastMoveAt) : Infinity;
    const deferMs = since < MIN_MOVE_GAP_MS ? Math.ceil(MIN_MOVE_GAP_MS - since) : 0;
    const holdMs = moves.length > 1 ? WRAP_HOLD_MS : MIN_MOVE_GAP_MS;
    return { moves, holdMs, deferMs };
}

// ---------------------------------------------------------------------------
// Phase
// ---------------------------------------------------------------------------

/**
 * The build's chapter, read off the tool the model just called — never off
 * `builder_set_plan`, which is optional, so the film plays the same whether
 * or not a plan ever arrives.
 */
export function phaseFor(toolName: string | null | undefined) {
    switch (toolName) {
        case 'builder_summarise': return 'reviewing';
        case 'builder_request_dry_run': return 'testing';
        case 'builder_finalize': return 'finishing';
        default: return 'building';
    }
}

/** A tool call the server refused: the client keeps `{ name, arguments, result }`, and a refusal is `result.error`. */
export function isRefusedCall(tc: { name?: unknown; result?: unknown } | null | undefined) {
    const result = tc?.result;
    return !!(result && typeof result === 'object' && !Array.isArray(result) && (result as { error?: unknown }).error);
}

/**
 * The chapter of one assistant turn, from its tool calls so far.
 *
 * Read off the last call the server ACCEPTED, not the last call made: a
 * refused finalize, summarise or dry-run is not a chapter break — the model
 * reads the error and tries again — and treating it as one blanked every
 * reveal, dropped the ghost and cued a wide shot mid-build (the plan: never
 * on refusal). Skipping refusals rather than mapping them to `building`
 * also keeps a refused mutator after a summarise from re-opening the
 * building chapter it did not touch.
 *
 * `finalized` is whether THIS turn's finalize went through. The stream
 * state's `finalizedId` survives across turns, so the ending line must not
 * read it alone: a turn that edits an automation finalized last week and then
 * stops would otherwise sign off with "Built · n steps".
 */
export function chapterOf(toolCalls: { name?: unknown; result?: unknown }[] | null | undefined) {
    let lastAccepted: string | null = null;
    let finalized = false;
    for (const tc of Array.isArray(toolCalls) ? toolCalls : []) {
        if (!tc || typeof tc.name !== 'string' || isRefusedCall(tc)) continue;
        lastAccepted = tc.name;
        if (tc.name === 'builder_finalize') finalized = true;
    }
    return { phase: phaseFor(lastAccepted), finalized };
}
