import { useCallback, useLayoutEffect, useState } from 'react';

/**
 * useContainerWidth: the observed border-box width of ONE element, in whole
 * CSS pixels.
 *
 * A layout that has to change its STRUCTURE with the space it gets (a table
 * that becomes a card list, a drawer that stops sitting beside the table and
 * floats over it) cannot do that with a container query alone: a query can
 * hide or restyle, it cannot render a different component. This hook gives
 * the component the number to decide with.
 *
 * Returns `[ref, width]`. The ref is a callback ref, so it also works on an
 * element that mounts later (a drawer that opens). `width` is null until the
 * element is measured, and stays null where nothing can be measured (jsdom
 * lays nothing out and reports 0, an old browser has no ResizeObserver):
 * callers treat null as "unknown" and keep their default layout, so a test
 * environment or a missing API never flips a page into its narrow variant.
 *
 * `enabled = false` keeps the ref harmless (no observer at all), so a
 * component can call the hook unconditionally and only pay for it when the
 * feature that needs it is switched on.
 */
export default function useContainerWidth<T extends HTMLElement = HTMLDivElement>(
    enabled = true,
): [(node: T | null) => void, number | null] {
    const [node, setNode] = useState<T | null>(null);
    const [width, setWidth] = useState<number | null>(null);
    // Disabled, the ref stores nothing and nothing re-renders: a table that
    // does not use the feature pays one no-op callback, not a second render.
    // A change of `enabled` gives a new callback, so React re-attaches it.
    const ref = useCallback((el: T | null) => {
        if (enabled) setNode(el);
    }, [enabled]);

    useLayoutEffect(() => {
        if (!enabled || !node) return undefined;
        const apply = (w: number) => setWidth(w > 0 ? Math.round(w) : null);
        // A first read before paint, so the first frame already has the
        // right layout instead of flashing the wide one.
        apply(node.getBoundingClientRect().width);
        if (typeof ResizeObserver !== 'function') return undefined;
        const observer = new ResizeObserver((entries) => {
            const entry = entries[entries.length - 1];
            if (!entry) return;
            const box = Array.isArray(entry.borderBoxSize) ? entry.borderBoxSize[0] : undefined;
            apply(box ? box.inlineSize : entry.contentRect.width);
        });
        observer.observe(node);
        return () => observer.disconnect();
    }, [enabled, node]);

    return [ref, enabled && node ? width : null];
}
