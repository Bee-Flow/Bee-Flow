import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * An element's own width, kept current with a ResizeObserver. 0 until it is
 * measured, and 0 for good where there is no ResizeObserver (jsdom), so
 * callers must treat 0 as "unknown", never as "narrow".
 */
export default function useElementWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
    const [width, setWidth] = useState(0);
    const observer = useRef<ResizeObserver | null>(null);
    const ref = useCallback((el: T | null) => {
        observer.current?.disconnect();
        observer.current = null;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver((entries) => {
            const w = Math.round(entries[0]?.contentRect?.width ?? 0);
            setWidth(prev => (prev === w ? prev : w));
        });
        ro.observe(el);
        observer.current = ro;
    }, []);
    useEffect(() => () => observer.current?.disconnect(), []);
    return [ref, width];
}
