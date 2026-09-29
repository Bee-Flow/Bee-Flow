import { useEffect, useRef, useState } from 'react';

const COUNT_UP_MS = 600;

/**
 * The row counter's number: counts up from the last shown value to `target`
 * over 600 ms on requestAnimationFrame. Under reduced motion (or without
 * rAF) the target is shown at once — no animation state at all.
 */
export default function useCountUp(target, { reducedMotion = false } = {}) {
    const goal = Number.isFinite(target) ? target : 0;
    const [animated, setAnimated] = useState(goal);
    const fromRef = useRef(goal);
    const still = reducedMotion || typeof requestAnimationFrame !== 'function';
    useEffect(() => {
        if (still) { fromRef.current = goal; return undefined; }
        const from = fromRef.current;
        if (from === goal) return undefined;
        let raf = 0;
        const t0 = performance.now();
        const tick = (now) => {
            const k = Math.min(1, (now - t0) / COUNT_UP_MS);
            const eased = 1 - (1 - k) * (1 - k);
            setAnimated(Math.round(from + (goal - from) * eased));
            if (k < 1) raf = requestAnimationFrame(tick);
            else fromRef.current = goal;
        };
        raf = requestAnimationFrame(tick);
        return () => { if (raf) cancelAnimationFrame(raf); fromRef.current = goal; };
    }, [goal, still]);
    return still ? goal : animated;
}
