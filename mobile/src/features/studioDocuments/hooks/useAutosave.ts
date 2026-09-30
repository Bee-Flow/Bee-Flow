/**
 * The body's autosave: the newest text is saved a moment after the last
 * keystroke (the web waits 1.5 s too, because the server snapshots a version
 * on every content save and a per-keystroke save would mint one per
 * character), and on leaving the screen, which usually happens inside that
 * window.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export const AUTOSAVE_MS = 1500;

export interface Autosave {
    state: SaveState;
    error: unknown;
    /** Remember `body` and save it once typing pauses. */
    schedule: (body: string) => void;
    /** Save what is pending now. Rejects when the save fails. */
    flush: () => Promise<void>;
    /**
     * Drop what is pending without saving it: the person chose the stored
     * version, so the failed body must not be written later (on retry or on
     * leaving the screen) over what they went back to.
     */
    discard: () => void;
}

/** `save` must be stable (a useCallback): leaving the screen flushes through it. */
export function useAutosave(save: (body: string) => Promise<unknown>, delay = AUTOSAVE_MS): Autosave {
    const pending = useRef<string | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [state, setState] = useState<SaveState>('idle');
    const [error, setError] = useState<unknown>(null);

    const flush = useCallback(async () => {
        if (timer.current) clearTimeout(timer.current);
        const body = pending.current;
        if (body === null) return;
        pending.current = null;
        setState('saving');
        try {
            await save(body);
            setError(null);
            setState(pending.current === null ? 'saved' : 'saving');
        } catch (err) {
            // A newer keystroke always wins over the failed request's body.
            if (pending.current === null) pending.current = body;
            setError(err);
            setState('error');
            throw err;
        }
    }, [save]);

    const discard = useCallback(() => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        pending.current = null;
        setError(null);
        setState('idle');
    }, []);

    const schedule = useCallback(
        (body: string) => {
            pending.current = body;
            setState('saving');
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => void flush().catch(() => undefined), delay);
        },
        [flush, delay],
    );

    useEffect(
        () => () => {
            if (pending.current !== null) void flush().catch(() => undefined);
        },
        [flush],
    );

    return { state, error, schedule, flush, discard };
}
