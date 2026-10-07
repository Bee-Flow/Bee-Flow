/**
 * The wall clock, re-read every `intervalMs` (web: useNow in
 * shared/DeadlineClock.jsx), so a 72-hour clock never lies. It pauses while
 * the app is in the background and reads the clock again on return.
 */

import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

export function useNow(intervalMs = 60_000): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!(intervalMs > 0)) return undefined;
        let id: ReturnType<typeof setInterval> | null = null;
        const start = () => {
            if (id === null) id = setInterval(() => setNow(Date.now()), intervalMs);
        };
        const stop = () => {
            if (id !== null) clearInterval(id);
            id = null;
        };
        start();
        const sub = AppState.addEventListener('change', (state) => {
            if (state === 'active') {
                setNow(Date.now());
                start();
            } else stop();
        });
        return () => {
            stop();
            sub.remove();
        };
    }, [intervalMs]);
    return now;
}
