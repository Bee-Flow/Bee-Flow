import { useCallback, useEffect, useState, type RefObject } from 'react';
import { pageAtOffset } from './viewerMath';

/** Inner size of an element, kept current by ResizeObserver (debounced). 0 x 0 until measured. */
export function useElementSize(): [{ w: number; h: number }, (el: HTMLElement | null) => void] {
    const [el, setEl] = useState<HTMLElement | null>(null);
    const [size, setSize] = useState({ w: 0, h: 0 });
    useEffect(() => {
        if (!el) return undefined;
        const read = () => setSize((prev) => (prev.w === el.clientWidth && prev.h === el.clientHeight ? prev : { w: el.clientWidth, h: el.clientHeight }));
        read();
        if (typeof ResizeObserver === 'undefined') return undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const ro = new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(read, 60); });
        ro.observe(el);
        return () => { clearTimeout(timer); ro.disconnect(); };
    }, [el]);
    return [size, useCallback((node: HTMLElement | null) => setEl(node), [])];
}

/** True while the element in `ref` is the document's fullscreen element. */
export function useIsFullscreen(ref: RefObject<HTMLElement | null>): boolean {
    const [on, setOn] = useState(false);
    useEffect(() => {
        const read = () => setOn(!!ref.current && document.fullscreenElement === ref.current);
        document.addEventListener('fullscreenchange', read);
        return () => document.removeEventListener('fullscreenchange', read);
    }, [ref]);
    return on;
}

/** Keeps `onPage` on the page under the top third of `scroller`, following its scroll (one read per frame). */
export function useScrolledPage(scroller: HTMLElement | null, tops: () => number[], onPage: (n: number) => void): void {
    useEffect(() => {
        if (!scroller) return undefined;
        let raf = 0;
        const read = () => { raf = 0; onPage(pageAtOffset(tops(), scroller.scrollTop + scroller.clientHeight / 3)); };
        const onScroll = () => { if (!raf) raf = requestAnimationFrame(read); };
        scroller.addEventListener('scroll', onScroll, { passive: true });
        return () => { scroller.removeEventListener('scroll', onScroll); if (raf) cancelAnimationFrame(raf); };
    }, [scroller, tops, onPage]);
}
