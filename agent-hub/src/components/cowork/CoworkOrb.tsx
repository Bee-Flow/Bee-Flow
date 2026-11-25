import { advanceLayers, updatePattern } from './coworkOrbPattern';
import CoworkOrbSources, { type OrbWork } from './CoworkOrbSources';
import type { NeuralGlyph } from './coworkOrbGlyph';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { drawOrbFrame, type ActivityTone, type OrbPattern } from './coworkOrbFrame';
import { makeOrbGeometry, type OrbGeometry } from './coworkOrbGeometry';

export type { ActivityTone } from './coworkOrbFrame';

const SPEED = { thinking: .86, executing: 1.3, repair: 1.05, rest: .42 };
let geometry: OrbGeometry | undefined;

function fitCanvas(el: HTMLCanvasElement) {
    const pixels = Math.max(1, Math.round(el.clientWidth * Math.min(3, Math.max(2, window.devicePixelRatio || 1))));
    if (pixels !== el.width || pixels !== el.height) el.width = el.height = pixels;
}

export default function CoworkOrb({ tone = 'thinking', activity, work }: { tone?: ActivityTone; activity?: string; work?: OrbWork }) {
    const [marks, setMarks] = useState<(NeuralGlyph | null)[]>([]);
    const canvas = useRef<HTMLCanvasElement>(null);
    const clock = useRef({ time: 0, speed: SPEED[tone], beat: 0 });
    const layers = useRef<OrbPattern[]>([]);
    const reduced = useReducedMotion();
    const target = Math.max(0, Math.min(work?.focus ?? marks.length - 1, marks.length - 1));
    const ordered = !!work?.flow?.length;
    const progress = useRef({ id: '' });
    const step = work?.flow?.[work?.focus ?? -1];
    const controls = useRef({ target, tone });
    const repaint = useRef<() => void>(() => {});
    useLayoutEffect(() => {
        controls.current = { target, tone };
        updatePattern(layers.current, marks, { ordered, target, step, reduced }, progress.current);
        if (reduced) {
            const current = layers.current.at(-1)!;
            Object.assign(current, { opacity: 1, focus: target });
            layers.current = [current];
            repaint.current();
        }
    }, [marks, ordered, reduced, target, tone, activity, step]);
    useEffect(() => {
        const el = canvas.current;
        if (!el || typeof CanvasRenderingContext2D === 'undefined') return;
        const ctx = el.getContext('2d');
        if (!ctx) return;
        const model = geometry ??= makeOrbGeometry();
        const state = clock.current;
        const draw = repaint.current = () => drawOrbFrame(ctx, model, state.time, state.beat, layers.current);
        const resize = () => {
            fitCanvas(el);
            draw();
        };
        let visible = true;
        let frame = 0;
        let last: number | undefined;
        const tick = (now: number) => {
            const elapsed = last === undefined ? 0 : now - last;
            const seconds = Math.min(elapsed / 1000, .1);
            const { target, tone } = controls.current;
            state.speed += (SPEED[tone] - state.speed) * (1 - Math.exp(-seconds * 3));
            state.time += seconds * state.speed;
            state.beat += ((tone === 'rest' ? 0 : .5) - state.beat) * (1 - Math.exp(-seconds * 3));
            advanceLayers(layers.current, target, seconds);
            last = now;
            draw();
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
            repaint.current = () => {};
            viewport?.disconnect();
            size?.disconnect();
            document.removeEventListener('visibilitychange', update);
        };
    }, [reduced]);

    return <div aria-hidden="true" className="cowork-orb" data-tone={tone}>
        <CoworkOrbSources action={tone} {...work} onRead={setMarks} />
        <canvas ref={canvas} width="256" height="256" />
    </div>;
}
