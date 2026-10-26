// "Next change" over the rendered compare: the changed rows carry a data
// attribute, and stepping scrolls the next (or previous) one into view and
// marks it. The step function is handed up to the toolbar through `register`.

import { useEffect, useRef, type RefObject } from 'react';

export type StepFn = (dir: 1 | -1) => void;
export type RegisterStep = (step: StepFn | null) => void;

/** The index the next step lands on, wrapping at both ends. */
export function nextIndex(count: number, current: number, dir: 1 | -1): number {
    if (count <= 0) return -1;
    if (current < 0) return dir === 1 ? 0 : count - 1;
    return (current + dir + count) % count;
}

export function useDomStepper(container: RefObject<HTMLElement | null>, selector: string, register: RegisterStep, resetKey: unknown) {
    const at = useRef(-1);
    useEffect(() => { at.current = -1; }, [resetKey]);
    useEffect(() => {
        register((dir) => {
            const items = Array.from(container.current?.querySelectorAll<HTMLElement>(selector) || []);
            const i = nextIndex(items.length, at.current, dir);
            if (i < 0) return;
            items.forEach((el) => el.removeAttribute('data-current-change'));
            at.current = i;
            items[i].setAttribute('data-current-change', 'true');
            items[i].scrollIntoView?.({ block: 'center', behavior: 'smooth' });
        });
        return () => register(null);
    }, [container, selector, register]);
}
