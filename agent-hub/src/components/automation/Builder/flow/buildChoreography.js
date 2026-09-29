import { edgeKey } from './branchEdges';
import { flowOrder } from './flowOrder';
import { ROW_GAP } from './rowBands';
import { REVEAL_STAGGER_MS, REVEAL_STAGGER_MIN_MS, REVEAL_BUDGET_MS, MIN_MOVE_GAP_MS, revealSchedule, orderAdded } from '../../../shared/builder/revealSchedule';

/**
 * The build as a film — the pure half.
 *
 * While the AI builds a routine the server sends the WHOLE definition after
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

/**
 * Layout geometry the ghost slot and the camera reason about. The values are
 * `arrange.js DEFAULT_DIMS` (240×96), `dagreLayout.js DEFAULT_SPACING.ranksep`
 * (80) and `arrange.js DEFAULT_COLUMNS` (5), copied rather than imported
 * because `arrange.js` pulls in dagre and this module has to stay light
 * enough to run in a node test in milliseconds. Column pitch is card width +
 * rank gap; row pitch is card height + ROW_GAP.
 */
const CARD_W = 240;
const CARD_H = 96;
const RANK_SEP = 80;
const COLUMNS = 5;
export const COL_PITCH = CARD_W + RANK_SEP; // 320
export const ROW_PITCH = CARD_H + ROW_GAP; // 366

// Cadence constants, revealSchedule and orderAdded are shared with the App Studio
// editor (shared/builder/revealSchedule.js) and re-exported here unchanged.
export { REVEAL_STAGGER_MS, REVEAL_STAGGER_MIN_MS, REVEAL_BUDGET_MS, MIN_MOVE_GAP_MS, revealSchedule, orderAdded } from '../../../shared/builder/revealSchedule';

/** On a row wrap the wide shot has to be readable before the camera pushes back in. */
export const WRAP_HOLD_MS = 900;

/** Shot recipes, mirroring the fitView options the hook used before this module existed. */
const SHOTS = Object.freeze({
    push: Object.freeze({ padding: 0.15, minZoom: 0.85, maxZoom: 1, duration: 480 }),
    wide: Object.freeze({ padding: 0.12, minZoom: 0.2, maxZoom: 1, duration: 700 }),
});

/** The recipes as designed — presenterMode.js derives its projector set from these. */
export const DEFAULT_SHOTS = SHOTS;

// Presenter mode (flow/presenterMode.js) frames tighter — higher zoom floors,
// so the pushed-in cards are legible from the back of a room — without the
// choreography hook having to know: `shotFor` reads the ACTIVE set. Module-
// level on purpose (one canvas is ever choreographed at a time); `null`
// restores the defaults. The hook's own wide and mount fits (WIDE_SHOT /
// MOUNT_SHOT in useBuildChoreography.js) do not pass through shotFor and keep
// their floors.
let activeShots = SHOTS;

export function setActiveShots(next) {
    activeShots = (next && next.push && next.wide) ? next : SHOTS;
}

export function getActiveShots() {
    return activeShots;
}

/**
 * Below this zoom delta a `smooth` (zoom-out-then-in) interpolation looks like
 * a hiccup on a pan; above it a linear pan looks like the card slides under
 * the camera. Same threshold the hook applies to `setViewport`.
 */
const LINEAR_ZOOM_DELTA = 0.05;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

/** Every positionable node of a definition: trigger(s) first, then steps — the same roots `flowOrder` uses. */
function nodesOf(def) {
    const roots = [def?.trigger, ...(Array.isArray(def?.triggers) ? def.triggers : [])];
    const steps = Array.isArray(def?.steps) ? def.steps : [];
    const out = new Map();
    for (const n of [...roots, ...steps]) {
        if (n && n.id != null && !out.has(n.id)) out.set(n.id, n);
    }
    return out;
}

/**
 * Key-order-insensitive serialisation. The server re-serialises the whole
 * definition per draft, so two semantically equal steps can arrive with their
 * keys in a different order; a plain JSON.stringify would then flag every card
 * as "touched" on every tool call and the wash would never stop playing.
 */
function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** A step minus its `position`: a card that only moved was not edited. */
function contentOf(step) {
    if (!step || typeof step !== 'object') return stableStringify(step);
    const { position: _position, ...rest } = step;
    return stableStringify(rest);
}

function edgeKeysOf(def) {
    const out = new Set();
    for (const e of Array.isArray(def?.edges) ? def.edges : []) {
        if (e && e.from != null && e.to != null) out.add(edgeKey(e));
    }
    return out;
}

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
export function diffDefinitions(prev, next) {
    const before = nodesOf(prev);
    const after = nodesOf(next);

    const added = [];
    const seen = new Set();
    for (const id of flowOrder(next)) {
        if (!after.has(id) || seen.has(id)) continue;
        seen.add(id);
        if (!before.has(id)) added.push(id);
    }
    // flowOrder is total over the ids it indexes; this only guards against a
    // future change there silently dropping a card's reveal.
    for (const id of after.keys()) if (!seen.has(id) && !before.has(id)) added.push(id);

    const removed = [];
    for (const id of before.keys()) if (!after.has(id)) removed.push(id);

    const touched = [];
    for (const [id, step] of after) {
        if (!before.has(id)) continue;
        if (contentOf(before.get(id)) !== contentOf(step)) touched.push(id);
    }

    const prevEdges = edgeKeysOf(prev);
    const addedEdgeKeys = [];
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
export function nextSlotFor(frontierRect, { colWidth = COL_PITCH, cols = COLUMNS, rowPitch = ROW_PITCH } = {}) {
    const x = Number(frontierRect?.x) || 0;
    const y = Number(frontierRect?.y) || 0;
    // Round, not floor: a card is placed on the grid but a measured rect may
    // sit a fraction off it, and floor would then read column 4 as column 3.
    const col = Math.round(x / colWidth);
    if (col >= cols - 1) return { x: 0, y: y + rowPitch };
    return { x: x + colWidth, y };
}

function unionRect(rects) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of rects) {
        if (!r || !Number.isFinite(r.x) || !Number.isFinite(r.y)) continue;
        const w = Number.isFinite(r.width) ? r.width : 0;
        const h = Number.isFinite(r.height) ? r.height : 0;
        minX = Math.min(minX, r.x);
        minY = Math.min(minY, r.y);
        maxX = Math.max(maxX, r.x + w);
        maxY = Math.max(maxY, r.y + h);
    }
    if (!Number.isFinite(minX)) return null;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * React Flow's `parsePadding` for a numeric padding, verbatim
 * (`@xyflow/system parsePadding`): NOT `viewport × padding`. For 0.12 on a
 * 1100 px canvas this is 58 px a side (≈5.3 %), which is why a 6-card graph
 * lands at zoom 0.647 and not the 0.6 a naive 12 % would predict.
 */
function paddingPx(padding, viewportLength) {
    return Math.floor((viewportLength - viewportLength / (1 + padding)) * 0.5);
}

/**
 * `@xyflow/system getViewportForBounds` for a symmetric numeric padding,
 * re-implemented so the push-in can be computed from the layout's own rects
 * without waiting for measurement (`setViewport` is immediate; `fitView`
 * queues until nodes are initialised). Kept as a straight port so a wide shot
 * from here matches what `fitView` with the same options would produce.
 */
function viewportForBounds(bounds, size, { minZoom, maxZoom, padding }) {
    const { width, height } = size;
    const px = paddingPx(padding, width);
    const py = paddingPx(padding, height);
    const zoom = clamp(Math.min((width - 2 * px) / bounds.width, (height - 2 * py) / bounds.height), minZoom, maxZoom);
    const cx = bounds.x + bounds.width / 2;
    const cy = bounds.y + bounds.height / 2;
    let x = width / 2 - cx * zoom;
    let y = height / 2 - cy * zoom;
    // React Flow then nudges the view so no side ends up with less than the
    // requested padding (only matters with asymmetric paddings or a clamped
    // zoom); ported for fidelity.
    const applied = appliedPadding(bounds, { x, y, zoom }, size);
    x += -Math.min(applied.left - px, 0) + Math.min(applied.right - px, 0);
    y += -Math.min(applied.top - py, 0) + Math.min(applied.bottom - py, 0);
    return { x, y, zoom, px, py };
}

function appliedPadding(bounds, { x, y, zoom }, { width, height }) {
    return {
        left: Math.floor(bounds.x * zoom + x),
        top: Math.floor(bounds.y * zoom + y),
        right: Math.floor(width - ((bounds.x + bounds.width) * zoom + x)),
        bottom: Math.floor(height - ((bounds.y + bounds.height) * zoom + y)),
    };
}

/**
 * Shift a one-axis view offset so the flow interval [start, start + length)
 * sits inside the padded viewport (`{ length, pad }`, screen px), moving as
 * little as possible; used to keep a biased push-in honest.
 */
function keepInside(offset, { start, length }, zoom, view) {
    const lo = start * zoom + offset;
    const hi = (start + length) * zoom + offset;
    if (lo < view.pad) return offset + (view.pad - lo);
    if (hi > view.length - view.pad) return offset - (hi - (view.length - view.pad));
    return offset;
}

/**
 * The push-in's centre: 60 % the newest card, 40 % the frame, then clamped so
 * the bias only spends slack — when the whole frame fits it stays inside the
 * padding; when the zoom floor makes it overflow, at least the newest card
 * stays fully inside.
 */
function biasTowardNewest({ zoom, px, py }, frame, newest, { width, height }) {
    const nw = Number.isFinite(newest.width) ? newest.width : CARD_W;
    const nh = Number.isFinite(newest.height) ? newest.height : CARD_H;
    const cx = 0.4 * (frame.x + frame.width / 2) + 0.6 * (newest.x + nw / 2);
    const cy = 0.4 * (frame.y + frame.height / 2) + 0.6 * (newest.y + nh / 2);
    const fitsX = frame.width * zoom <= width - 2 * px;
    const fitsY = frame.height * zoom <= height - 2 * py;
    const spanX = fitsX ? { start: frame.x, length: frame.width } : { start: newest.x, length: nw };
    const spanY = fitsY ? { start: frame.y, length: frame.height } : { start: newest.y, length: nh };
    return {
        x: keepInside(width / 2 - cx * zoom, spanX, zoom, { length: width, pad: px }),
        y: keepInside(height / 2 - cy * zoom, spanY, zoom, { length: height, pad: py }),
    };
}

/**
 * React Flow's 'smooth' interpolation zooms out and back in; on a pan whose
 * zoom barely changes that reads as a hiccup, so such a move goes linear.
 */
function interpolateFor(kind, zoom, current) {
    const currentZoom = Number(current?.zoom);
    if (kind === 'wide' || !Number.isFinite(currentZoom)) return 'smooth';
    return Math.abs(zoom - currentZoom) < LINEAR_ZOOM_DELTA ? 'linear' : 'smooth';
}

/**
 * One camera shot.
 *
 *   push — frames the union of `rects` plus the ghost slot at near LOD
 *          (minZoom 0.85, so the summary line is legible) and biases the centre
 *          60/40 toward the LAST rect, the newest card: the eye should land on
 *          what just arrived, not on the middle of the frame. The bias never
 *          pushes that card out of the padded frame.
 *   wide — the chapter-break fit, identical to `fitView({padding: 0.12,
 *          minZoom: 0.2, maxZoom: 1})` over cards + ghost.
 *
 * `interpolate` is 'smooth' (React Flow's zoom-out-and-in) unless the zoom
 * barely changes, when a linear pan reads better. Returns null when there is
 * nothing to frame or no viewport to frame it in.
 */
export function shotFor({ kind = 'push', rects, ghostRect, viewport, current } = {}) {
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

/** `{ width, height }` when there is a viewport to frame in, else null. */
function viewportSize(viewport) {
    const width = Number(viewport?.width) || 0;
    const height = Number(viewport?.height) || 0;
    return width > 0 && height > 0 ? { width, height } : null;
}

/** The union of cards and ghost, or null when there is nothing with area to frame. */
function frameOf(cards, ghostRect) {
    const frame = unionRect([...cards, ghostRect]);
    return frame && frame.width > 0 && frame.height > 0 ? frame : null;
}

/** A rect with a usable position, else null — the newest card may be missing on a wide shot. */
function placedRect(rect) {
    return rect && Number.isFinite(rect.x) && Number.isFinite(rect.y) ? rect : null;
}

/**
 * Is `rect` (flow coordinates) fully on screen under `viewport`, with `margin`
 * px to spare on every side? A chain growing inside the frame must not move
 * the camera; this is the test that keeps it still.
 */
export function isRectInView(rect, viewport, size, margin = 48) {
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

/** Reasons that earn a push-in: something new arrived next to the frontier. */
const PUSH_REASONS = new Set(['arrival']);
/**
 * A burst of at least this many cards closes on one wide shot (`burst_end`)
 * once its last card has departed. Two cards are a pair, not a chapter — the
 * push-ins already framed both.
 */
export const BURST_WIDE_MIN = 3;
/**
 * Chapter breaks: the whole shape changed or a chapter ended, so the audience
 * gets the wide shot. Nothing else moves the camera — an update on screen, a
 * refused call, a plain re-send are silent by design. `burst` is gone from
 * this list on purpose: a batch used to earn ONE wide shot at t≈0, while every
 * card was still invisible, and the camera then sat on an empty frame for the
 * whole reveal. A burst is now dealt card by card (each landing is an
 * `arrival`) and the wide shot comes at the END.
 */
const WIDE_REASONS = new Set(['wrap', 'burst_end', 'remove', 'replace', 'move', 'summarise', 'dry_run', 'finalize', 'end', 'resume']);

/**
 * Decide whether — and how — the camera moves for one event.
 *
 * Returns null when the camera must stay put: the presenter has taken it
 * (`following` false — it stays theirs until they press Follow) or the reason
 * is not one the film cuts on. Otherwise:
 *
 *   moves   — ['push'], ['wide'], or ['wide', 'push'] on a row wrap (the wide
 *             shot shows the new row, then the camera comes back in on its
 *             first card; a single fit on the pair would crop it).
 *   holdMs  — the gap to keep between the moves of this plan, and before any
 *             later one: WRAP_HOLD_MS on a wrap, otherwise MIN_MOVE_GAP_MS.
 *   deferMs — how long to wait before the FIRST move so that two moves are
 *             never closer than MIN_MOVE_GAP_MS; 0 when the hold has elapsed.
 */
export function planCameraMove({ reason, following = true, lastMoveAt = null, now = 0, rowWrapped = false } = {}) {
    if (following === false) return null;
    const moves = movesFor(reason, rowWrapped);
    if (!moves) return null;

    const since = Number.isFinite(lastMoveAt) && Number.isFinite(now) ? now - lastMoveAt : Infinity;
    const deferMs = since < MIN_MOVE_GAP_MS ? Math.ceil(MIN_MOVE_GAP_MS - since) : 0;
    const holdMs = moves.length > 1 ? WRAP_HOLD_MS : MIN_MOVE_GAP_MS;
    return { moves, holdMs, deferMs };
}

function movesFor(reason, rowWrapped) {
    const isPush = PUSH_REASONS.has(reason);
    const isWide = WIDE_REASONS.has(reason);
    if (!isPush && !isWide) return null;
    if (rowWrapped || reason === 'wrap') return ['wide', 'push'];
    return isPush ? ['push'] : ['wide'];
}

// ---------------------------------------------------------------------------
// Phase
// ---------------------------------------------------------------------------

/**
 * The build's chapter, read off the tool the model just called — never off
 * `builder_set_plan`, which is optional, so the film plays the same whether
 * or not a plan ever arrives.
 */
export function phaseFor(toolName) {
    switch (toolName) {
        case 'builder_summarise': return 'reviewing';
        case 'builder_request_dry_run': return 'testing';
        case 'builder_finalize': return 'finishing';
        default: return 'building';
    }
}

/** A tool call the server refused: the client keeps `{ name, arguments, result }`, and a refusal is `result.error`. */
export function isRefusedCall(tc) {
    const result = tc?.result;
    return !!(result && typeof result === 'object' && !Array.isArray(result) && result.error);
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
 * read it alone: a turn that edits a routine finalized last week and then
 * stops would otherwise sign off with "Built · n steps".
 */
export function chapterOf(toolCalls) {
    let lastAccepted = null;
    let finalized = false;
    for (const tc of Array.isArray(toolCalls) ? toolCalls : []) {
        if (!tc || typeof tc.name !== 'string' || isRefusedCall(tc)) continue;
        lastAccepted = tc.name;
        if (tc.name === 'builder_finalize') finalized = true;
    }
    return { phase: phaseFor(lastAccepted), finalized };
}
