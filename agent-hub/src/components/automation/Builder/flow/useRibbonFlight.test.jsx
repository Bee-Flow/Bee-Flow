import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
    useRibbonFlight, PICK_LEAD_MS, FLY_MS, FLIGHT_TOTAL_MS, PICK_HOLD_MS, LAND_FADE_MS, PICK_CLASS,
} from './useRibbonFlight';

/**
 * The stateful half of the ribbon flight, driven through renderHook with a
 * stamped ribbon root, a fake React Flow and fake timers (Date included —
 * the ghost carries its take-off instant).
 *
 * Pinned: the ring lands on the command at the card's departure and leaves
 * after PICK_HOLD_MS; the ghost takes off PICK_LEAD_MS later and is gone at
 * FLY_MS + LAND_FADE_MS after that; a React Flow that cannot aim gets a ring
 * and no ghost; disabling mid-flight clears everything; a card departs once
 * however often the queue re-renders.
 */
const FAKES = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame'];
const T0 = 100000;

const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });

function makeRoot() {
    const root = document.createElement('div');
    root.setAttribute('data-ribbon-origin', 'ribbon');
    root.getBoundingClientRect = () => rect(0, 0, 1200, 48);
    const stamp = (key, r) => {
        const el = document.createElement('button');
        el.setAttribute('data-ribbon-origin', key);
        el.getBoundingClientRect = () => r;
        root.appendChild(el);
        return el;
    };
    const data = stamp('section:data', rect(300, 10, 80, 24));
    const ai = stamp('section:ai', rect(200, 10, 60, 24));
    document.body.appendChild(root);
    return { root, data, ai };
}

const DEF = {
    trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
    steps: [
        { id: 's1', type: 'set', label: 'Edit data' },
        { id: 's2', type: 'ai_step', label: 'Summarise' },
    ],
    edges: [{ from: 'trg', to: 's1' }, { from: 's1', to: 's2' }],
};

function makeRf() {
    return { flowToScreenPosition: vi.fn(p => ({ x: p.x + 5, y: p.y + 7 })), getZoom: () => 1, getNode: () => null };
}

function propsFor(over = {}) {
    return {
        queue: [],
        head: null,
        definition: DEF,
        catalog: null,
        rf: makeRf(),
        ribbonRootRef: { current: null },
        reducedMotion: false,
        enabled: true,
        ...over,
    };
}

describe('useRibbonFlight', () => {
    let fixture;
    beforeEach(() => {
        vi.useFakeTimers({ toFake: FAKES });
        vi.setSystemTime(T0);
        fixture = makeRoot();
    });
    afterEach(() => {
        vi.useRealTimers();
        fixture.root.remove();
    });

    it('rings the command at the card\'s departure and takes the ring off after PICK_HOLD_MS', () => {
        const props = propsFor({ head: { id: 's1', at: T0 }, ribbonRootRef: { current: fixture.root } });
        renderHook((p) => useRibbonFlight(p), { initialProps: props });
        act(() => { vi.advanceTimersByTime(0); });
        expect(fixture.data.classList.contains(PICK_CLASS)).toBe(true);
        act(() => { vi.advanceTimersByTime(PICK_HOLD_MS - 1); });
        expect(fixture.data.classList.contains(PICK_CLASS)).toBe(true);
        act(() => { vi.advanceTimersByTime(2); });
        expect(fixture.data.classList.contains(PICK_CLASS)).toBe(false);
    });

    it('the ghost takes off PICK_LEAD_MS after the ring, from the command\'s rect, and is gone after the flight and the fade', () => {
        const props = propsFor({ head: { id: 's1', at: T0 }, ribbonRootRef: { current: fixture.root } });
        const { result } = renderHook((p) => useRibbonFlight(p), { initialProps: props });
        act(() => { vi.advanceTimersByTime(PICK_LEAD_MS - 1); });
        expect(result.current.ghosts).toEqual([]);
        act(() => { vi.advanceTimersByTime(2); });
        expect(result.current.ghosts).toHaveLength(1);
        expect(result.current.ghosts[0]).toMatchObject({
            id: 's1',
            from: { left: 300, top: 10, width: 80, height: 24 },
            startedAt: T0 + PICK_LEAD_MS,
            glyph: { type: 'set', family: 'data', label: 'Edit data' },
        });
        act(() => { vi.advanceTimersByTime(FLY_MS + LAND_FADE_MS - 2); });
        expect(result.current.ghosts).toHaveLength(1);
        act(() => { vi.advanceTimersByTime(2); });
        expect(result.current.ghosts).toEqual([]);
        expect(FLIGHT_TOTAL_MS).toBe(PICK_LEAD_MS + FLY_MS);
        expect(FLIGHT_TOTAL_MS).toBe(600);
    });

    it('a queued card departs at its own instant, from its own command', () => {
        const props = propsFor({
            head: { id: 's1', at: T0 },
            queue: [{ id: 's2', at: T0 + 1200 }],
            ribbonRootRef: { current: fixture.root },
        });
        const { result } = renderHook((p) => useRibbonFlight(p), { initialProps: props });
        act(() => { vi.advanceTimersByTime(1199); });
        expect(fixture.ai.classList.contains(PICK_CLASS)).toBe(false);
        act(() => { vi.advanceTimersByTime(2); });
        expect(fixture.ai.classList.contains(PICK_CLASS)).toBe(true);
        act(() => { vi.advanceTimersByTime(PICK_LEAD_MS); });
        expect(result.current.ghosts.map(g => g.id)).toEqual(['s2']);
        expect(result.current.ghosts[0].glyph).toMatchObject({ type: 'ai_step', family: 'ai', label: 'Summarise' });
    });

    it('a React Flow that cannot aim gets the ring and no ghost, without throwing', () => {
        const rf = { getZoom: () => 1 }; // no flowToScreenPosition — the DiagramPane build test's spy
        const props = propsFor({ head: { id: 's1', at: T0 }, rf, ribbonRootRef: { current: fixture.root } });
        const { result } = renderHook((p) => useRibbonFlight(p), { initialProps: props });
        expect(() => { act(() => { vi.advanceTimersByTime(FLIGHT_TOTAL_MS + 100); }); }).not.toThrow();
        expect(result.current.ghosts).toEqual([]);
        // The ring was there and is gone again.
        expect(fixture.data.classList.contains(PICK_CLASS)).toBe(false);
    });

    it('no ribbon root, no stamp for the card, or a trigger → nothing happens', () => {
        const bare = document.createElement('div');
        const cases = [
            propsFor({ head: { id: 's1', at: T0 }, ribbonRootRef: { current: null } }),
            propsFor({ head: { id: 's1', at: T0 }, ribbonRootRef: { current: bare } }),
            propsFor({ head: { id: 'trg', at: T0 }, ribbonRootRef: { current: fixture.root } }),
            propsFor({ head: { id: 'nope', at: T0 }, ribbonRootRef: { current: fixture.root } }),
        ];
        for (const props of cases) {
            const { result, unmount } = renderHook((p) => useRibbonFlight(p), { initialProps: props });
            act(() => { vi.advanceTimersByTime(FLIGHT_TOTAL_MS); });
            expect(result.current.ghosts).toEqual([]);
            unmount();
        }
        expect(document.querySelectorAll(`.${PICK_CLASS}`).length).toBe(0);
    });

    it('disabling mid-flight takes the ring off, drops the ghost and fires nothing later', () => {
        const props = propsFor({
            head: { id: 's1', at: T0 },
            queue: [{ id: 's2', at: T0 + 1200 }],
            ribbonRootRef: { current: fixture.root },
        });
        const { result, rerender } = renderHook((p) => useRibbonFlight(p), { initialProps: props });
        act(() => { vi.advanceTimersByTime(PICK_LEAD_MS + 50); });
        expect(result.current.ghosts).toHaveLength(1);
        expect(fixture.data.classList.contains(PICK_CLASS)).toBe(true);
        rerender({ ...props, enabled: false });
        expect(result.current.ghosts).toEqual([]);
        expect(fixture.data.classList.contains(PICK_CLASS)).toBe(false);
        act(() => { vi.advanceTimersByTime(5000); });
        expect(result.current.ghosts).toEqual([]);
        expect(fixture.ai.classList.contains(PICK_CLASS)).toBe(false);
        // Reduced motion is the same off switch.
        rerender({ ...props, enabled: true, reducedMotion: true, head: { id: 's2', at: T0 + 6000 } });
        act(() => { vi.advanceTimersByTime(2000); });
        expect(result.current.ghosts).toEqual([]);
    });

    it('a card departs once, however often the queue is re-rendered or the effect re-run', () => {
        const props = propsFor({
            head: { id: 's1', at: T0 },
            queue: [{ id: 's2', at: T0 + 300 }],
            ribbonRootRef: { current: fixture.root },
        });
        const wrapper = ({ children }) => <React.StrictMode>{children}</React.StrictMode>;
        const { result, rerender } = renderHook((p) => useRibbonFlight(p), { initialProps: props, wrapper });
        // The same queue as a NEW array, and then the queue shrinking as the
        // choreography deals it — neither may arm s2 again.
        rerender({ ...props, queue: [{ id: 's2', at: T0 + 300 }] });
        rerender({ ...props, queue: [] });
        act(() => { vi.advanceTimersByTime(300 + PICK_LEAD_MS + 1); });
        expect(result.current.ghosts.map(g => g.id).sort()).toEqual(['s1', 's2']);
        expect(fixture.ai.classList.contains(PICK_CLASS)).toBe(true);
        act(() => { vi.advanceTimersByTime(PICK_HOLD_MS + 10); });
        expect(fixture.ai.classList.contains(PICK_CLASS)).toBe(false);
    });

    it('unmount clears every timer and ring', () => {
        const props = propsFor({ head: { id: 's1', at: T0 }, queue: [{ id: 's2', at: T0 + 1200 }], ribbonRootRef: { current: fixture.root } });
        const { unmount } = renderHook((p) => useRibbonFlight(p), { initialProps: props });
        act(() => { vi.advanceTimersByTime(10); });
        expect(fixture.data.classList.contains(PICK_CLASS)).toBe(true);
        unmount();
        expect(fixture.data.classList.contains(PICK_CLASS)).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });
});
