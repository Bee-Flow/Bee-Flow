import { describe, it, expect } from 'vitest';

import { dragClientPoint } from './useNodeDragWiring';

describe('dragClientPoint', () => {
    it('reads a mouse event', () => {
        expect(dragClientPoint({ clientX: 10, clientY: 20 })).toEqual({ x: 10, y: 20 });
    });

    it('reads the first touch of a touch event instead of giving NaN', () => {
        expect(dragClientPoint({ touches: [{ clientX: 5, clientY: 6 }], changedTouches: [] })).toEqual({ x: 5, y: 6 });
    });

    it('falls back to changedTouches when no finger is down any more', () => {
        expect(dragClientPoint({ touches: [], changedTouches: [{ clientX: 7, clientY: 8 }] })).toEqual({ x: 7, y: 8 });
    });

    it('returns null when the event has no point', () => {
        expect(dragClientPoint({ touches: [], changedTouches: [] })).toBeNull();
        expect(dragClientPoint(null)).toBeNull();
    });
});
