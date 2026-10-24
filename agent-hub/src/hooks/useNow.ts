import { useEffect, useState } from 'react';

/**
 * The current time as a render-safe value (`Date.now()` is impure, so it must
 * not be called while rendering). Read at mount; with `refreshMs` it ticks on
 * that interval, so a deadline shown on screen flips when it passes.
 */
export default function useNow(refreshMs?: number): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!refreshMs || refreshMs <= 0) return undefined;
        const id = setInterval(() => setNow(Date.now()), refreshMs);
        return () => clearInterval(id);
    }, [refreshMs]);
    return now;
}
