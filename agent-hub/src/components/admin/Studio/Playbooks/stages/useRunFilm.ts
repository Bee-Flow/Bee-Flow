import { useEffect, useMemo, useState } from 'react';
import { dwellMs, filmOrder, frameAt, recordsById, serverHead } from './runFilm';
import type { FilmDefinition, StepRecord } from './runFilm';
import useAdjustOnChange from '@/hooks/useAdjustOnChange';

interface RunFilmOptions {
    runId?: string | null;
    runStatus?: string | null;
    reducedMotion?: boolean;
    stepMs?: number;
    catchUpMs?: number;
}

/**
 * The run steps, paced (runFilm.js). Returns what the canvas should render
 * right now: the trigger firing, then one node at a time, never ahead of what
 * the server has actually recorded. Under reduced motion it returns the
 * server's own steps untouched.
 */
export default function useRunFilm(steps: StepRecord[] | null | undefined, definition: FilmDefinition | null | undefined, { runId = null, runStatus = null, reducedMotion = false, stepMs, catchUpMs }: RunFilmOptions = {}): StepRecord[] {
    const order = useMemo(() => filmOrder(definition), [definition]);
    const byId = useMemo(() => recordsById(steps), [steps]);
    const hasTrigger = !!definition?.trigger?.id;
    const limit = serverHead(order, byId, { runStatus, hasTrigger });
    const [head, setHead] = useState<number>(0);

    // A different run is a different film.
    useAdjustOnChange([runId], () => setHead(0));

    useEffect(() => {
        if (reducedMotion || head >= limit) return undefined;
        const id = setTimeout(() => setHead((h: number) => Math.min(h + 1, limit)), dwellMs(limit - head, { stepMs, catchUpMs }));
        return () => clearTimeout(id);
    }, [head, limit, reducedMotion, stepMs, catchUpMs]);

    return useMemo(() => {
        if (reducedMotion) return Array.isArray(steps) ? steps : [];
        if (!order.length) return Array.isArray(steps) ? steps : [];
        return frameAt(order, byId, head, { hasTrigger });
    }, [reducedMotion, steps, order, byId, head, hasTrigger]);
}
