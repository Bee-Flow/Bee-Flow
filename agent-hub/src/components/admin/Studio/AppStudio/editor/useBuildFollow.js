import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolveBuildScreen } from './buildScreenTarget';
import { MIN_MOVE_GAP_MS } from '../../../../shared/builder/revealSchedule';
import { findScreen } from '../state/definitionOps';

/**
 * The camera during an AI build — for a canvas that is a scrolling DOM grid
 * (the routine canvas moves a React Flow viewport; here the camera is the
 * surface's scroll position AND which screen the canvas shows).
 *
 * For each card of a reveal plan, shortly after it appears, the surface
 * scrolls the cell into view (`block: 'nearest'` — the smallest move that
 * shows it; two moves never closer than MIN_MOVE_GAP_MS). A wheel or pointer
 * gesture on the surface takes the camera away and it does NOT come back on
 * its own — the banner offers "Follow the build" instead. Same rule as the
 * routine canvas: the person watching always wins.
 *
 * CHAPTERS (2026-09-13). The canvas renders one screen; the AI builds on
 * whichever it is typing for. The screen it is building is resolved here
 * (buildScreenTarget.js) from the live cue — the parent of the batch being
 * typed first, so the switch lands BEFORE the cells do and the ghost cell
 * shows on the right screen; then a screen the last call added; then where
 * the last reveal landed — and the hook dispatches `set_screen` when that
 * differs from the active screen and the camera has not been yielded. The
 * resolution is sticky: a theme or table call names no screen and must not
 * lose the chapter. Resolved HERE against the live definition, not in the
 * pane: the pane's cue memo reads its definition ref one render late and
 * would miss a brand-new screen on the very draft that created it.
 *
 *   useBuildFollow({ surfaceRef, reveal, toolDraft, lastCall, definition,
 *                    screenId, dispatch, enabled, reducedMotion })
 *     → { following, follow, screen: { id, name, reason } | null }
 */
const LAND_LEAD_MS = 200;

export function scheduleFollowMoves(plan, { minGapMs = MIN_MOVE_GAP_MS, leadMs = LAND_LEAD_MS } = {}) {
    const ids = plan && Array.isArray(plan.ids) ? plan.ids : [];
    const delays = plan && plan.delays instanceof Map ? plan.delays : new Map();
    const out = [];
    let lastAt = -Infinity;
    for (const id of ids) {
        const at = (delays.get(id) || 0) + leadMs;
        if (at - lastAt < minGapMs && out.length) continue;
        out.push({ id, at });
        lastAt = at;
    }
    return out;
}

export default function useBuildFollow({
    surfaceRef, reveal, toolDraft = null, lastCall = null, definition = null, screenId = null, dispatch = null,
    enabled = false, reducedMotion = false,
}) {
    const [following, setFollowing] = useState(true);
    const followingRef = useRef(true);
    const timersRef = useRef([]);
    const clearTimers = () => { for (const t of timersRef.current) clearTimeout(t); timersRef.current = []; };

    // The chapter: resolved on every cue change, sticky across calls that name
    // no screen (kept in state, refreshed after render), forgotten with the build.
    const resolved = useMemo(
        () => (enabled ? resolveBuildScreen({ definition, toolDraft, lastCall, reveal }) : null),
        [enabled, definition, toolDraft, lastCall, reveal],
    );
    const [sticky, setSticky] = useState(null);
    useEffect(() => {
        if (!enabled) { setSticky(null); return; }
        if (resolved) setSticky(resolved);
        else setSticky((prev) => (prev && !findScreen(definition, prev.id) ? null : prev));
    }, [enabled, resolved, definition]);
    const screen = enabled ? (resolved || sticky) : null;
    const pendingScrollRef = useRef(null);

    const scrollTo = useCallback((id) => {
        const root = surfaceRef && surfaceRef.current;
        if (!root || typeof root.querySelector !== 'function') return;
        const el = root.querySelector(`[data-node-id="${id}"]`);
        if (el && typeof el.scrollIntoView === 'function') {
            el.scrollIntoView({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
        }
    }, [surfaceRef, reducedMotion]);

    // A fresh build follows again; the person's yield lasts one build.
    useEffect(() => {
        if (enabled) { followingRef.current = true; setFollowing(true); }
        else { clearTimers(); pendingScrollRef.current = null; }
    }, [enabled]);

    // The switch itself: navigation, not motion — reduced motion still
    // switches. Never while the person has the camera.
    const buildScreenId = screen ? screen.id : null;
    useEffect(() => {
        if (!enabled || !buildScreenId || !dispatch) return;
        if (buildScreenId !== screenId && followingRef.current) dispatch({ type: 'set_screen', screenId: buildScreenId });
    }, [enabled, buildScreenId, screenId, dispatch]);

    // follow() asked for a jump AND a scroll: the scroll waits until the
    // target screen's DOM exists.
    useEffect(() => {
        const pending = pendingScrollRef.current;
        if (!pending || !buildScreenId || screenId !== buildScreenId) return;
        pendingScrollRef.current = null;
        scrollTo(pending);
    }, [screenId, buildScreenId, scrollTo]);

    // Schedule one move per card, from the plan's own delays.
    useEffect(() => {
        clearTimers();
        if (!enabled || !reveal || !reveal.plan) return undefined;
        const elapsed = Math.max(0, Date.now() - (reveal.at || Date.now()));
        for (const { id, at } of scheduleFollowMoves(reveal.plan)) {
            const wait = Math.max(0, at - elapsed);
            timersRef.current.push(setTimeout(() => { if (followingRef.current) scrollTo(id); }, wait));
        }
        return clearTimers;
    }, [enabled, reveal, scrollTo]);

    // A gesture on the surface yields the camera.
    useEffect(() => {
        const root = surfaceRef && surfaceRef.current;
        if (!enabled || !root || typeof root.addEventListener !== 'function') return undefined;
        const yieldCamera = () => { if (followingRef.current) { followingRef.current = false; setFollowing(false); } };
        root.addEventListener('wheel', yieldCamera, { passive: true });
        root.addEventListener('pointerdown', yieldCamera, { passive: true });
        return () => {
            root.removeEventListener('wheel', yieldCamera);
            root.removeEventListener('pointerdown', yieldCamera);
        };
    }, [enabled, surfaceRef]);

    const follow = useCallback(() => {
        followingRef.current = true;
        setFollowing(true);
        const ids = reveal && reveal.plan && Array.isArray(reveal.plan.ids) ? reveal.plan.ids : [];
        const last = ids.length ? ids[ids.length - 1] : null;
        if (screen && screen.id !== screenId && dispatch) {
            // Back to the chapter first; the scroll follows once it renders.
            pendingScrollRef.current = last;
            dispatch({ type: 'set_screen', screenId: screen.id });
            return;
        }
        if (last) scrollTo(last);
    }, [reveal, scrollTo, screen, screenId, dispatch]);

    useEffect(() => clearTimers, []);
    return { following, follow, screen };
}
