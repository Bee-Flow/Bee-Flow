import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React, { useRef } from 'react';
import { useCanvasWheel } from './useCanvasWheel';
import type { CanvasCamera, CanvasStore } from './useCanvasWheel';
import type { Viewport } from './wheelInput';

/**
 * The DOM side of the canvas's wheel input: which events it takes, which it
 * leaves alone, and that the ones it takes never reach React Flow's own wheel
 * handler (stood in for here by a bubbling listener on the renderer).
 *
 * The markup mirrors React Flow's: the renderer holds the pane and the
 * viewport with the cards in it; the panels (overlays) are its siblings.
 */

function Harness({ rf, store, enabled = true }: { rf: CanvasCamera; store: CanvasStore; enabled?: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    useCanvasWheel({ wrapperRef: ref, rf, store, enabled });
    return (
        <div ref={ref} data-testid="wrapper">
            <div className="react-flow__renderer" data-testid="renderer">
                <div className="react-flow__pane" data-testid="pane" />
                <div className="react-flow__viewport">
                    <div className="react-flow__node" data-testid="card">
                        <span data-testid="card-label">Step</span>
                        <textarea data-testid="note-text" defaultValue="long note" />
                        <div className="nowheel" data-testid="nowheel" />
                    </div>
                </div>
            </div>
            <div className="react-flow__panel" data-testid="overlay">
                <ul data-testid="legend-list"><li>row</li></ul>
            </div>
        </div>
    );
}

let vp: Viewport;
let rf: CanvasCamera & { setViewport: Mock<(next: Viewport) => void> };
let state: { minZoom: number; maxZoom: number; userSelectionActive: boolean };
let store: CanvasStore;
let reactFlowSaw: Mock<(e: Event) => void>;

function mount(enabled = true) {
    const utils = render(<Harness rf={rf} store={store} enabled={enabled} />);
    screen.getByTestId('renderer').addEventListener('wheel', reactFlowSaw);
    return utils;
}

let clock = 1000;
function wheel(testId: string, init: WheelEventInit, gapMs = 16): WheelEvent {
    clock += gapMs;
    const ev = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 200, clientY: 100, ...init });
    Object.defineProperty(ev, 'timeStamp', { value: clock });
    screen.getByTestId(testId).dispatchEvent(ev);
    return ev;
}

function gesture(testId: string, type: string, props: Record<string, number> = {}): Event {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(ev, props);
    screen.getByTestId(testId).dispatchEvent(ev);
    return ev;
}

beforeEach(() => {
    vp = { x: 0, y: 0, zoom: 1 };
    rf = {
        getViewport: () => vp,
        setViewport: vi.fn<(next: Viewport) => void>((next) => { vp = next; }),
    };
    state = { minZoom: 0.5, maxZoom: 2, userSelectionActive: false };
    store = { getState: () => state };
    reactFlowSaw = vi.fn<(e: Event) => void>();
    clock += 10_000; // every test starts a fresh gesture
});
afterEach(cleanup);

describe('useCanvasWheel: the canvas moves', () => {
    it('two fingers on a touchpad pan the canvas; the zoom never changes', () => {
        mount();
        const evs = [
            wheel('pane', { deltaX: 1.5, deltaY: 2.25 }),
            wheel('pane', { deltaX: 4, deltaY: 6.5 }),
            wheel('card-label', { deltaX: 0, deltaY: 12 }),
        ];
        expect(vp).toEqual({ x: -5.5, y: -20.75, zoom: 1 });
        expect(evs.every(e => e.defaultPrevented)).toBe(true);
        expect(reactFlowSaw).not.toHaveBeenCalled();
    });

    it('a pinch (ctrl+wheel) zooms around the fingers', () => {
        mount();
        const ev = wheel('pane', { ctrlKey: true, deltaY: -100 * Math.log(1.1), clientX: 300, clientY: 150 });
        expect(ev.defaultPrevented).toBe(true);
        expect(vp.zoom).toBeCloseTo(1.1, 10);
        // The flow point under the fingers (300, 150 at zoom 1) is still there.
        expect((300 - vp.x) / vp.zoom).toBeCloseTo(300, 8);
        expect((150 - vp.y) / vp.zoom).toBeCloseTo(150, 8);
        expect(reactFlowSaw).not.toHaveBeenCalled();
    });

    it('a mouse wheel notch zooms around the pointer at the old speed', () => {
        mount();
        wheel('pane', { deltaY: 100, clientX: 200, clientY: 100 });
        expect(vp.zoom).toBeCloseTo(2 ** -0.2, 10);
        expect((200 - vp.x) / vp.zoom).toBeCloseTo(200, 8);
        expect(reactFlowSaw).not.toHaveBeenCalled();
    });

    it('Shift + mouse wheel pans sideways', () => {
        mount();
        wheel('pane', { deltaY: 100, shiftKey: true });
        expect(vp).toEqual({ x: -100, y: 0, zoom: 1 });
    });

});

describe('useCanvasWheel: what it leaves alone', () => {
    it('an overlay keeps its own scrolling: nothing moves and nothing is prevented', () => {
        mount();
        const ev = wheel('legend-list', { deltaY: 6.5, deltaX: 1 });
        expect(ev.defaultPrevented).toBe(false);
        expect(rf.setViewport).not.toHaveBeenCalled();
    });

    it('a pinch over an overlay zooms neither the canvas nor the browser page', () => {
        mount();
        const ev = wheel('legend-list', { ctrlKey: true, deltaY: -3 });
        expect(ev.defaultPrevented).toBe(true);
        expect(rf.setViewport).not.toHaveBeenCalled();
    });

    it('.nowheel and a note being edited scroll natively, out of React Flow\'s reach', () => {
        mount();
        for (const id of ['nowheel', 'note-text']) {
            const ev = wheel(id, { deltaY: 8 }, 1000);
            expect(ev.defaultPrevented).toBe(false);
        }
        expect(rf.setViewport).not.toHaveBeenCalled();
        expect(reactFlowSaw).not.toHaveBeenCalled();
    });

    it('a pinch over a note zooms the canvas (a textarea has no use for it)', () => {
        mount();
        wheel('note-text', { ctrlKey: true, deltaY: -5 });
        expect(vp.zoom).toBeGreaterThan(1);
    });

    it('nothing moves while a selection box is being drawn', () => {
        mount();
        state.userSelectionActive = true;
        const ev = wheel('pane', { deltaY: 4, deltaX: 1 });
        expect(ev.defaultPrevented).toBe(true);
        expect(rf.setViewport).not.toHaveBeenCalled();
    });

    it('the zoom limits come from React Flow\'s store', () => {
        mount();
        state.maxZoom = 1.05;
        wheel('pane', { ctrlKey: true, deltaY: -20 });
        expect(vp.zoom).toBe(1.05);
    });

});

describe('useCanvasWheel: Safari gestures and lifecycle', () => {
    it('Safari: a gesture pinch zooms by its cumulative scale around the fingers', () => {
        mount();
        const start = gesture('pane', 'gesturestart', { scale: 1, clientX: 100, clientY: 50 });
        expect(start.defaultPrevented).toBe(true);
        gesture('pane', 'gesturechange', { scale: 1.1, clientX: 100, clientY: 50 });
        expect(vp.zoom).toBeCloseTo(1.1, 10);
        gesture('pane', 'gesturechange', { scale: 1.2, clientX: 100, clientY: 50 });
        expect(vp.zoom).toBeCloseTo(1.2, 10);
        expect((100 - vp.x) / vp.zoom).toBeCloseTo(100, 8);
        // A ctrl+wheel arriving mid-gesture must not zoom a second time.
        wheel('pane', { ctrlKey: true, deltaY: -10 });
        expect(vp.zoom).toBeCloseTo(1.2, 10);
        const end = gesture('pane', 'gestureend', { scale: 1.2 });
        expect(end.defaultPrevented).toBe(true);
    });

    it('Safari: a gesture over an overlay is kept from zooming the page, and leaves the canvas alone', () => {
        mount();
        expect(gesture('legend-list', 'gesturestart', { scale: 1 }).defaultPrevented).toBe(true);
        expect(gesture('legend-list', 'gesturechange', { scale: 1.5 }).defaultPrevented).toBe(true);
        expect(rf.setViewport).not.toHaveBeenCalled();
    });

    it('disabled (a read-only canvas): React Flow gets the events as before', () => {
        mount(false);
        const ev = wheel('pane', { deltaY: 100 });
        expect(ev.defaultPrevented).toBe(false);
        expect(rf.setViewport).not.toHaveBeenCalled();
        expect(reactFlowSaw).toHaveBeenCalledTimes(1);
    });

    it('unmounting removes the listeners', () => {
        const { unmount, container } = mount();
        const wrapper = container.firstElementChild as HTMLElement;
        const pane = screen.getByTestId('pane');
        unmount();
        wrapper.appendChild(pane);
        pane.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100 }));
        expect(rf.setViewport).not.toHaveBeenCalled();
    });
});
