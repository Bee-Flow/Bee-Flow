import { render, act, cleanup } from '@testing-library/react';
import { Pencil } from 'lucide-react';
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import RibbonFlightLayer from './RibbonFlightLayer';
import { FLY_MS } from './useRibbonFlight';

/**
 * The ghost card in flight. Pinned: it is portalled to <body> in a layer that
 * takes no pointer events; it shows the app's logo for an app step and the
 * step icon otherwise; its transform is written from a rAF loop that re-reads
 * the destination EVERY frame (the camera moves while the ghost is in the
 * air); and it wears the landing class once it has arrived.
 */
const FAKES = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame'];
const T0 = 100000;

const from = { left: 100, top: 20, width: 40, height: 24 };
const nodes = [{ id: 's1', position: { x: 400, y: 200 } }, { id: 'kid', position: { x: 10, y: 10 }, parentId: 's1' }];

function rfAt(x, y) {
    const dest = { x, y };
    return {
        dest,
        flowToScreenPosition: vi.fn(() => ({ x: dest.x, y: dest.y })),
        getZoom: () => 1,
        getNode: () => null,
    };
}

const translateX = (el) => Number(/translate\(([-\d.]+)px/.exec(el.style.transform)?.[1]);

describe('RibbonFlightLayer', () => {
    beforeEach(() => { cleanup(); vi.useFakeTimers({ toFake: FAKES }); vi.setSystemTime(T0); });
    afterEach(() => { vi.useRealTimers(); });

    it('renders nothing without ghosts, and a body-level pointer-transparent layer with them', () => {
        const rf = rfAt(500, 300);
        const { rerender, container } = render(<RibbonFlightLayer ghosts={[]} rf={rf} nodes={nodes} />);
        expect(container.firstChild).toBeNull();
        expect(document.querySelector('[data-testid="ribbon-flight-layer"]')).toBeNull();
        rerender(<RibbonFlightLayer ghosts={[{ id: 's1', from, startedAt: T0, glyph: { type: 'set', family: 'data', label: 'Edit data', icon: Pencil } }]} rf={rf} nodes={nodes} />);
        const layer = document.querySelector('[data-testid="ribbon-flight-layer"]');
        expect(layer).toBeTruthy();
        expect(layer.parentElement).toBe(document.body);
        expect(layer.style.pointerEvents).toBe('none');
        expect(layer.style.position).toBe('fixed');
        expect(layer.style.zIndex).toBe('1100');
        const ghost = layer.querySelector('[data-testid="ribbon-flight-ghost"]');
        expect(ghost.textContent).toBe('Edit data');
        expect(ghost.style.position).toBe('fixed');
    });

    it('shows the app logo for an app step and the step icon for anything else', () => {
        const rf = rfAt(500, 300);
        render(<RibbonFlightLayer ghosts={[
            { id: 's1', from, startedAt: T0, glyph: { type: 'integration_action', integrationId: 'gmail', tool: 'gmail_send', family: 'app', label: 'Send' } },
        ]} rf={rf} nodes={nodes} />);
        const app = document.querySelector('[data-testid="ribbon-flight-ghost"]');
        expect(app.querySelector('svg, img, [aria-label]')).toBeTruthy();
        expect(app.querySelector('.lucide-pencil')).toBeNull();
        cleanup();
        render(<RibbonFlightLayer ghosts={[
            { id: 's1', from, startedAt: T0, glyph: { type: 'set', family: 'data', label: 'Edit data', icon: Pencil, iconName: null } },
            { id: 'kid', from, startedAt: T0, glyph: { type: 'set', family: 'data', label: 'Custom', icon: null, iconName: 'Rocket' } },
        ]} rf={rf} nodes={nodes} />);
        const ghosts = document.querySelectorAll('[data-testid="ribbon-flight-ghost"]');
        expect(ghosts[0].querySelector('.lucide-pencil')).toBeTruthy();
        expect(ghosts[1].querySelector('.lucide-rocket')).toBeTruthy();
    });

    it('starts on the command, flies toward the destination, and re-aims when the viewport moves', () => {
        const rf = rfAt(500, 300);
        render(<RibbonFlightLayer ghosts={[{ id: 's1', from, startedAt: T0, glyph: { type: 'set', family: 'data', label: 'x', icon: Pencil } }]} rf={rf} nodes={nodes} />);
        const ghost = document.querySelector('[data-testid="ribbon-flight-ghost"]');
        // First frame, synchronous on mount: at the command, scaled down to its tile.
        expect(ghost.style.transform).toBe(`translate(${from.left}px, ${from.top}px) scale(${40 / 240})`);
        act(() => { vi.advanceTimersByTime(FLY_MS / 2); });
        const midway = translateX(ghost);
        expect(midway).toBeGreaterThan(from.left);
        expect(midway).toBeLessThan(500);
        // The camera moves the slot: the next frame heads for where it is NOW.
        rf.dest.x = 900;
        act(() => { vi.advanceTimersByTime(16); });
        expect(translateX(ghost)).toBeGreaterThan(500);
        expect(rf.flowToScreenPosition.mock.calls.length).toBeGreaterThan(2);
        // A child's destination is its absolute position (parents added back).
        expect(rf.flowToScreenPosition).toHaveBeenLastCalledWith({ x: 400, y: 200 });
    });

    it('lands exactly on the slot at zoom, then wears the landing class', () => {
        const rf = rfAt(500, 300);
        rf.getZoom = () => 0.8;
        render(<RibbonFlightLayer ghosts={[{ id: 'kid', from, startedAt: T0, glyph: { type: 'set', family: 'data', label: 'x', icon: Pencil } }]} rf={rf} nodes={nodes} />);
        const ghost = document.querySelector('[data-testid="ribbon-flight-ghost"]');
        act(() => { vi.advanceTimersByTime(FLY_MS + 32); });
        expect(ghost.style.transform).toBe('translate(500px, 300px) scale(0.8)');
        expect(ghost.classList.contains('bf-fly-ghost-land')).toBe(true);
        // …and the absolute position of a nested node was what was aimed at.
        expect(rf.flowToScreenPosition).toHaveBeenLastCalledWith({ x: 410, y: 210 });
    });

    it('a React Flow that cannot aim leaves the ghost where it started rather than throwing', () => {
        const rf = { getZoom: () => 1 };
        render(<RibbonFlightLayer ghosts={[{ id: 's1', from, startedAt: T0, glyph: { type: 'set', family: 'data', label: 'x' } }]} rf={rf} nodes={nodes} />);
        const ghost = document.querySelector('[data-testid="ribbon-flight-ghost"]');
        expect(() => { act(() => { vi.advanceTimersByTime(FLY_MS + 32); }); }).not.toThrow();
        expect(translateX(ghost)).toBe(from.left);
    });
});
