import { useState, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';

/**
 * Width and drag handle of the refine rail in BuilderSplit.
 *
 * The rail used to stand on the left and was 460px wide. Since the builder redesign
 * (A2 step 1) it stands on the RIGHT and is 360px, with a minimum of 300. Narrower
 * than that, the chat input field no longer fits with its tier selector.
 *
 * The SIDE is not only a different `initial`. The handle now sits on the LEFT side
 * of the rail, so dragging left makes it WIDER: the sign of the delta depends on the
 * side on which the rail stands. Hence `side` as an explicit parameter, and not an
 * assumption in the arithmetic.
 */
export default function useChatPanelResize({ initial = 360, min = 300, max = 600, side = 'right' }: { initial?: number; min?: number; max?: number; side?: 'left' | 'right' } = {}) {
    const [chatWidth, setChatWidth] = useState(initial);
    const isDragging = useRef(false);
    const dragStartX = useRef(0);
    const dragStartW = useRef(0);

    const onDragStart = (e: ReactMouseEvent) => {
        isDragging.current = true;
        dragStartX.current = e.clientX;
        dragStartW.current = chatWidth;
        document.body.style.cursor = 'col-resize';
        // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_username -- the CSS user-select property, not a username
        document.body.style.userSelect = 'none';
        const onMove = (ev: MouseEvent) => {
            if (!isDragging.current) return;
            const travel = ev.clientX - dragStartX.current;
            // Rail rechts: naar links (negatieve travel) = breder.
            const delta = side === 'right' ? -travel : travel;
            setChatWidth(Math.min(max, Math.max(min, dragStartW.current + delta)));
        };
        const onUp = () => {
            isDragging.current = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    };

    return { chatWidth, onDragStart };
}
