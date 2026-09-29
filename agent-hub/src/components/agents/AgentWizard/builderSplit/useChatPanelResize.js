import { useState, useRef } from 'react';

/**
 * Breedte + sleepgreep van de verfijn-rail in BuilderSplit.
 *
 * De rail stond links en 460px breed. Sinds het builder-herontwerp (A2 stap
 * 1) staat hij RECHTS en is hij 360px, met een ondergrens van 300 — smaller
 * dan dat past het chatinvoerveld met zijn tierkiezer niet meer.
 *
 * De KANT is niet alleen een andere `initial`. De greep zit nu aan de
 * LINKERkant van de rail, dus naar links slepen maakt hem BREDER: het teken
 * van de delta hangt aan de kant waar de rail staat. Vandaar `side` als
 * expliciete parameter en niet als aanname in de rekensom.
 *
 * @param {{initial?:number, min?:number, max?:number, side?:'left'|'right'}} [opts]
 */
export default function useChatPanelResize({ initial = 360, min = 300, max = 600, side = 'right' } = {}) {
    const [chatWidth, setChatWidth] = useState(initial);
    const isDragging = useRef(false);
    const dragStartX = useRef(0);
    const dragStartW = useRef(0);

    const onDragStart = (e) => {
        isDragging.current = true;
        dragStartX.current = e.clientX;
        dragStartW.current = chatWidth;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        const onMove = (ev) => {
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
