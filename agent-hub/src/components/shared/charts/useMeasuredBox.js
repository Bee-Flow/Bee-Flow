import { useLayoutEffect, useState } from 'react';

/**
 * The pixel box of a chart's wrapper, for a recharts chart that takes an
 * explicit width instead of `ResponsiveContainer` — which measures 0×0 in
 * jsdom and renders nothing, so a chart under test would have no SVG to
 * assert on. The fallback of 600 px keeps a chart drawable before the first
 * measurement and in every test.
 *
 * The measured div may not exist yet when the hook runs (a chart behind a
 * skeleton), so measuring is driven by a callback ref + an observer rather
 * than by mount. Returns `[setRef, width, height]`.
 */
export default function useMeasuredBox() {
    const [el, setEl] = useState(null);
    const [box, setBox] = useState({ w: 0, h: 0 });
    useLayoutEffect(() => {
        if (!el) return undefined;
        const measure = () => setBox({ w: el.clientWidth || 0, h: el.clientHeight || 0 });
        measure();
        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', measure);
            return () => window.removeEventListener('resize', measure);
        }
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, [el]);
    return [setEl, box.w > 0 ? box.w : 600, box.h];
}
