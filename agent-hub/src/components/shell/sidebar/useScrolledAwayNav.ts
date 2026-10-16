import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

/**
 * Tracks which secondary-nav rows have scrolled above the visible scroll
 * region, so the sidebar can render them as a compact icon strip pinned below
 * the static core nav. Uses an IntersectionObserver against the scroll
 * container; each row registers through `setSecondaryRef(key)` and carries
 * its key in `data-nav-key`. Split out of Sidebar.jsx without a change in
 * behaviour.
 */
export function useScrolledAwayNav(isOpen: boolean, scrollRef: RefObject<HTMLElement | null>) {
    const secondaryItemRefs = useRef<Record<string, HTMLElement>>({});
    const [hiddenSecondaryKeys, setHiddenSecondaryKeys] = useState<Set<string>>(() => new Set());
    const observerRef = useRef<IntersectionObserver | null>(null);

    useEffect(() => {
        if (!isOpen) { setHiddenSecondaryKeys(new Set()); return; }
        const root = scrollRef.current;
        if (!root) return;
        const observer = new IntersectionObserver((entries) => {
            setHiddenSecondaryKeys(prev => nextHiddenKeys(prev, entries));
        }, { root, threshold: 0 });
        observerRef.current = observer;
        Object.values(secondaryItemRefs.current).forEach(el => { if (el) observer.observe(el); });
        return () => { observer.disconnect(); observerRef.current = null; };
    }, [isOpen, scrollRef]);

    const setSecondaryRef = useCallback((key: string) => (el: HTMLElement | null) => {
        const prev = secondaryItemRefs.current[key];
        if (prev && prev !== el && observerRef.current) observerRef.current.unobserve(prev);
        if (el) {
            secondaryItemRefs.current[key] = el;
            if (observerRef.current) observerRef.current.observe(el);
        } else {
            delete secondaryItemRefs.current[key];
        }
    }, []);

    return { hiddenSecondaryKeys, setSecondaryRef };
}

/** The keys above the scroll region after these entries; `prev` itself when nothing moved. */
function nextHiddenKeys(prev: Set<string>, entries: IntersectionObserverEntry[]): Set<string> {
    const next = new Set(prev);
    let changed = false;
    for (const entry of entries) {
        const key = (entry.target as HTMLElement).dataset.navKey;
        if (!key) continue;
        const rootTop = entry.rootBounds?.top ?? 0;
        const isAbove = !entry.isIntersecting && entry.boundingClientRect.bottom <= rootTop;
        if (isAbove) {
            if (!next.has(key)) { next.add(key); changed = true; }
        } else if (next.has(key)) {
            next.delete(key); changed = true;
        }
    }
    return changed ? next : prev;
}
