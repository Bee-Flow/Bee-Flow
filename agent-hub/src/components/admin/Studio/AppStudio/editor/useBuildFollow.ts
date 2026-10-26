import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, RefObject } from 'react';
import { resolveBuildScreen } from './buildScreenTarget';
import type { BuildScreen } from './buildScreenTarget';
import type { BuildCueCall } from './BuildCueContext';
import type { ToolDraft } from './ghostCellDraft';
import type { RevealCue } from '../chat/useBuilderTurn';
import type { AppDefinition } from '../inspector/appDefinition';
import type { AppEditorAction } from '../state/appEditorState';
import { MIN_MOVE_GAP_MS } from '@/components/shared/builder/revealSchedule';
import { findScreen } from '../state/definitionOps';

interface FollowInputs {
    surfaceRef: RefObject<HTMLElement | null> | null | undefined;
    reveal: RevealCue | null;
    toolDraft?: ToolDraft | null;
    lastCall?: BuildCueCall | null;
    definition?: AppDefinition | null;
    screenId?: string | null;
    dispatch?: Dispatch<AppEditorAction> | null;
    enabled?: boolean;
    reducedMotion?: boolean;
}

/**
 * The camera during an AI build — for a canvas that is a scrolling DOM grid
 * (the automation canvas moves a React Flow viewport; here the camera is the
 * surface's scroll position AND which screen the canvas shows).
 *
 * For each card of a reveal plan, shortly after it appears, the surface
 * scrolls the cell into view (`block: 'nearest'` — the smallest move that
 * shows it; two moves never closer than MIN_MOVE_GAP_MS). A wheel or pointer
 * gesture on the surface takes the camera away and it does NOT come back on
 * its own — the banner offers "Follow the build" instead. Same rule as the
 * automation canvas: the person watching always wins.
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

export function scheduleFollowMoves(plan: { ids?: string[]; delays?: Map<string, number> } | null | undefined, { minGapMs = MIN_MOVE_GAP_MS, leadMs = LAND_LEAD_MS }: { minGapMs?: number; leadMs?: number } = {}): Array<{ id: string; at: number }> {
    const ids = plan && Array.isArray(plan.ids) ? plan.ids : [];
    const delays = plan && plan.delays instanceof Map ? plan.delays : new Map<string, number>();
    const out: Array<{ id: string; at: number }> = [];
    let lastAt = -Infinity;
    for (const id of ids) {
        const at = (delays.get(id) || 0) + leadMs;
        if (at - lastAt < minGapMs && out.length) continue;
        out.push({ id, at });
        lastAt = at;
    }
    return out;
}

/** The chapter kept between calls that name no screen; forgotten with the build or with its screen. */
function nextStickyScreen(enabled: boolean, resolved: BuildScreen | null, sticky: BuildScreen | null, definition: Parameters<typeof findScreen>[0]): BuildScreen | null {
    if (!enabled) return null;
    if (resolved) return resolved;
    return sticky && !findScreen(definition, sticky.id) ? null : sticky;
}

export default function useBuildFollow({
    surfaceRef, reveal, toolDraft = null, lastCall = null, definition = null, screenId = null, dispatch = null,
    enabled = false, reducedMotion = false,
}: FollowInputs) {
    const [following, setFollowing] = useState(true);
    const followingRef = useRef(true);
    const timersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
    const clearTimers = () => { for (const t of timersRef.current) clearTimeout(t); timersRef.current = []; };

    // The chapter: resolved on every cue change, sticky across calls that name
    // no screen (kept in state, refreshed after render), forgotten with the build.
    const resolved = useMemo(
        () => (enabled ? resolveBuildScreen({ definition, toolDraft, lastCall, reveal }) : null),
        [enabled, definition, toolDraft, lastCall, reveal],
    );
    const [sticky, setSticky] = useState<BuildScreen | null>(null);
    // Adjusted during render; it settles at once (the same inputs give the same value).
    const nextSticky = nextStickyScreen(enabled, resolved, sticky, definition);
    if (nextSticky !== sticky) setSticky(nextSticky);
    const screen = enabled ? (resolved || sticky) : null;
    const pendingScrollRef = useRef<string | null>(null);

    const scrollTo = useCallback((id: string) => {
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
