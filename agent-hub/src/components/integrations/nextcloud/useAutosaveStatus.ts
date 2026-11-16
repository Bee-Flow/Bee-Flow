// The save status of a panel whose controls save themselves (a switch, a
// choice card, a checkbox in a list): one request per change, the SaveStatus
// chip says "Saving…", "Saved just now" or "Not saved" with a retry. Saves
// run one after another: each sends the whole state as it was at its change,
// so a quick second change can never be overtaken by the first on the server.
// A slower earlier save never overwrites the status of a later one.

import { useCallback, useRef, useState } from 'react';
import { errorMessage } from '@/utils/caughtError';

type AutosaveState = 'idle' | 'saving' | 'saved' | 'error';

export interface AutosaveStatus {
    state: AutosaveState;
    lastSavedAt: Date | null;
    /** The last failure's message, null after a success. */
    error: string | null;
    /** Run one save; resolves true when it succeeded. */
    run: (job: () => Promise<unknown>) => Promise<boolean>;
    /** Run the last save again (the SaveStatus retry). */
    retry: () => void;
}

export function useAutosaveStatus(): AutosaveStatus {
    const [state, setState] = useState<AutosaveState>('idle');
    const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
    const [error, setError] = useState<string | null>(null);
    const seq = useRef(0);
    const lastJob = useRef<(() => Promise<unknown>) | null>(null);
    // The save in flight (or the last one); the next waits for it to settle.
    const queue = useRef<Promise<unknown>>(Promise.resolve());

    const run = useCallback(async (job: () => Promise<unknown>) => {
        const mine = ++seq.current;
        lastJob.current = job;
        setState('saving');
        const turn = queue.current.then(() => job());
        queue.current = turn.catch(() => undefined);
        try {
            await turn;
            if (mine === seq.current) {
                setState('saved');
                setLastSavedAt(new Date());
                setError(null);
            }
            return true;
        } catch (e) {
            if (mine === seq.current) {
                setState('error');
                setError(errorMessage(e) ?? null);
            }
            return false;
        }
    }, []);

    const retry = useCallback(() => {
        const job = lastJob.current;
        if (job) void run(job);
    }, [run]);

    return { state, lastSavedAt, error, run, retry };
}
