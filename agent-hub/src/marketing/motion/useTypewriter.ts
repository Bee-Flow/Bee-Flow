import { useEffect, useState } from 'react';

/**
 * Types `text` out character by character once `active` turns true, then
 * calls `onDone`. With `instant` (reduced motion, the editor preview) the full
 * text is returned at once and `onDone` is not needed. Timers are cleaned up.
 */
export default function useTypewriter(text: string, active: boolean, instant: boolean, onDone?: () => void, msPerChar = 38): string {
    const [count, setCount] = useState(0);
    useEffect(() => {
        if (instant || !active) return undefined;
        if (count >= text.length) {
            onDone?.();
            return undefined;
        }
        const id = window.setTimeout(() => setCount((c) => c + 1), msPerChar);
        return () => window.clearTimeout(id);
    }, [active, instant, count, text, msPerChar, onDone]);
    return instant ? text : text.slice(0, count);
}
