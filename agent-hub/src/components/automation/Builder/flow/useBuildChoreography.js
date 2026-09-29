import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';

import { edgeKey } from './branchEdges';
import {
    diffDefinitions, revealSchedule, orderAdded, nextSlotFor, shotFor, isRectInView, planCameraMove,
    ROW_PITCH, MIN_MOVE_GAP_MS, BURST_WIDE_MIN, getActiveShots,
} from './buildChoreography';
import { flowOrder } from './flowOrder';
import { projectGhostDraft } from './ghostDraft';

/**
 * The build as a film — the stateful half (the pure half is
 * buildChoreography.js; the look is the bf-* rules in index.css).
 *
 * Called from DiagramPaneInner in the place of the old "follow the build"
 * effect. While the AI holds the canvas it turns each new draft into
 * presentation FLAGS — fresh cards with a reveal delay, touched cards, fresh
 * edge keys, one frontier id — plus a ghost slot ahead of the frontier and a
 * camera plan. The canvas keeps rendering the LIVE draft throughout; nothing
 * here can drift from the truth because nothing here changes what is drawn,
 * only when it becomes visible and where the camera looks.
 *
 * Why the diff runs during render and not in an effect: a card's
 * `data-build="fresh"` must be on it in the SAME commit the card first
 * appears. An effect would paint the card at full opacity for one frame and
 * then snap it to the animation's invisible `from` frame — the flash the
 * whole choreography exists to avoid. So the previous definition is state
 * (React's "adjust state when a prop changes" pattern), the diff is applied
 * before children render, and the camera consumes the resulting event from an
 * effect afterwards, where React Flow calls belong.
 *
 * Why the camera yields to the user and never comes back on its own: the
 * owner decided it (2026-09-10). Any `onMoveStart` while we are not moving
 * ourselves is the user — that deliberately includes the zoom-stack buttons
 * and the minimap, whose events arrive as null exactly like ours, which is
 * what `cameraOwnedRef` is for. A camera that resumes on a timer while the
 * presenter is pointing at something is the classic haunted demo; Follow (the
 * build banner) and Fit (the zoom stack) hand it back.
 *
 * With the OS "reduce motion" setting on, none of this runs: the old effect
 * is reproduced verbatim (count-keyed fitView, two frames after the change)
 * and no flag, ghost or push-in is ever issued.
 */

/** How long a fresh/touched flag lives past its reveal delay — the reveal settles at ≈1.0 s. */
export const FLAG_TTL_MS = 1400;

/** Layout box of a card (arrange.js DEFAULT_DIMS); the ghost is placed on the same grid. */
const CARD_W = 240;
const CARD_H = 96;

export const GHOST_ID = '__ghost__';
export const GHOST_EDGE_ID = '__ghost_edge__';

/**
 * React Flow's own fit-on-mount is a programmatic move too, and it fires
 * onMoveStart with a null event a frame or two after the canvas mounts. Owning
 * the camera for this long after a mount keeps that from reading as the
 * presenter taking over before anything has happened.
 */
const MOUNT_GRACE_MS = 1500;
/** Ownership outlasts a move by this much: d3 fires the last event a frame after the duration ends. */
const OWN_SLACK_MS = 80;

/** The chapter-break shot; identical to the pure module's `wide` recipe. */
const WIDE_SHOT = Object.freeze({ padding: 0.12, minZoom: 0.2, maxZoom: 1, duration: 700, interpolate: 'smooth' });
/** Today's follow-the-build fit, kept for the mount frame and reduced motion. */
const MOUNT_SHOT = Object.freeze({ padding: 0.12, duration: 260, minZoom: 0.2, maxZoom: 1 });
const CENTER_DURATION_MS = 300;
/** A resize is a drag of a splitter or a panel animating: wait for it to stop. */
const RESIZE_SETTLE_MS = 220;

const NO_NODES = Object.freeze([]);

/**
 * The flag state. `byId` and `edgeKeys` are Maps rebuilt on every change so
 * consumers can memo on their identity; `event` is what the camera effect
 * keys on — a new object per applied diff (and per queue advance), null when
 * a diff changed nothing.
 *
 * `pending` is the burst queue: every card after the head of the current
 * burst, with the instant its turn BEGINS. The flags alone cannot drive the
 * frontier or the camera — a card's reveal delay is a CSS `animation-delay`
 * nobody can observe from here — so the queue is what advances the frontier
 * one card at a time, cues a push-in per landing, and tells the ribbon flight
 * (useRibbonFlight) when each ghost departs. `head` is the burst's first card
 * with its departure instant (it is not in `pending`); `burst` its size.
 */
const EMPTY = Object.freeze({
    byId: new Map(),
    edgeKeys: new Map(),
    frontierId: null,
    ghostHidden: false,
    pending: Object.freeze([]),
    head: null,
    burst: 0,
    event: null,
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function expiryOf(entry) {
    return (entry.touchedAt ?? entry.at) + FLAG_TTL_MS + (entry.delayMs || 0);
}

function nextExpiry(fx) {
    let min = Infinity;
    for (const entry of fx.byId.values()) min = Math.min(min, expiryOf(entry));
    for (const at of fx.edgeKeys.values()) min = Math.min(min, at);
    return Number.isFinite(min) ? min : null;
}

/** When the next queued card's turn begins, or null with an empty queue. */
function nextDue(pending) {
    let min = Infinity;
    for (const p of pending) if (Number.isFinite(p?.at)) min = Math.min(min, p.at);
    return Number.isFinite(min) ? min : null;
}

/** Drop every flag whose time is up; the same object back when nothing expired. */
function prune(fx, now) {
    let changed = false;
    const byId = new Map();
    for (const [id, entry] of fx.byId) {
        if (expiryOf(entry) <= now) changed = true;
        else byId.set(id, entry);
    }
    const edgeKeys = new Map();
    for (const [key, at] of fx.edgeKeys) {
        if (at <= now) changed = true;
        else edgeKeys.set(key, at);
    }
    return changed ? { ...fx, byId, edgeKeys } : fx;
}

/** A node's absolute layout rect (parents added back on), or null. */
function rectOf(nodes, id) {
    if (!id || !Array.isArray(nodes)) return null;
    const byId = new Map();
    for (const n of nodes) if (n?.id != null) byId.set(n.id, n);
    const node = byId.get(id);
    if (!node?.position) return null;
    let { x, y } = node.position;
    let parent = node.parentId;
    // Bounded: a malformed parent chain must not hang the render.
    for (let hops = 0; parent && hops < 16; hops += 1) {
        const p = byId.get(parent);
        if (!p?.position) break;
        x += p.position.x;
        y += p.position.y;
        parent = p.parentId;
    }
    return {
        x, y,
        width: node.width ?? node.measured?.width ?? CARD_W,
        height: node.height ?? node.measured?.height ?? CARD_H,
    };
}

/** Every placed card as one rect — what a wide shot frames when we frame it ourselves. */
function unionOfNodes(nodes) {
    let out = null;
    for (const n of Array.isArray(nodes) ? nodes : []) {
        const r = rectOf(nodes, n?.id);
        if (!r) continue;
        out = out ? {
            x: Math.min(out.x, r.x),
            y: Math.min(out.y, r.y),
            width: Math.max(out.x + out.width, r.x + r.width) - Math.min(out.x, r.x),
            height: Math.max(out.y + out.height, r.y + r.height) - Math.min(out.y, r.y),
        } : { ...r };
    }
    return out && out.width > 0 && out.height > 0 ? out : null;
}

const rowOf = (rect) => (rect ? Math.round(rect.y / ROW_PITCH) : null);

function predecessorOf(definition, id) {
    if (!id) return null;
    for (const e of Array.isArray(definition?.edges) ? definition.edges : []) {
        if (e && e.to === id && e.from) return e.from;
    }
    return null;
}

function lastInFlow(definition) {
    const order = flowOrder(definition);
    return order.length ? order[order.length - 1] : (definition?.trigger?.id ?? null);
}

/** The ghost's caption: the narrated thought, else the first open todo, else null (the node renders its own default). */
function captionFor(cue) {
    const narration = typeof cue?.narration === 'string' ? cue.narration.trim() : '';
    if (narration) return narration;
    const todos = Array.isArray(cue?.todos) ? cue.todos : [];
    const todo = todos.find(t => t && !t.done && typeof t.text === 'string' && t.text.trim());
    return todo ? todo.text.trim() : null;
}

/**
 * Which camera cut a diff earns. An addition is a push-in on its head (the
 * queue cues one per later card as it is dealt); a replace is a chapter
 * break; an update moves nothing unless the card is off-screen, which the
 * effect checks with the live viewport.
 */
function reasonFor(diff) {
    const { added, removed, touched } = diff;
    if (added.length) return removed.length ? 'replace' : 'arrival';
    if (removed.length) return 'remove';
    if (touched.length) return 'touched';
    return 'update';
}

/**
 * Fold one draft's diff into the flag state. Returns the same object when the
 * diff is empty — a refused call re-sends an identical definition, and that
 * must not re-render a single card.
 *
 * `orderHint` is the burst order the model itself reported (the ids of
 * `result.added`, see chat/toolCallDisplay.addedStepsOf); `flightMs` is how
 * long a ghost takes to fly from the ribbon to the card's slot. A card's
 * reveal delay is its DEPARTURE (the schedule) plus the flight, so the card
 * materialises the moment the ghost lands on it, never before.
 */
function applyDiff(fx, diff, { definition, nodes, now, orderHint = null, flightMs = 0 }) {
    const { added, removed, touched, addedEdgeKeys } = diff;
    if (!added.length && !removed.length && !touched.length && !addedEdgeKeys.length) return fx;

    const ids = orderAdded(added, orderHint);
    const schedule = revealSchedule(ids);
    const flight = Math.max(0, Number(flightMs) || 0);
    const delayOf = (id) => (schedule.has(id) ? schedule.get(id).delayMs + flight : 0);

    const byId = new Map(fx.byId);
    for (const id of ids) byId.set(id, { kind: 'fresh', delayMs: delayOf(id), at: now });
    for (const id of removed) byId.delete(id);
    for (const id of touched) {
        if (schedule.has(id)) continue;
        const cur = byId.get(id);
        // Mid-reveal the summary line is already wiping in; re-flagging it as
        // touched would restart that wipe halfway and read as a stutter.
        if (cur?.kind === 'fresh' && expiryOf(cur) > now) continue;
        byId.set(id, { kind: 'touched', delayMs: 0, at: cur?.at ?? now, touchedAt: now });
    }

    // A fresh edge draws in at its TARGET card's delay (flight included), so
    // in a burst each line arrives just ahead of the card it leads to.
    const edgeKeys = new Map(fx.edgeKeys);
    const wanted = new Set(addedEdgeKeys);
    for (const e of Array.isArray(definition?.edges) ? definition.edges : []) {
        if (!e || e.from == null || e.to == null) continue;
        const key = edgeKey(e);
        if (!wanted.has(key)) continue;
        edgeKeys.set(key, now + FLAG_TTL_MS + delayOf(e.to));
    }

    // The queue: every card after the head, with the instant its turn begins.
    // A removal takes its card out of the queue too — a slot nobody will fill
    // must not keep advancing the frontier onto it. A queue still running
    // when the next diff lands is kept: its cards are already flagged with
    // their delays and still owe the film their landings.
    const removedSet = new Set(removed);
    const carried = fx.pending.filter(p => !removedSet.has(p.id));
    const pending = ids.length
        ? [...carried, ...ids.slice(1).map(id => ({ id, at: now + schedule.get(id).delayMs }))]
        : carried;

    let frontierId = fx.frontierId;
    if (ids.length) {
        // The HEAD of the burst, not its last card: the frontier walks the
        // burst as the queue is dealt, so the ghost slot hops ahead of the
        // card that is landing rather than pointing past six invisible ones.
        frontierId = ids[0];
    } else if (touched.length && !pending.length) {
        // An update only moves the frontier when it lands on the very last
        // card: editing step 2 of 7 is not "the AI is now at step 2". While a
        // queue is still being dealt the queue owns the frontier — the last
        // card in flow is one the audience has not seen yet.
        const last = lastInFlow(definition);
        if (touched.includes(last)) frontierId = last;
    }
    if (frontierId && removedSet.has(frontierId)) frontierId = null;

    const prevFrontierRect = rectOf(nodes, fx.frontierId ?? predecessorOf(definition, frontierId));
    const newRect = ids.length ? rectOf(nodes, frontierId) : null;
    const rowWrapped = !!(newRect && prevFrontierRect && rowOf(newRect) !== rowOf(prevFrontierRect));

    return {
        byId,
        edgeKeys,
        frontierId,
        // The slot ahead of the frontier promises "the next card lands here".
        // After a removal or replace that promise is void until the AI adds
        // again, so the ghost steps away rather than pointing at a guess.
        ghostHidden: removed.length ? true : (ids.length ? false : fx.ghostHidden),
        pending,
        head: ids.length ? { id: ids[0], at: now } : fx.head,
        burst: ids.length ? ids.length : fx.burst,
        event: {
            seq: (fx.event?.seq || 0) + 1,
            reason: reasonFor(diff),
            rowWrapped,
            touched: touched.length ? touched[touched.length - 1] : null,
            at: now,
            burst: ids.length,
        },
    };
}

/**
 * Deal the next card(s) of the burst: every queued entry whose time has come
 * leaves the queue, the frontier moves to the last of them, and the camera
 * gets an `arrival` — or, when this emptied a burst of BURST_WIDE_MIN or more,
 * a `burst_end`, the one wide shot that closes the chapter (planCameraMove
 * already spaces it MIN_MOVE_GAP_MS from the last push). The same object back
 * when nothing was due, so a stray timer re-renders nothing.
 */
function advance(fx, now, nodes) {
    const due = fx.pending.filter(p => p.at <= now);
    if (!due.length) return fx;
    const pending = fx.pending.filter(p => p.at > now);
    const frontierId = due[due.length - 1].id;
    const prevRect = rectOf(nodes, fx.frontierId);
    const newRect = rectOf(nodes, frontierId);
    const rowWrapped = !!(newRect && prevRect && rowOf(newRect) !== rowOf(prevRect));
    const drained = pending.length === 0;
    return {
        ...fx,
        pending,
        frontierId,
        event: {
            seq: (fx.event?.seq || 0) + 1,
            reason: drained && fx.burst >= BURST_WIDE_MIN ? 'burst_end' : 'arrival',
            rowWrapped,
            touched: null,
            at: now,
            burst: fx.burst,
        },
    };
}

/** Two camera plans due at the same instant collapse into the wider one. */
function mergeMoves(a, b) {
    if (!a) return b;
    if (!b) return a;
    if (a.length > 1 || b.length > 1) return ['wide', 'push'];
    if (a.includes('wide') || b.includes('wide')) return ['wide'];
    if (a.includes('push') || b.includes('push')) return ['push'];
    return a;
}

/**
 * The canvas the camera may use: its box, minus a strip along the left that
 * something is drawn OVER (the plan panel lives inside the canvas now). The
 * strip is refused when it would leave less than a card and a half to frame
 * in — a narrow canvas is better off framing behind the panel than not at all.
 */
const MIN_FRAMEABLE_PX = 360;
function sizeOf(wrapperRef, insetLeft = 0) {
    const box = wrapperRef?.current?.getBoundingClientRect?.();
    const width = Number(box?.width) || 0;
    const height = Number(box?.height) || 0;
    if (!(width > 0 && height > 0)) return null;
    const wanted = Math.max(0, Number(insetLeft) || 0);
    const offsetX = width - wanted >= MIN_FRAMEABLE_PX ? wanted : 0;
    return { width: width - offsetX, height, offsetX };
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

export function useBuildChoreography({
    definition,
    computedNodes,
    edges,
    structuralEditsBlocked,
    buildCue = null,
    rf,
    wrapperRef,
    reducedMotion = false,
    runInFlight = false,
    // The ids of the last tool call's `result.added`, in the model's order
    // (BuildTab → buildCue.lastCall.added → DiagramPane). Null: flowOrder.
    orderHint = null,
    // How long a ghost flies from the ribbon to a card's slot; 0 when no
    // ribbon is on screen to fly from (a read-only canvas, reduced motion).
    flightMs = 0,
    // Pixels along the canvas's left edge that are covered by something drawn
    // over it — the plan panel. Every shot frames in what is LEFT of it, so a
    // card never lands behind the panel.
    cameraInsetLeft = 0,
    // For the card being drawn (buildCue.toolDraft → flow/ghostDraft.js):
    // the tool catalog names the app, `t` the kind and the captions.
    catalog = null,
    t = null,
}) {
    const blocked = !!structuralEditsBlocked;
    const phase = buildCue?.phase || 'building';
    // Flags, ghost and camera exist only while the AI is BUILDING. A dry run
    // mid-build hands the canvas to the run vocabulary (cards breathe, edges
    // dash); summarise and finalize are chapter ends, not more cards.
    const active = blocked && !reducedMotion && phase === 'building' && !runInFlight;

    const [fx, setFx] = useState(EMPTY);
    const [prevDef, setPrevDef] = useState(definition);
    const [following, setFollowing] = useState(true);

    // ── Diff, during render ─────────────────────────────────────────────
    if (definition !== prevDef) {
        setPrevDef(definition);
        if (active) {
            const now = Date.now();
            const next = applyDiff(fx, diffDefinitions(prevDef, definition), { definition, nodes: computedNodes, now, orderHint, flightMs });
            if (next !== fx) {
                // The trigger arriving is the canvas mounting (DiagramPaneInner
                // shows the empty state until then): React Flow fits on its own
                // that frame, so the film opens on a wide, not a push.
                setFx(!prevDef?.trigger && definition?.trigger
                    ? { ...next, event: { ...next.event, reason: 'mount' } }
                    : next);
            }
        }
    }
    if (!active && fx !== EMPTY) setFx(EMPTY);

    // ── Everything the timers read, one commit behind at most ───────────
    const latestRef = useRef({});
    useEffect(() => {
        latestRef.current = { rf, wrapperRef, computedNodes, definition, fx, blocked, active, reducedMotion, orderHint, cameraInsetLeft };
    });

    // ── Camera plumbing ─────────────────────────────────────────────────
    const followingRef = useRef(true);
    const cameraOwnedRef = useRef(false);
    const ownTimerRef = useRef(null);
    const ownUntilRef = useRef(0);
    const lastMoveAtRef = useRef(null);
    const timersRef = useRef(new Set());
    const pendingRef = useRef(null);

    const setFollow = useCallback((value) => {
        followingRef.current = value;
        setFollowing(value);
    }, []);

    const cancelPending = useCallback(() => {
        for (const id of timersRef.current) clearTimeout(id);
        timersRef.current.clear();
        pendingRef.current = null;
    }, []);

    const later = useCallback((fn, ms) => {
        const id = setTimeout(() => {
            timersRef.current.delete(id);
            fn();
        }, Math.max(0, ms));
        timersRef.current.add(id);
        return id;
    }, []);

    // Ownership only ever EXTENDS: a short push scheduled inside the mount
    // grace must not release the camera before React Flow's own fit-on-mount
    // has fired its onMoveStart.
    const ownCamera = useCallback((ms) => {
        const until = Date.now() + ms;
        cameraOwnedRef.current = true;
        if (until <= ownUntilRef.current) return;
        ownUntilRef.current = until;
        if (ownTimerRef.current) clearTimeout(ownTimerRef.current);
        ownTimerRef.current = setTimeout(() => {
            ownTimerRef.current = null;
            ownUntilRef.current = 0;
            cameraOwnedRef.current = false;
        }, ms);
    }, []);

    /**
     * Execute one shot NOW, from the latest state. Returns whether the camera
     * moved. Every React Flow call is guarded: the canvas may have unmounted
     * between the plan and the timer.
     */
    const runShot = useCallback((kind) => {
        const { rf: flow, wrapperRef: wrap, computedNodes: nodes, definition: def, fx: state, cameraInsetLeft: inset } = latestRef.current;
        if (!followingRef.current || !flow || typeof flow.getViewport !== 'function') return false;
        try {
            const size = sizeOf(wrap, inset);
            const current = flow.getViewport();
            if (kind === 'wide' || kind === 'mount') {
                // Presenter mode lifts the wide shot's zoom floor (flow/presenterMode.js
                // → setActiveShots) so a beamer never gets unreadable cards; the
                // mount fit keeps its own floor.
                const shot = kind === 'wide' ? { ...WIDE_SHOT, minZoom: getActiveShots().wide?.minZoom ?? WIDE_SHOT.minZoom } : MOUNT_SHOT;
                // A mount fit lands whenever React Flow finishes measuring, not
                // at `duration` — hold the camera long enough to cover that.
                ownCamera(kind === 'mount' ? MOUNT_GRACE_MS : shot.duration + OWN_SLACK_MS);
                // With a strip of canvas covered, React Flow's own fitView would
                // centre the graph under the panel: frame it ourselves in what
                // is left. Without one, nothing changes — fitView as before.
                const wideRect = size?.offsetX ? unionOfNodes(nodes) : null;
                if (wideRect && current) {
                    const framed = shotFor({ kind: 'wide', rects: [wideRect], viewport: size, current });
                    if (framed) flow.setViewport({ x: framed.x + size.offsetX, y: framed.y, zoom: framed.zoom }, { duration: shot.duration, interpolate: framed.interpolate });
                    else flow.fitView(shot);
                } else {
                    flow.fitView(shot);
                }
                lastMoveAtRef.current = Date.now();
                return true;
            }
            if (!size || !current) return false;
            if (kind === 'push') {
                const newRect = rectOf(nodes, state.frontierId);
                // A chain growing inside the frame does not move the camera.
                if (!newRect || isRectInView(newRect, current, size)) return false;
                const predRect = rectOf(nodes, predecessorOf(def, state.frontierId));
                const ghostRect = { ...nextSlotFor(newRect), width: CARD_W, height: CARD_H };
                const shot = shotFor({ kind: 'push', rects: predRect ? [predRect, newRect] : [newRect], ghostRect, viewport: size, current });
                if (!shot) return false;
                ownCamera(shot.duration + OWN_SLACK_MS);
                flow.setViewport({ x: shot.x + size.offsetX, y: shot.y, zoom: shot.zoom }, { duration: shot.duration, interpolate: shot.interpolate });
                lastMoveAtRef.current = Date.now();
                return true;
            }
            if (kind === 'center') {
                const rect = rectOf(nodes, state.event?.touched);
                if (!rect || isRectInView(rect, current, size)) return false;
                ownCamera(CENTER_DURATION_MS + OWN_SLACK_MS);
                // The presenter's zoom stays: jumping the scale as well as the
                // position mid-build is disorienting. setCenter aims at the
                // middle of the WHOLE canvas, so a covered strip shifts the
                // aim half its width to the left.
                const zoomNow = current.zoom || 1;
                flow.setCenter(
                    rect.x + rect.width / 2 - (size.offsetX / 2) / zoomNow,
                    rect.y + rect.height / 2,
                    { duration: CENTER_DURATION_MS, zoom: current.zoom },
                );
                lastMoveAtRef.current = Date.now();
                return true;
            }
        } catch {
            // canvas gone
        }
        return false;
    }, [ownCamera]);

    /**
     * Queue a plan. A plan already waiting for the same instant merges into
     * this one (the wider shot wins) — three arrivals inside one hold become
     * one move, framed at fire time so it shows the NEWEST card.
     */
    const schedule = useCallback((moves, deferMs, holdMs) => {
        const merged = mergeMoves(pendingRef.current?.moves ?? null, moves);
        cancelPending();
        const plan = { moves: merged, holdMs };
        pendingRef.current = plan;
        later(() => {
            if (pendingRef.current === plan) pendingRef.current = null;
            const [first, second] = plan.moves;
            const moved = runShot(first);
            if (second) {
                // The push after a wrap's wide stays a pending plan while it
                // waits, so an arrival in the hold merges into it instead of
                // cancelling it. It skips the hold when the wide was a no-op —
                // there is nothing to let settle.
                const rest = { moves: [second], holdMs };
                pendingRef.current = rest;
                later(() => {
                    if (pendingRef.current === rest) pendingRef.current = null;
                    runShot(second);
                }, moved ? holdMs : 0);
            }
        }, deferMs);
    }, [cancelPending, later, runShot]);

    // ── Camera: one event per applied diff ──────────────────────────────
    useEffect(() => {
        const ev = fx.event;
        if (!ev || !followingRef.current) return;
        const now = Date.now();
        if (ev.reason === 'mount') {
            // Own the camera NOW, not inside the shot's timer. React Flow's own
            // fit-on-mount fires from the ResizeObserver's first delivery — a
            // rendering step that can run before a 0 ms timer task — and its
            // onMoveStart(null) would then read as the presenter taking the
            // camera before a single card had landed. This effect runs in the
            // same passive flush in which NodeWrapper calls observe(), so it
            // is guaranteed to precede that callback; the timer keeps only
            // the shot itself.
            ownCamera(MOUNT_GRACE_MS);
            schedule(['mount'], 0, 0);
            return;
        }
        if (ev.reason === 'touched') {
            // planCameraMove is right to return null for an update — the
            // exception is a card the audience cannot see, and that check
            // needs the live viewport, so it happens at fire time (runShot).
            const since = lastMoveAtRef.current == null ? Infinity : now - lastMoveAtRef.current;
            schedule(['center'], since < MIN_MOVE_GAP_MS ? MIN_MOVE_GAP_MS - since : 0, 0);
            return;
        }
        const plan = planCameraMove({
            reason: ev.reason,
            following: followingRef.current,
            lastMoveAt: lastMoveAtRef.current,
            now,
            rowWrapped: ev.rowWrapped,
        });
        if (plan) schedule(plan.moves, plan.deferMs, plan.holdMs);
    }, [fx.event, schedule, ownCamera]);

    // ── Camera: chapter breaks read off the phase ───────────────────────
    const prevPhaseRef = useRef(phase);
    useEffect(() => {
        const was = prevPhaseRef.current;
        prevPhaseRef.current = phase;
        if (was === phase || !blocked || reducedMotion) return;
        // Summarise and finalize close a chapter with the whole routine in
        // frame. A dry run keeps the camera still: the run vocabulary owns
        // the canvas then, and its own banner says where the run is.
        const reason = phase === 'reviewing' ? 'summarise' : phase === 'finishing' ? 'finalize' : null;
        if (!reason) return;
        const plan = planCameraMove({ reason, following: followingRef.current, lastMoveAt: lastMoveAtRef.current, now: Date.now() });
        if (plan) schedule(plan.moves, plan.deferMs, plan.holdMs);
    }, [phase, blocked, reducedMotion, schedule]);

    // ── A build starting and ending ─────────────────────────────────────
    const prevBlockedRef = useRef(blocked);
    useEffect(() => {
        const was = prevBlockedRef.current;
        prevBlockedRef.current = blocked;
        if (was === blocked) return;
        cancelPending();
        if (reducedMotion) return;
        if (blocked) {
            // A new build gets the camera back even if the presenter held it
            // through the last one — the film starts over.
            setFollow(true);
            lastMoveAtRef.current = null;
            runShot('wide');
        } else {
            // The closing shot: the whole routine, once, unless the camera is
            // theirs. Nothing moves after this.
            runShot('wide');
        }
    }, [blocked, reducedMotion, cancelPending, setFollow, runShot]);

    // React Flow's fit-on-mount fires onMoveStart like any other move. If this
    // hook mounts with a trigger already in the draft (a scope remount
    // mid-build), that fit must not read as the presenter taking over.
    const graceOnMount = useEffectEvent(() => { if (definition?.trigger) ownCamera(MOUNT_GRACE_MS); });
    useEffect(() => { graceOnMount(); }, []);

    // ── Yield ───────────────────────────────────────────────────────────
    const onMoveStart = useCallback(() => {
        // Under reduced motion nothing here owns the camera — the count-keyed
        // fit below is a plain programmatic move, and React Flow reports those
        // through onMoveStart(null) exactly like a wheel tick. Reading it as
        // the presenter would put a "Follow the build" button on the banner
        // whose only effect is an animated shot, with the OS asking for none.
        if (latestRef.current.reducedMotion) return;
        if (cameraOwnedRef.current || !followingRef.current || !latestRef.current.blocked) return;
        setFollow(false);
        cancelPending();
    }, [setFollow, cancelPending]);

    // Ownership is released on a timer (duration + slack), not here: d3
    // reports the end of a transition before its last frame is painted, and a
    // wheel tick in that gap would otherwise be read as ours.
    const onMoveEnd = useCallback(() => {}, []);

    const resumeFollow = useCallback(() => {
        setFollow(true);
        cancelPending();
        // The hand-back's wide shot belongs to the film: outside a build there
        // is nothing to follow (the Fit button then fits on its own), and under
        // reduced motion a 700 ms smooth move is exactly what was asked away.
        const { blocked: building, reducedMotion: reduced } = latestRef.current;
        if (!building || reduced) return;
        runShot('wide');
    }, [setFollow, cancelPending, runShot]);

    // ── Pruning: flags die by time, never by a later draft ──────────────
    useEffect(() => {
        const at = nextExpiry(fx);
        if (at == null) return undefined;
        const id = setTimeout(() => setFx(cur => prune(cur, Date.now())), Math.max(0, at - Date.now()));
        return () => clearTimeout(id);
    }, [fx]);

    // ── Dealing the burst: the frontier walks the queue, one card a turn ──
    // Re-armed from `fx` identity exactly like the prune timer, so a
    // StrictMode remount (effect → cleanup → effect) drops nothing: the
    // cleanup clears the timer and the re-run arms it again from the same
    // queue. The abort path (`!active → EMPTY`) empties the queue and the
    // cleanup takes the pending timer with it, so no landing is cued on a
    // canvas the user already has back.
    useEffect(() => {
        const at = nextDue(fx.pending);
        if (at == null) return undefined;
        const id = setTimeout(() => {
            // `now` is read when the timer FIRES, not inside the updater: React
            // may run an updater eagerly or at commit, and which cards count as
            // due must not depend on that.
            const now = Date.now();
            const nodes = latestRef.current.computedNodes;
            setFx(cur => advance(cur, now, nodes));
        }, Math.max(0, at - Date.now()));
        return () => clearTimeout(id);
    }, [fx]);

    // ── The canvas changed shape ────────────────────────────────────────
    // React Flow keeps its viewport when its container resizes, so opening the
    // assistant, closing it, the plan panel arriving or the window changing
    // left the build framed for a canvas that no longer exists (owner,
    // 2026-09-16: "het beeld moet zich automatisch aan de canvas grootte
    // aanpassen"). While the AI is building AND the camera is still ours, a
    // settled resize re-frames: a wide shot, so everything built so far and
    // the slot ahead are in view at a legible zoom. It never fires for a
    // presenter who has taken the camera (`following === false`), and never
    // outside a build — someone who zoomed in by hand keeps their view.
    useEffect(() => {
        const el = wrapperRef?.current;
        if (!active || !el || typeof ResizeObserver === 'undefined') return undefined;
        let timer = null;
        let last = null;
        const observer = new ResizeObserver((entries) => {
            const box = entries[0]?.contentRect;
            if (!box) return;
            // Sub-pixel reflows and the first measurement are not resizes.
            if (last && Math.abs(box.width - last.width) < 8 && Math.abs(box.height - last.height) < 8) return;
            const first = !last;
            last = { width: box.width, height: box.height };
            if (first) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => { timer = null; runShot('wide'); }, RESIZE_SETTLE_MS);
        });
        observer.observe(el);
        return () => { observer.disconnect(); if (timer) clearTimeout(timer); };
    }, [active, wrapperRef, runShot]);

    // The panel covering the canvas appearing or going is a resize the box
    // itself never sees — re-frame on it too. On the CHANGE only: the value it
    // starts a build with is already what the first shots framed in.
    const insetRef = useRef(cameraInsetLeft);
    useEffect(() => {
        const changed = insetRef.current !== cameraInsetLeft;
        insetRef.current = cameraInsetLeft;
        if (!active || !changed) return undefined;
        const id = setTimeout(() => runShot('wide'), RESIZE_SETTLE_MS);
        return () => clearTimeout(id);
    }, [active, cameraInsetLeft, runShot]);

    // ── Reduced motion: today's behaviour, verbatim ─────────────────────
    // Keyed on the COUNTS, not the arrays: those are rebuilt on every run
    // tick, validation pass and autosave round-trip, and re-fitting on those
    // would fight the user's own pan the entire time the panel is open. Two
    // frames, not one: the first commits the new node, the second is after
    // React Flow has measured it — fitting on the first reads a zero-size
    // node into the bounds and lands short of the graph.
    const nodeCount = computedNodes?.length ?? 0;
    const edgeCount = edges?.length ?? 0;
    useEffect(() => {
        if (!reducedMotion || !structuralEditsBlocked || !rf?.fitView) return undefined;
        let inner = 0;
        const outer = requestAnimationFrame(() => {
            inner = requestAnimationFrame(() => {
                try { rf.fitView({ padding: 0.12, duration: 260, minZoom: 0.2, maxZoom: 1 }); } catch { /* canvas gone */ }
            });
        });
        return () => { cancelAnimationFrame(outer); if (inner) cancelAnimationFrame(inner); };
    }, [reducedMotion, structuralEditsBlocked, nodeCount, edgeCount, rf]);

    // ── Unmount ─────────────────────────────────────────────────────────
    useEffect(() => () => {
        cancelPending();
        if (ownTimerRef.current) clearTimeout(ownTimerRef.current);
    }, [cancelPending]);

    // ── The ghost slot ──────────────────────────────────────────────────
    const narration = buildCue?.narration ?? null;
    const todos = buildCue?.todos ?? null;
    // The card being drawn: the tool call the model is typing right now,
    // projected once per streamed chunk (null between calls and outside a
    // build, so nothing downstream keys on it then).
    const toolDraft = active ? (buildCue?.toolDraft ?? null) : null;
    const draft = useMemo(() => projectGhostDraft(toolDraft, { catalog, t }), [toolDraft, catalog, t]);
    const ghost = useMemo(() => {
        if (!active) return null;
        // After a removal the slot's promise is void until the AI adds again
        // — unless it is visibly typing the next card, which is the promise
        // renewed: the card shows where the next one would go.
        if (fx.ghostHidden && draft?.kind !== 'step') return null;
        // Before anything has been added the slot follows the last card in
        // run order (the trigger on a fresh routine), so it is on screen
        // through the very first think.
        const anchorId = fx.frontierId || lastInFlow(definition);
        const anchorRect = rectOf(computedNodes, anchorId);
        if (!anchorRect) return null;
        return { anchorId, position: nextSlotFor(anchorRect), caption: captionFor({ narration, todos }), draft };
    }, [active, fx.ghostHidden, fx.frontierId, definition, computedNodes, narration, todos, draft]);

    const ghostNodes = useMemo(() => (ghost ? [{
        id: GHOST_ID,
        type: 'ghost_step',
        position: ghost.position,
        draggable: false,
        selectable: false,
        connectable: false,
        focusable: false,
        deletable: false,
        zIndex: -1,
        data: { caption: ghost.caption, synthetic: true, draft: ghost.draft },
    }] : NO_NODES), [ghost]);

    const ghostEdges = useMemo(() => (ghost ? [{
        id: GHOST_EDGE_ID,
        source: ghost.anchorId,
        target: GHOST_ID,
        // The AI-tool tether: a faint dashed line with no controls, because
        // there is no definition row behind it either.
        type: 'toolLink',
        selectable: false,
        focusable: false,
        deletable: false,
        data: { synthetic: true },
    }] : NO_NODES), [ghost]);

    const freshEdgeKeys = useMemo(() => new Set(fx.edgeKeys.keys()), [fx.edgeKeys]);

    return {
        buildFxById: fx.byId,
        frontierId: fx.frontierId,
        freshEdgeKeys,
        ghostNodes,
        ghostEdges,
        onMoveStart,
        onMoveEnd,
        following,
        resumeFollow,
        // For the ribbon flight (useRibbonFlight): the cards still to be dealt
        // with their departure instants, the burst's head with its own, and
        // whether the film is playing at all.
        revealQueue: fx.pending,
        revealHead: fx.head,
        active,
        // The card being drawn, as the ghost shows it — for the ribbon
        // spotlight (useRibbonSpotlight), which rests on the app's tile.
        ghostDraft: ghost ? ghost.draft : null,
    };
}
