/**
 * The turn in flight, as the screen sees it: the fold's live parts, published
 * at most every FLUSH_INTERVAL_MS and only when a frame changed them — the
 * same batching as the chat stream, for the same reason.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { FLUSH_INTERVAL_MS } from '../model/audio';
import { startFold, type TurnFold } from '../model/turnFold';
import { EMPTY_TURN, type LiveTurn } from '../model/types';

export function useLiveTurn() {
    const [live, setLive] = useState<LiveTurn>(EMPTY_TURN);
    const fold = useRef<TurnFold>(startFold());
    const flusher = useRef<ReturnType<typeof setInterval> | null>(null);

    const publish = useCallback(() => {
        if (!fold.current.dirty) return;
        fold.current.dirty = false;
        setLive({ ...fold.current.live, tools: [...fold.current.live.tools] });
    }, []);

    /** Start a new turn's fold, show it empty, and flush it as frames arrive. */
    const begin = useCallback((): TurnFold => {
        fold.current = startFold();
        fold.current.dirty = true;
        publish();
        if (flusher.current) clearInterval(flusher.current);
        flusher.current = setInterval(publish, FLUSH_INTERVAL_MS);
        return fold.current;
    }, [publish]);

    /** Stop flushing, publishing whatever is pending. */
    const stop = useCallback(() => {
        if (flusher.current) clearInterval(flusher.current);
        flusher.current = null;
        publish();
    }, [publish]);

    /** Back to nothing in flight — the turn was committed, or the call ended. */
    const clear = useCallback(() => {
        fold.current.live = { ...EMPTY_TURN };
        fold.current.dirty = true;
        publish();
    }, [publish]);

    useEffect(
        () => () => {
            if (flusher.current) clearInterval(flusher.current);
        },
        [],
    );

    return { live, begin, stop, clear };
}
