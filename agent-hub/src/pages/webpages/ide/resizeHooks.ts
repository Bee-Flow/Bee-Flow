import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';

const KEY_RESIZE_STEP = 16;

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

function endDrag(dragging: RefObject<boolean>) {
    if (!dragging.current) return;
    dragging.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
}

/**
 * A column width the user drags (mouse) or steps (keyboard) between `min` and
 * `max`. Returns `[size, onMouseDown, onKeyDown]`; `onKeyDown(e, dir)` takes a
 * `dir` that flips the sign for handles whose panel grows when dragged left
 * (e.g. the right-hand chat panel).
 */
export function useDragResize(initialSize: number, min: number, max: number) {
    const [size, setSize] = useState(initialSize);
    const dragging = useRef(false);
    const startX = useRef(0);
    const startSize = useRef(initialSize);

    const onMouseDown = useCallback((e: ReactMouseEvent) => {
        dragging.current = true;
        startX.current = e.clientX;
        startSize.current = size;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    }, [size]);

    // Keyboard resize for the accessible separator (Arrow keys ± step,
    // Home/End jump to the bounds).
    const onKeyDown = useCallback((e: ReactKeyboardEvent, dir = 1) => {
        const step = KEY_RESIZE_STEP * dir;
        if (e.key === 'ArrowRight') { setSize(s => clamp(s + step, min, max)); e.preventDefault(); }
        else if (e.key === 'ArrowLeft') { setSize(s => clamp(s - step, min, max)); e.preventDefault(); }
        else if (e.key === 'Home') { setSize(min); e.preventDefault(); }
        else if (e.key === 'End') { setSize(max); e.preventDefault(); }
    }, [min, max]);

    useEffect(() => {
        const onMove = (e: MouseEvent) => {
            if (!dragging.current) return;
            setSize(clamp(startSize.current + e.clientX - startX.current, min, max));
        };
        const onUp = () => endDrag(dragging);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    }, [min, max]);

    return [size, onMouseDown, onKeyDown] as const;
}

/**
 * A row split in percent of `containerRef`'s height, with `min` pixels kept
 * for either side. Returns `[pct, onMouseDown, onKeyDown]`.
 */
export function useRowDragResize(initialPct: number, min: number, containerRef: RefObject<HTMLElement | null>) {
    const [pct, setPct] = useState(initialPct);
    const dragging = useRef(false);
    const startY = useRef(0);
    const startPct = useRef(initialPct);

    const onMouseDown = useCallback((e: ReactMouseEvent) => {
        dragging.current = true;
        startY.current = e.clientY;
        startPct.current = pct;
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';
    }, [pct]);

    const onKeyDown = useCallback((e: ReactKeyboardEvent) => {
        const stepPct = 5;
        if (e.key === 'ArrowDown') { setPct(p => Math.min(90, p + stepPct)); e.preventDefault(); }
        else if (e.key === 'ArrowUp') { setPct(p => Math.max(10, p - stepPct)); e.preventDefault(); }
    }, []);

    useEffect(() => {
        const onMove = (e: MouseEvent) => {
            if (!dragging.current || !containerRef.current) return;
            const h = containerRef.current.getBoundingClientRect().height;
            const newPct = startPct.current + ((e.clientY - startY.current) / h) * 100;
            const minPct = (min / h) * 100;
            setPct(clamp(newPct, minPct, 100 - minPct));
        };
        const onUp = () => endDrag(dragging);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    }, [min, containerRef]);

    return [pct, onMouseDown, onKeyDown] as const;
}
