import { describe, it, expect } from 'vitest';
import {
    EMPTY_WHEEL_MEMORY, GESTURE_GAP_MS, PINCH_STEP_MAX,
    classifyWheel, clampZoomStep, deviceOfSample, panViewport, wheelIntent, zoomFactor, zoomViewportAt,
} from './wheelInput';
import type { WheelDevice, WheelIntent, WheelMemory, WheelSample } from './wheelInput';

/**
 * Touchpad or mouse, per gesture. The sequences below are shaped after what
 * the browsers really send (Chrome/Edge/Firefox on macOS, Windows and Linux):
 * a gesture is replayed event by event through classifyWheel, the way the
 * canvas sees it, and every event of it must land on one device.
 */

type Ev = Partial<WheelSample> & { t: number };

function replay(events: Ev[], memory: WheelMemory = EMPTY_WHEEL_MEMORY) {
    const out: { device: WheelDevice; intent: WheelIntent }[] = [];
    let mem = memory;
    for (const e of events) {
        const s: WheelSample = { deltaMode: 0, deltaX: 0, deltaY: 0, ...e, timeStamp: e.t };
        const r = classifyWheel(mem, s);
        mem = r.memory;
        out.push({ device: r.device, intent: wheelIntent(r.device, s) });
    }
    return { out, memory: mem };
}

/** Events `step` ms apart starting at `t0`. */
const burst = (deltas: Partial<WheelSample>[], t0 = 1000, step = 16): Ev[] => deltas.map((d, i) => ({ ...d, t: t0 + i * step }));

describe('wheelInput: touchpads', () => {
    it('a Mac trackpad swipe, momentum tail included, is a touchpad from start to end', () => {
        // macOS rails a vertical swipe (deltaX exactly 0) and the momentum
        // phase grows past 40 px: the burst keeps it a pan anyway.
        const { out } = replay(burst([
            { deltaY: 1 }, { deltaY: 2.5 }, { deltaX: 0.5, deltaY: 6 }, { deltaY: 14 },
            { deltaY: 31 }, { deltaY: 58 }, { deltaY: 44 }, { deltaY: 21.5 }, { deltaY: 7 }, { deltaY: 1 },
        ]));
        expect(out.every(o => o.device === 'touchpad')).toBe(true);
        expect(out.every(o => o.intent.kind === 'pan')).toBe(true);
        expect(out[5].intent).toEqual({ kind: 'pan', dx: 0, dy: 58 });
    });

    it('a diagonal two-finger move pans on both axes', () => {
        const { out } = replay(burst([{ deltaX: -3.25, deltaY: 2.75 }, { deltaX: -8, deltaY: 6.5 }]));
        expect(out.map(o => o.intent)).toEqual([
            { kind: 'pan', dx: -3.25, dy: 2.75 },
            { kind: 'pan', dx: -8, dy: 6.5 },
        ]);
    });

    it('a Windows precision touchpad (fractional, one axis) is a touchpad', () => {
        const { out } = replay(burst([
            { deltaY: 2.4 }, { deltaY: 7.2 }, { deltaY: 16.8 }, { deltaY: 45.6 }, { deltaY: 38.4 }, { deltaY: 9.6 },
        ], 5000, 8));
        expect(out.every(o => o.device === 'touchpad' && o.intent.kind === 'pan')).toBe(true);
    });

    it('a sideways touchpad swipe starts as a touchpad', () => {
        expect(deviceOfSample({ deltaMode: 0, deltaX: 3, deltaY: 0, timeStamp: 0 })).toBe('touchpad');
    });

});

describe('wheelInput: mouse wheels', () => {
    it('a notched mouse wheel (Chrome/Edge, 100 px a notch) zooms at React Flow\'s old speed', () => {
        // Notches a human turns, far enough apart to be separate gestures.
        const { out } = replay([{ deltaY: 100, t: 1000 }, { deltaY: 100, t: 1600 }, { deltaY: -100, t: 2400 }]);
        expect(out.map(o => o.device)).toEqual(['mouse', 'mouse', 'mouse']);
        expect(out[0].intent).toEqual({ kind: 'zoom', factor: 2 ** -0.2 });
        expect(out[2].intent).toEqual({ kind: 'zoom', factor: 2 ** 0.2 });
    });

    it('notch sizes on other platforms and browser zooms are mouse too', () => {
        for (const deltaY of [120, 53, 90.909090, 111.11, 125, 150, -48]) {
            expect(deviceOfSample({ deltaMode: 0, deltaX: 0, deltaY, timeStamp: 0 })).toBe('mouse');
        }
    });

    it('a free-spinning wheel stays one zooming gesture', () => {
        const { out } = replay(burst([
            { deltaY: 100 }, { deltaY: 100 }, { deltaY: 200 }, { deltaY: 100 }, { deltaY: 100 }, { deltaY: 100 },
        ], 1000, 6));
        expect(out.every(o => o.device === 'mouse' && o.intent.kind === 'zoom')).toBe(true);
    });

    it('a wheel in line mode (Firefox) is a mouse, and zooms at d3\'s line speed', () => {
        const { out } = replay([{ deltaMode: 1, deltaY: 3, t: 10 }]);
        expect(out[0].device).toBe('mouse');
        expect(out[0].intent).toEqual({ kind: 'zoom', factor: 2 ** (-3 * 0.05) });
    });

    it('Chrome on macOS: mouse steps in multiples of 4.000244140625 are a mouse', () => {
        expect(deviceOfSample({ deltaMode: 0, deltaX: 0, deltaY: 4.000244140625, timeStamp: 0 })).toBe('mouse');
        expect(deviceOfSample({ deltaMode: 0, deltaX: 0, deltaY: -12.000732421875, timeStamp: 0 })).toBe('mouse');
        expect(deviceOfSample({ deltaMode: 0, deltaX: 0, deltaY: 4, timeStamp: 0 })).toBe('touchpad');
    });

});

describe('wheelInput: pinch and modifiers', () => {
    it('a pinch (ctrlKey, small fractional deltas) zooms 1:1 with the fingers', () => {
        // Chrome: deltaY = -100 * ln(scale), so each event's factor is its scale.
        const scales = [1.02, 1.05, 1.08, 1.03];
        const { out } = replay(burst(scales.map(s => ({ ctrlKey: true, deltaY: -100 * Math.log(s) }))));
        expect(out.every(o => o.device === 'touchpad')).toBe(true);
        out.forEach((o, i) => {
            expect(o.intent.kind).toBe('zoom');
            expect((o.intent as { factor: number }).factor).toBeCloseTo(scales[i], 10);
        });
    });

    it('a pinch never jumps more than PINCH_STEP_MAX in one event', () => {
        const f = zoomFactor('touchpad', { deltaMode: 0, deltaX: 0, deltaY: -400, ctrlKey: true, timeStamp: 0 });
        expect(f).toBe(PINCH_STEP_MAX);
        const g = zoomFactor('touchpad', { deltaMode: 0, deltaX: 0, deltaY: 400, ctrlKey: true, timeStamp: 0 });
        expect(g).toBe(1 / PINCH_STEP_MAX);
    });

    it('Ctrl + a mouse notch zooms at the mouse speed, not the pinch speed', () => {
        const { out } = replay([{ ctrlKey: true, deltaY: 100, t: 50 }]);
        expect(out[0]).toEqual({ device: 'mouse', intent: { kind: 'zoom', factor: 2 ** -0.2 } });
    });

    it('Cmd + wheel zooms too', () => {
        const { out } = replay([{ metaKey: true, deltaY: 100, t: 50 }]);
        expect(out[0].intent.kind).toBe('zoom');
    });

    it('Ctrl + two fingers zooms instead of panning', () => {
        const { out } = replay(burst([{ deltaY: 3 }, { deltaY: 5, ctrlKey: true }]));
        expect(out[0].intent.kind).toBe('pan');
        expect(out[1]).toMatchObject({ device: 'touchpad', intent: { kind: 'zoom' } });
    });

    it('Shift + mouse wheel pans sideways, wherever the platform put the delta', () => {
        const onY = replay([{ shiftKey: true, deltaY: 100, t: 10 }]).out[0];
        expect(onY.intent).toEqual({ kind: 'pan', dx: 100, dy: 0 });
        const onX = replay([{ shiftKey: true, deltaX: -100, t: 10 }]).out[0];
        expect(onX.intent).toEqual({ kind: 'pan', dx: -100, dy: 0 });
        const lines = replay([{ shiftKey: true, deltaMode: 1, deltaY: 3, t: 10 }]).out[0];
        expect(lines.intent).toEqual({ kind: 'pan', dx: 60, dy: 0 });
    });

    it('a tilt wheel pans sideways', () => {
        expect(replay([{ deltaX: 120, t: 10 }]).out[0].intent).toEqual({ kind: 'pan', dx: 120, dy: 0 });
    });

});

describe('wheelInput: one device per gesture', () => {
    it('the device is decided per gesture: a pause lets the next one decide afresh', () => {
        const pad = replay(burst([{ deltaY: 2 }, { deltaY: 5 }]));
        const lastAt = pad.memory.lastAt;
        // Within the gap: still the touchpad, even with a notch-sized delta.
        const soon = replay([{ deltaY: 100, t: lastAt + GESTURE_GAP_MS - 1 }], pad.memory);
        expect(soon.out[0].device).toBe('touchpad');
        // After the gap: a new gesture, and this one is a mouse.
        const later = replay([{ deltaY: 100, t: lastAt + GESTURE_GAP_MS + 1 }], pad.memory);
        expect(later.out[0].device).toBe('mouse');
    });

    it('a mouse gesture never turns into a pan halfway', () => {
        // A hi-res wheel slowing down sends small late deltas.
        const { out } = replay(burst([{ deltaY: 100 }, { deltaY: 12.5 }, { deltaY: 3 }], 0, 30));
        expect(out.every(o => o.device === 'mouse' && o.intent.kind === 'zoom')).toBe(true);
    });

    it('an empty event is no evidence and starts nothing', () => {
        const r = classifyWheel(EMPTY_WHEEL_MEMORY, { deltaMode: 0, deltaX: 0, deltaY: 0, timeStamp: 5 });
        expect(r.memory).toBe(EMPTY_WHEEL_MEMORY);
        expect(wheelIntent(r.device, { deltaMode: 0, deltaX: 0, deltaY: 0, timeStamp: 5 })).toEqual({ kind: 'none' });
        // So a mouse notch right after it still reads as a mouse.
        expect(replay([{ deltaY: 100, t: 10 }], r.memory).out[0].device).toBe('mouse');
    });
});

describe('wheelInput: viewport maths', () => {
    const LIMITS = { minZoom: 0.5, maxZoom: 2 };

    it('zooming keeps the canvas point under the pointer where it was', () => {
        const vp = { x: 40, y: -20, zoom: 1 };
        const point = { x: 300, y: 200 };
        const next = zoomViewportAt(vp, 1.25, point, LIMITS);
        expect(next.zoom).toBe(1.25);
        const before = { x: (point.x - vp.x) / vp.zoom, y: (point.y - vp.y) / vp.zoom };
        const after = { x: (point.x - next.x) / next.zoom, y: (point.y - next.y) / next.zoom };
        expect(after.x).toBeCloseTo(before.x, 10);
        expect(after.y).toBeCloseTo(before.y, 10);
    });

    it('the zoom limits hold', () => {
        expect(zoomViewportAt({ x: 0, y: 0, zoom: 1.9 }, 1.25, { x: 0, y: 0 }, LIMITS).zoom).toBe(2);
        expect(zoomViewportAt({ x: 0, y: 0, zoom: 0.55 }, 0.8, { x: 0, y: 0 }, LIMITS).zoom).toBe(0.5);
        const atMax = { x: 3, y: 4, zoom: 2 };
        expect(zoomViewportAt(atMax, 1.2, { x: 0, y: 0 }, LIMITS)).toBe(atMax);
    });

    it('below the floor (a fit went to 20%), zooming out stays put and zooming in is smooth', () => {
        expect(clampZoomStep(0.2, 0.17, LIMITS)).toBe(0.2);
        expect(clampZoomStep(0.2, 0.23, LIMITS)).toBe(0.23);
        expect(clampZoomStep(0.45, 0.6, LIMITS)).toBe(0.6);
        expect(clampZoomStep(2.4, 2.2, LIMITS)).toBe(2.2);
        expect(clampZoomStep(2.4, 2.6, LIMITS)).toBe(2.4);
    });

    it('a pan moves the content against the scroll, at the same zoom', () => {
        expect(panViewport({ x: 10, y: 10, zoom: 0.7 }, 4, -6)).toEqual({ x: 6, y: 16, zoom: 0.7 });
        const vp = { x: 1, y: 2, zoom: 1 };
        expect(panViewport(vp, 0, 0)).toBe(vp);
    });

    it('a nonsense factor changes nothing', () => {
        const vp = { x: 1, y: 2, zoom: 1 };
        expect(zoomViewportAt(vp, Number.NaN, { x: 0, y: 0 }, LIMITS)).toBe(vp);
        expect(zoomViewportAt(vp, 0, { x: 0, y: 0 }, LIMITS)).toBe(vp);
    });
});
