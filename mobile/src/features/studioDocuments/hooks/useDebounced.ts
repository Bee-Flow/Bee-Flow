/** A value that follows `value` once it has stopped changing for `delay` ms (the web's search waits 180 ms). */

import { useEffect, useState } from 'react';

export function useDebounced<T>(value: T, delay = 180): T {
    const [settled, setSettled] = useState(value);
    useEffect(() => {
        const timer = setTimeout(() => setSettled(value), delay);
        return () => clearTimeout(timer);
    }, [value, delay]);
    return settled;
}
