import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';

import { flightGlyphFor, originKeysFor, resolveOrigin } from './ribbonOrigin';
import type { DiagramDefinition, DiagramStep, Rf } from './diagramPaneTypes';

/** A ghost of a card in flight from its ribbon command to its slot. */
export interface FlightGhost {
    id: string;
    from: NonNullable<ReturnType<typeof resolveOrigin>>['rect'];
    glyph: ReturnType<typeof flightGlyphFor>;
    startedAt: number;
}

/** A queued departure: the card id and the instant (ms epoch) it leaves. */
interface FlightDeparture {
    id?: string | null;
    at?: number;
}

interface LatestFlight {
    definition?: DiagramDefinition | null;
    catalog?: unknown;
    rf?: Rf | null;
    ribbonRootRef?: RefObject<HTMLElement | null> | null;
}

interface RibbonFlightArgs {
    queue?: readonly FlightDeparture[] | null;
    head?: FlightDeparture | null;
    definition?: DiagramDefinition | null;
    catalog?: unknown;
    rf?: Rf | null;
    ribbonRootRef?: RefObject<HTMLElement | null> | null;
    reducedMotion?: boolean;
    enabled?: boolean;
}

/**
 * The ribbon flight — the stateful half (the pure half is ribbonOrigin.js,
 * the ghost RibbonFlightLayer.jsx).
 *
 * Each card the AI deals is drawn from the ribbon, the way the author would
 * have added it: at the card's departure instant the ribbon command that adds
 * that kind of step gets a ring (`bf-ribbon-pick`), and PICK_LEAD_MS later a
 * ghost of the card leaves the command and flies to the card's slot on the
 * canvas, where the real card materialises as it lands (its reveal delay is
 * departure + FLIGHT_TOTAL_MS, see useBuildChoreography). This hook turns the
 * choreography's queue into those timers and owns the ghosts as state.
 *
 * Departures come from the queue, never from the flags: a card's reveal is a
 * CSS animation-delay that cannot be observed, while the queue says exactly
 * when each turn begins. The head of the burst is not in the queue — it
 * departs at once — so it is handed over separately as `head`.
 *
 * Every id departs at most once (`seenRef`): the queue shrinks on every
 * advance and the effect re-runs on each shrink, and React's StrictMode runs
 * an effect twice, so without the set a card could take off as twins.
 *
 * Nothing here is essential to the truth of the canvas. No ribbon root, no
 * stamped origin on screen, or a React Flow without `flowToScreenPosition`
 * (the build test's spy) → no ring or no ghost, and the card still reveals
 * on time, flight included.
 */

/** The ring shows on the command before anything leaves it — the eye needs to be there first. */
export const PICK_LEAD_MS = 150;
/** The flight itself; ease-out so the ghost decelerates onto its slot. */
export const FLY_MS = 450;
/** Departure to landing: what the choreography adds to every card's reveal delay. */
export const FLIGHT_TOTAL_MS = PICK_LEAD_MS + FLY_MS;
/** The ring outlives the flight a little, then leaves so the same command can ring again next card. */
export const PICK_HOLD_MS = 700;
/** The landed ghost fades while the real card's own reveal takes over underneath it. */
export const LAND_FADE_MS = 120;
/** The class the ringed command wears (index.css). */
export const PICK_CLASS = 'bf-ribbon-pick';

const EMPTY_MAP = new Map<string, FlightGhost>();
const NO_GHOSTS: readonly FlightGhost[] = Object.freeze([]);

/** The trigger(s) and steps of a definition, by id. */
function stepOf(definition: DiagramDefinition | null | undefined, id: string | null | undefined): DiagramStep | null {
    if (id == null || !definition) return null;
    const roots = [definition.trigger, ...(Array.isArray(definition.triggers) ? definition.triggers : [])];
    for (const n of roots) if (n && n.id === id) return n;
    for (const s of Array.isArray(definition.steps) ? definition.steps : []) if (s && s.id === id) return s;
    return null;
}

export function useRibbonFlight({
    queue,
    head = null,
    definition,
    catalog = null,
    rf,
    ribbonRootRef,
    reducedMotion = false,
    enabled = true,
}: RibbonFlightArgs) {
    const on = !!enabled && !reducedMotion;
    const [ghosts, setGhosts] = useState<Map<string, FlightGhost>>(EMPTY_MAP);
    // Off → no ghosts, in the SAME render (React's "adjust state when a prop
    // changes"): an abort mid-flight must not leave a ghost hanging over the
    // canvas for a frame, and the effect below only touches timers and rings.
    if (!on && ghosts.size) setGhosts(EMPTY_MAP);

    // What a departure reads at fire time, one commit behind at most.
    const latestRef = useRef<LatestFlight>({});
    useEffect(() => {
        latestRef.current = { definition, catalog, rf, ribbonRootRef };
    });

    const timersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
    const seenRef = useRef(new Set<string>());
    const pickedRef = useRef(new Set<HTMLElement>());

    const later = useCallback((fn: () => void, ms: number) => {
        const id = setTimeout(() => {
            timersRef.current.delete(id);
            fn();
        }, Math.max(0, ms));
        timersRef.current.add(id);
        return id;
    }, []);

    /** Everything back to rest: timers, rings, and the memory of who flew (the ghosts go during render, above). */
    const reset = useCallback(() => {
        for (const id of timersRef.current) clearTimeout(id);
        timersRef.current.clear();
        for (const el of pickedRef.current) el.classList?.remove(PICK_CLASS);
        pickedRef.current.clear();
        seenRef.current.clear();
    }, []);

    const depart = useCallback((id: string) => {
        const { definition: def, catalog: cat, rf: flow, ribbonRootRef: rootRef } = latestRef.current;
        const root = rootRef?.current;
        if (!root) return;
        const step = stepOf(def, id);
        if (!step) return;
        const origin = resolveOrigin(root, (originKeysFor as (step: DiagramStep, catalog?: unknown) => ReturnType<typeof originKeysFor>)(step, cat));
        if (!origin) return;

        origin.el.classList.add(PICK_CLASS);
        pickedRef.current.add(origin.el);
        later(() => {
            origin.el.classList.remove(PICK_CLASS);
            pickedRef.current.delete(origin.el);
        }, PICK_HOLD_MS);

        // No way to aim: the ring is the whole show for this card.
        if (typeof flow?.flowToScreenPosition !== 'function') return;

        later(() => {
            const startedAt = Date.now();
            const glyph = flightGlyphFor(step);
            setGhosts((cur: Map<string, FlightGhost>) => {
                if (cur.has(id)) return cur;
                const next = new Map(cur);
                next.set(id, { id, from: origin.rect, glyph, startedAt });
                return next;
            });
            later(() => {
                setGhosts((cur: Map<string, FlightGhost>) => {
                    if (!cur.has(id)) return cur;
                    const next = new Map(cur);
                    next.delete(id);
                    return next.size ? next : EMPTY_MAP;
                });
            }, FLY_MS + LAND_FADE_MS);
        }, PICK_LEAD_MS);
    }, [later]);

    // ── Arm one departure per card ──────────────────────────────────────
    useEffect(() => {
        if (!on) {
            reset();
            return undefined;
        }
        const arm = (id: string | null | undefined, at?: number) => {
            if (id == null || seenRef.current.has(id)) return;
            seenRef.current.add(id);
            later(() => depart(id), (Number(at) || 0) - Date.now());
        };
        if (head && head.id != null) arm(head.id, head.at);
        for (const p of Array.isArray(queue) ? queue : []) arm(p?.id, p?.at);
        return undefined;
    }, [on, head, queue, depart, later, reset]);

    // ── Unmount ─────────────────────────────────────────────────────────
    useEffect(() => () => reset(), [reset]);

    const list = useMemo(() => (ghosts.size ? [...ghosts.values()] : NO_GHOSTS), [ghosts]);
    return { ghosts: list };
}
