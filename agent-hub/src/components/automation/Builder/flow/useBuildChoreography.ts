import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { diffDefinitions, nextSlotFor, shotFor, isRectInView, planCameraMove, MIN_MOVE_GAP_MS, getActiveShots } from './buildChoreography';
import { projectGhostDraft } from './ghostDraft';
import type { BuildChoreographyArgs, CameraPlan, FxEvent, FxState, LatestChoreography, PlanCameraMoveFn, ProjectGhostDraftFn, ShotForFn, ShotKind } from './useBuildChoreography.types';
import { logger } from '@/utils/logger';
import { CARD_W, CARD_H, GHOST_ID, GHOST_EDGE_ID, MOUNT_GRACE_MS, OWN_SLACK_MS, WIDE_SHOT, MOUNT_SHOT, CENTER_DURATION_MS, RESIZE_SETTLE_MS, NO_NODES, EMPTY } from './useBuildChoreography.constants';
import { nextExpiry, nextDue, prune, rectOf, unionOfNodes, predecessorOf, lastInFlow, captionFor, applyDiff, advance, mergeMoves, sizeOf } from './useBuildChoreography.helpers';
export { FLAG_TTL_MS,   } from './useBuildChoreography.constants';

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

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

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
}: BuildChoreographyArgs) {
    const blocked = !!structuralEditsBlocked;
    const phase = buildCue?.phase || 'building';
    // Flags, ghost and camera exist only while the AI is BUILDING. A dry run
    // mid-build hands the canvas to the run vocabulary (cards breathe, edges
    // dash); summarise and finalize are chapter ends, not more cards.
    const active = blocked && !reducedMotion && phase === 'building' && !runInFlight;

    const [fx, setFx] = useState<FxState>(EMPTY);
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
                    ? { ...next, event: { ...next.event, reason: 'mount' } as FxEvent }
                    : next);
            }
        }
    }
    if (!active && fx !== EMPTY) setFx(EMPTY);

    // ── Everything the timers read, one commit behind at most ───────────
    const latestRef = useRef({} as LatestChoreography);
    useEffect(() => {
        latestRef.current = { rf, wrapperRef, computedNodes, definition, fx, blocked, active, reducedMotion, orderHint, cameraInsetLeft };
    });

    // ── Camera plumbing ─────────────────────────────────────────────────
    const followingRef = useRef(true);
    const cameraOwnedRef = useRef(false);
    const ownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const ownUntilRef = useRef(0);
    const lastMoveAtRef = useRef<number | null>(null);
    const timersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
    const pendingRef = useRef<CameraPlan | null>(null);

    const setFollow = useCallback((value: boolean) => {
        followingRef.current = value;
        setFollowing(value);
    }, []);

    const cancelPending = useCallback(() => {
        for (const id of timersRef.current) clearTimeout(id);
        timersRef.current.clear();
        pendingRef.current = null;
    }, []);

    const later = useCallback((fn: () => void, ms: number) => {
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
    const ownCamera = useCallback((ms: number) => {
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
    const runShot = useCallback((kind: ShotKind) => {
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
                    const framed = (shotFor as ShotForFn)({ kind: 'wide', rects: [wideRect], viewport: size, current });
                    if (framed) flow.setViewport({ x: framed.x + (size as NonNullable<typeof size>).offsetX, y: framed.y, zoom: framed.zoom }, { duration: shot.duration, interpolate: framed.interpolate });
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
                const shot = (shotFor as ShotForFn)({ kind: 'push', rects: predRect ? [predRect, newRect] : [newRect], ghostRect, viewport: size, current });
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
        } catch (err) { logger.debug('canvas gone', err); }
        return false;
    }, [ownCamera]);

    /**
     * Queue a plan. A plan already waiting for the same instant merges into
     * this one (the wider shot wins) — three arrivals inside one hold become
     * one move, framed at fire time so it shows the NEWEST card.
     */
    const schedule = useCallback((moves: ShotKind[], deferMs: number, holdMs: number) => {
        const merged = mergeMoves(pendingRef.current?.moves ?? null, moves);
        cancelPending();
        const plan: CameraPlan = { moves: merged, holdMs };
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
                const rest: CameraPlan = { moves: [second], holdMs };
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
        const plan = (planCameraMove as PlanCameraMoveFn)({
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
        // Summarise and finalize close a chapter with the whole automation in
        // frame. A dry run keeps the camera still: the run vocabulary owns
        // the canvas then, and its own banner says where the run is.
        const reason = phase === 'reviewing' ? 'summarise' : phase === 'finishing' ? 'finalize' : null;
        if (!reason) return;
        const plan = (planCameraMove as PlanCameraMoveFn)({ reason, following: followingRef.current, lastMoveAt: lastMoveAtRef.current, now: Date.now() });
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
            // The closing shot: the whole automation, once, unless the camera is
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
        const id = setTimeout(() => setFx((cur: FxState) => prune(cur, Date.now())), Math.max(0, at - Date.now()));
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
            setFx((cur: FxState) => advance(cur, now, nodes));
        }, Math.max(0, at - Date.now()));
        return () => clearTimeout(id);
    }, [fx]);

    // ── The canvas changed shape ────────────────────────────────────────
    // React Flow keeps its viewport when its container resizes, so opening the assistant, closing it,
    // the plan panel arriving or the window changing left the build framed for a canvas that no longer
    // exists (owner, 2026-09-16: "the view must adjust automatically to the canvas size"). While the AI
    // is building AND the camera is still ours, a settled resize re-frames: a wide shot, so everything
    // built so far and the slot ahead are in view at a legible zoom. It never fires for a presenter who
    // has taken the camera (`following === false`), and never outside a build. Someone who zoomed in by
    // hand keeps their view.
    useEffect(() => {
        const el = wrapperRef?.current;
        if (!active || !el || typeof ResizeObserver === 'undefined') return undefined;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let last: { width: number; height: number } | null = null;
        const observer = new ResizeObserver((entries: ResizeObserverEntry[]) => {
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
                try { rf.fitView({ padding: 0.12, duration: 260, minZoom: 0.2, maxZoom: 1 }); } catch (err) { logger.debug('canvas gone', err); }
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
    const draft = useMemo(() => (projectGhostDraft as ProjectGhostDraftFn)(toolDraft, { catalog, t }), [toolDraft, catalog, t]);
    const ghost = useMemo(() => {
        if (!active) return null;
        // After a removal the slot's promise is void until the AI adds again
        // — unless it is visibly typing the next card, which is the promise
        // renewed: the card shows where the next one would go.
        if (fx.ghostHidden && draft?.kind !== 'step') return null;
        // Before anything has been added the slot follows the last card in
        // run order (the trigger on a fresh automation), so it is on screen
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
