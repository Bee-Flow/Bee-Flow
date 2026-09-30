/**
 * The call's one polling slot. The mic meter and the playback watcher take
 * turns in it — starting one stops the other — so a call can never have both
 * loops running, and hanging up has exactly one interval to clear.
 */

import { useCallback, useEffect, useRef } from 'react';

export interface Poller {
    start: (tick: () => void, ms: number) => void;
    stop: () => void;
}

export function usePoller(): Poller {
    const slot = useRef<ReturnType<typeof setInterval> | null>(null);

    const stop = useCallback(() => {
        if (slot.current) clearInterval(slot.current);
        slot.current = null;
    }, []);

    const start = useCallback(
        (tick: () => void, ms: number) => {
            stop();
            slot.current = setInterval(tick, ms);
        },
        [stop],
    );

    // A live interval polling a released recorder outlives the screen.
    useEffect(() => stop, [stop]);

    return { start, stop };
}
