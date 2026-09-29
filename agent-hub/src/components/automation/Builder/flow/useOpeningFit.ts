import type { FitViewOptions, ReactFlowState } from '@xyflow/react';
import { useEffect, useRef } from 'react';

/**
 * The opening fit: the whole flow framed once it has finished arriving.
 *
 * React Flow fits once, on the first measured nodes. A builder opened by
 * navigation can mount on a first draft of its definition and get the real
 * one a moment later: the Step builder mounts on a placeholder (trigger and
 * return, stacked) and then hydrates the block. React Flow framed the two
 * placeholder cards at its 200% cap, and the block's own three cards landed
 * beside them, off screen.
 *
 * So until the person does anything (a pointer, a key, the wheel), every new
 * set of cards is framed again once all of them are measured. The opening
 * is also over the moment something else owns the camera (`enabled` false):
 * the build film, a replayed test run, the step drawer. A key already seen
 * is never framed twice, so a build that ends does not re-fit its result.
 */

/**
 * The ids of the visible nodes, once every one of them is measured; null
 * while any is not. A string, so the store selector compares by value.
 */
export function selectMeasuredIds(s: Pick<ReactFlowState, 'nodeLookup'>): string | null {
    if (s.nodeLookup.size === 0) return null;
    const ids: string[] = [];
    for (const n of s.nodeLookup.values()) {
        if (n.hidden) continue;
        if (!n.measured?.width || !n.measured?.height) return null;
        ids.push(n.id);
    }
    return ids.length ? ids.sort().join('\n') : null;
}

const INPUT_EVENTS = ['pointerdown', 'keydown', 'wheel'] as const;

export interface OpeningFitInput {
    /** selectMeasuredIds from the React Flow store. */
    measuredKey: string | null;
    /** The canvas's own fit (flow/useFurnitureFit.ts). */
    fit: (options?: FitViewOptions) => void;
    /** False while something else owns the camera; the first false ends the opening. */
    enabled: boolean;
}

export function useOpeningFit({ measuredKey, fit, enabled }: OpeningFitInput): void {
    const openRef = useRef(true);
    const seenRef = useRef<string | null>(null);

    useEffect(() => {
        if (!enabled) openRef.current = false;
    }, [enabled]);

    useEffect(() => {
        const end = () => {
            openRef.current = false;
            for (const type of INPUT_EVENTS) document.removeEventListener(type, end, true);
        };
        for (const type of INPUT_EVENTS) document.addEventListener(type, end, { capture: true, passive: true });
        return () => { for (const type of INPUT_EVENTS) document.removeEventListener(type, end, true); };
    }, []);

    useEffect(() => {
        if (!measuredKey || measuredKey === seenRef.current) return;
        seenRef.current = measuredKey;
        if (enabled && openRef.current) fit({ duration: 0 });
    }, [measuredKey, enabled, fit]);
}
