import { useEffect, useRef } from 'react';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { drawOrbFrame, type ActivityTone } from './coworkOrbFrame';
import { makeOrbGeometry, type OrbGeometry } from './coworkOrbGeometry';

export type { ActivityTone } from './coworkOrbFrame';

const SPEED = { thinking: .86, executing: 1.3, repair: 1.05, rest: .42 };
let geometry: OrbGeometry | undefined;

export default function CoworkOrb({ tone = 'thinking', activity }: { tone?: ActivityTone; activity?: string }) {
    const canvas = useRef<HTMLCanvasElement>(null);
    const clock = useRef({ time: 0, speed: SPEED[tone], beat: 0 });
    const reduced = useReducedMotion();
    useEffect(() => {
        const el = canvas.current;
        if (!el || typeof CanvasRenderingContext2D === 'undefined') return;
        const ctx = el.getContext('2d');
        if (!ctx) return;
        const model = geometry ??= makeOrbGeometry();
        const state = clock.current;
        state.beat = reduced || tone === 'rest' ? 0 : 1;
        const draw = () => drawOrbFrame(ctx, model, state.time, state.beat);
        const resize = () => {
            const pixels = Math.max(1, Math.round(el.clientWidth * Math.min(window.devicePixelRatio || 1, 2)));
            if (pixels !== el.width || pixels !== el.height) el.width = el.height = pixels;
            draw();
        };
        let visible = true;
        let frame = 0;
        let last: number | undefined;
        const tick = (now: number) => {
            const elapsed = last === undefined ? 0 : now - last;
            if (last === undefined || elapsed >= 32) {
                const seconds = Math.min(elapsed / 1000, .10);
                state.speed += (SPEED[tone] - state.speed) * Math.min(1, seconds * 3);
                state.time += seconds * state.speed;
                state.beat = Math.max(0, state.beat - seconds * .8);
                last = now;
                draw();
            }
            frame = requestAnimationFrame(tick);
        };
        const update = () => {
            cancelAnimationFrame(frame);
            last = undefined;
            if (visible && !document.hidden && !reduced) frame = requestAnimationFrame(tick);
        };
        const viewport = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(([entry]) => {
            visible = entry.isIntersecting;
            update();
        });
        viewport?.observe(el);
        const size = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
        size?.observe(el);
        resize();
        update();
        document.addEventListener('visibilitychange', update);
        return () => {
            cancelAnimationFrame(frame);
            viewport?.disconnect();
            size?.disconnect();
            document.removeEventListener('visibilitychange', update);
        };
    }, [tone, activity, reduced]);

    return <div aria-hidden="true" className="cowork-orb" data-tone={tone}>
        <canvas ref={canvas} width="256" height="256" />
    </div>;
}
