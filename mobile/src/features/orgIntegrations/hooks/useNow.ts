/** The time, re-read every `ms` while `active`: for a countdown on screen. */

import { useEffect, useState } from 'react';

export function useNow(active: boolean, ms = 1000): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!active) return undefined;
        const timer = setInterval(() => setNow(Date.now()), ms);
        return () => clearInterval(timer);
    }, [active, ms]);
    return now;
}
