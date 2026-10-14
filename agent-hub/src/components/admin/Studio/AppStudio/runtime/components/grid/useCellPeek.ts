import { useEffect, useState } from 'react';
import type { FocusEvent, MouseEvent } from 'react';
import type { PeekState } from './gridCells';

/**
 * The peek panel state of the App Studio data grid: which clipped cell's full
 * text is showing, and where. Moved out of AppDataGrid.jsx verbatim.
 */
export function useCellPeek() {
    // The full text of whatever clamped cell is under the pointer. One piece of
    // state for the whole grid rather than one per cell: a thousand cells that
    // each own a popover is a thousand subscriptions to re-render on hover.
    const [peek, setPeek] = useState<PeekState | null>(null);
    const showPeek = (e: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>) => {
        // The clamp can sit on the wrapper OR — for an editable column — on the
        // button inside it, so take the innermost one: that is the box that
        // actually clips.
        const boxes = e.currentTarget.querySelectorAll<HTMLElement>('[data-app-clamped]');
        // A single-line `truncate` column clips on the CELL itself — there is no
        // inner wrapper to find — so the cell is the fallback box. Without it
        // the peek covered multi-line clamping and left plain truncation with
        // nothing at all: a part number cut to "MW2604-02-…" was simply gone.
        const box = boxes[boxes.length - 1] || e.currentTarget;
        // Nothing hidden, nothing to say. Measuring beats guessing from the
        // string length: what fits depends on the column width, and a panel
        // that repeats what is already on screen is pure noise. Both axes,
        // because a clamp hides height and a truncate hides width.
        const hidden = box.scrollHeight > box.clientHeight + 1
            || box.scrollWidth > box.clientWidth + 1;
        if (!hidden) return;
        const text = (box.innerText || '').trim();
        if (!text) return;
        const r = e.currentTarget.getBoundingClientRect();
        setPeek({ text, top: r.bottom, bottom: r.top, left: r.left, above: r.bottom > window.innerHeight - 200 });
    };
    const hidePeek = () => setPeek(null);

    // Anchored to viewport coordinates read once, so any scroll underneath it
    // would leave the panel pointing at a different row. Cheaper and more
    // honest to close it.
    useEffect(() => {
        if (!peek) return undefined;
        const off = () => setPeek(null);
        window.addEventListener('scroll', off, true);
        return () => window.removeEventListener('scroll', off, true);
    }, [peek]);

    return { peek, showPeek, hidePeek };
}
