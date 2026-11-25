import { useLayoutEffect, useRef, type ReactNode } from 'react';

function resizeTo(outer: HTMLElement, from: number, to: number, easing: string) {
    if (Math.abs(from - to) <= 1) return null;
    return outer.animate([{ height: from + 'px', overflow: 'clip' }, { height: to + 'px', overflow: 'clip' }], { duration: 320, easing });
}

function canResize(outer: HTMLElement, from: number | undefined, height: number): from is number {
    return !!from && height > 0 && typeof outer.animate === 'function';
}

function observeSize(inner: HTMLElement, updated: () => void) {
    if (typeof ResizeObserver !== 'function') return () => {};
    const observer = new ResizeObserver(updated);
    observer.observe(inner);
    return () => observer.disconnect();
}

/** Resize the same surface between actions. Only the current form is mounted and interactive. */
export default function CoworkSurface({ scene, children }: { scene: string; children: ReactNode }) {
    const frame = useRef<HTMLDivElement>(null);
    const content = useRef<HTMLDivElement>(null);
    const previous = useRef<{ height: number; scene: string } | null>(null);
    const resize = useRef<Animation | null>(null);
    useLayoutEffect(() => {
        const outer = frame.current;
        const inner = content.current;
        if (!outer || !inner) return;
        const last = previous.current;
        const height = inner.getBoundingClientRect().height;
        const from = resize.current ? outer.getBoundingClientRect().height : last?.height;
        resize.current?.cancel();
        resize.current = null;
        previous.current = { height, scene };
        const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
        let arrival: Animation | undefined;
        const stop = () => { resize.current?.cancel(); resize.current = null; arrival?.cancel(); };
        const changed = last?.scene !== scene && !media?.matches;
        if (changed && canResize(outer, from, height)) {
            const easing = 'cubic-bezier(.22,.8,.22,1)';
            const move = resizeTo(outer, from, height, easing);
            resize.current = move;
            if (move) move.onfinish = () => { if (resize.current === move) resize.current = null; };
            arrival = inner.animate([{ opacity: .58, transform: 'translateY(5px)' }, { opacity: 1, transform: 'none' }], { duration: 230, easing });
        }
        const observer = observeSize(inner, () => {
            const next = inner.getBoundingClientRect().height;
            if (previous.current?.scene === scene && next > 0) previous.current.height = next;
        });
        media?.addEventListener?.('change', stop);
        return () => { observer(); media?.removeEventListener?.('change', stop); arrival?.cancel(); };
    }, [scene]);
    useLayoutEffect(() => () => resize.current?.cancel(), []);
    return <div ref={frame}><div ref={content} className="flow-root">{children}</div></div>;
}
