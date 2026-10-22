/**
 * useResizableWidth — drag-to-resize width for a side panel/drawer.
 *
 * Extracted from the right-panel drag logic that NotebooksPage inlined. Returns
 * the current width, a setter, and a `startDrag` mousedown handler for the grab
 * strip. Width is clamped to [min,max] and optionally persisted to localStorage
 * on drag-end (not per-move, to avoid hammering storage during a drag).
 */
import { useState, useRef, useCallback, useEffect } from 'react';

interface UseResizableWidthArgs {
    initial?: number;
    min?: number;
    max?: number;
    side?: string;
    storageKey?: string;
}

export default function useResizableWidth({ initial = 320, min = 250, max = 800, side = 'right', storageKey }: UseResizableWidthArgs = {}) {
    const [width, setWidthState] = useState(() => {
        if (storageKey) {
            try {
                const v = parseInt(localStorage.getItem(storageKey) as string, 10);
                if (Number.isFinite(v)) return Math.max(min, Math.min(v, max));
            } catch { /* ignore */ }
        }
        return initial;
    });

    const widthRef = useRef(width);
    const draggingRef = useRef(false);

    const setWidth = useCallback((w: number) => {
        const clamped = Math.max(min, Math.min(w, max));
        widthRef.current = clamped;
        setWidthState(clamped);
    }, [min, max]);

    const startDrag = useCallback((e: { preventDefault: () => void }) => {
        e.preventDefault();
        draggingRef.current = true;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    }, []);

    useEffect(() => {
        const onMove = (e: MouseEvent) => {
            if (!draggingRef.current) return;
            const w = side === 'right'
                ? document.body.clientWidth - e.clientX
                : e.clientX;
            setWidth(w);
        };
        const onUp = () => {
            if (!draggingRef.current) return;
            draggingRef.current = false;
            document.body.style.cursor = 'default';
            document.body.style.userSelect = 'auto';
            if (storageKey) {
                try { localStorage.setItem(storageKey, String(widthRef.current)); } catch { /* ignore */ }
            }
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        return () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        };
    }, [side, setWidth, storageKey]);

    return { width, setWidth, startDrag };
}
