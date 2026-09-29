import { useEffect, useMemo, useRef, useState } from 'react';
import { dwellMs, filmOrder, frameAt, recordsById, serverHead } from './runFilm';

/**
 * The run steps, paced (runFilm.js). Returns what the canvas should render
 * right now: the trigger firing, then one node at a time, never ahead of what
 * the server has actually recorded. Under reduced motion it returns the
 * server's own steps untouched.
 */
export default function useRunFilm(steps, definition, { runId = null, runStatus = null, reducedMotion = false, stepMs, catchUpMs } = {}) {
    const order = useMemo(() => filmOrder(definition), [definition]);
    const byId = useMemo(() => recordsById(steps), [steps]);
    const hasTrigger = !!definition?.trigger?.id;
    const limit = serverHead(order, byId, { runStatus, hasTrigger });
    const [head, setHead] = useState(0);

    // A different run is a different film.
    const runRef = useRef(runId);
    useEffect(() => {
        if (runRef.current === runId) return;
        runRef.current = runId;
        setHead(0);
    }, [runId]);

    useEffect(() => {
        if (reducedMotion || head >= limit) return undefined;
        const id = setTimeout(() => setHead((h) => Math.min(h + 1, limit)), dwellMs(limit - head, { stepMs, catchUpMs }));
        return () => clearTimeout(id);
    }, [head, limit, reducedMotion, stepMs, catchUpMs]);

    return useMemo(() => {
        if (reducedMotion) return Array.isArray(steps) ? steps : [];
        if (!order.length) return Array.isArray(steps) ? steps : [];
        return frameAt(order, byId, head, { hasTrigger });
    }, [reducedMotion, steps, order, byId, head, hasTrigger]);
}
