/**
 * A value that follows `value` once it has stopped changing for `ms` — so a
 * lookup keyed on what the author is typing (a schedule preview, an agent
 * capsule) asks once per pause, not once per keystroke.
 */

import { useEffect, useState } from 'react';

export function useSettled<T>(value: T, ms = 400): T {
    const [settled, setSettled] = useState(value);
    useEffect(() => {
        const timer = setTimeout(() => setSettled(value), ms);
        return () => clearTimeout(timer);
    }, [value, ms]);
    return settled;
}
