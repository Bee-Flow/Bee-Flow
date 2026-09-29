import { getViewportForBounds } from '@xyflow/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
    FIT_PADDING, LINE_GUTTER_FLOW, fractionInsets, furnitureInsets, furniturePadding, graphBounds, measureFurniture,
    type Box, type Bounds, type Insets,
} from './furnitureFit';

/**
 * The canvas's own fits keep the cards clear of the furniture: the zoom
 * stack, the minimap, the legend, the chips and the south bar. What is
 * pinned: nothing in the way changes nothing; each piece is passed on the
 * side that costs no zoom when there is one; the dashed line back to the
 * next row is cleared too; and wherever React Flow then puts the graph, no
 * card lands under a piece of furniture.
 */

// The 1280×800 builder: the canvas pane is 1280×703.
const W = 1280;
const H = 703;
const BASE = fractionInsets(W, H);
const ZOOM = { minZoom: 0.5, maxZoom: 2 };
// South-west: the zoom stack, 32×182 at the panel's 15px margin.
const STACK: Box = { left: 15, top: H - 15 - 182, right: 47, bottom: H - 15 };
// South-east: the minimap, 160×96.
const MINIMAP: Box = { left: W - 15 - 160, top: H - 15 - 96, right: W - 15, bottom: H - 15 };
// A long left-to-right flow in two rows: wider than the pane, not as tall.
const WIDE: Bounds = { x: 0, y: 0, width: 1520, height: 440 };
// A flow wrapped into many rows: taller than the pane allows.
const TALL: Bounds = { x: 0, y: 0, width: 400, height: 900 };

const zoomOf = (i: Insets, b: Bounds) => Math.min(ZOOM.maxZoom, (W - i.left - i.right) / b.width, (H - i.top - i.bottom) / b.height);

/** Where React Flow puts the graph for this padding, in pane px. */
function placed(bounds: Bounds, insets: Insets, width = W, height = H): Box {
    const padding = { top: `${insets.top}px`, right: `${insets.right}px`, bottom: `${insets.bottom}px`, left: `${insets.left}px` } as const;
    const { x, y, zoom } = getViewportForBounds(bounds, width, height, ZOOM.minZoom, ZOOM.maxZoom, padding);
    return { left: x + bounds.x * zoom, top: y + bounds.y * zoom, right: x + (bounds.x + bounds.width) * zoom, bottom: y + (bounds.y + bounds.height) * zoom };
}
const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

describe('fractionInsets — React Flow\'s own reading of 0.08', () => {
    it('is the px padding a plain fitView({ padding: 0.08 }) gives each side', () => {
        expect(fractionInsets(1280, 703, FIT_PADDING)).toEqual({ top: 26, right: 47, bottom: 26, left: 47 });
    });
});

describe('furnitureInsets — clear of the furniture, at the highest zoom', () => {
    it('with nothing in the way the fit is the old fit', () => {
        expect(furnitureInsets({ width: W, height: H, bounds: WIDE, obstacles: [], base: BASE, ...ZOOM })).toEqual(BASE);
    });

    it('a wide flow passes the zoom stack below-left of it: height is free, width is not', () => {
        const insets = furnitureInsets({ width: W, height: H, bounds: WIDE, obstacles: [STACK], base: BASE, ...ZOOM });
        expect(insets.left).toBe(BASE.left);
        expect(insets.bottom).toBe(H - STACK.top + 12);
        expect(zoomOf(insets, WIDE)).toBeCloseTo(zoomOf(BASE, WIDE), 6);
        expect(overlaps(placed(WIDE, insets), STACK)).toBe(false);
    });

    it('a tall flow passes it on the left instead, clearing the line back to the next row too', () => {
        const insets = furnitureInsets({ width: W, height: H, bounds: TALL, obstacles: [STACK], base: BASE, ...ZOOM });
        expect(insets.bottom).toBe(BASE.bottom);
        const zoom = zoomOf(insets, TALL);
        expect(zoom).toBeCloseTo(zoomOf(BASE, TALL), 6);
        // The line runs LINE_GUTTER_FLOW outside the cards; it too stays right of the stack.
        const graph = placed(TALL, insets);
        expect(graph.left - LINE_GUTTER_FLOW * zoom).toBeGreaterThanOrEqual(STACK.right);
    });

    it('with the zoom at its cap, takes the way that moves the graph least', () => {
        const small: Bounds = { x: 0, y: 0, width: 300, height: 100 };
        const insets = furnitureInsets({ width: W, height: H, bounds: small, obstacles: [MINIMAP], base: BASE, minZoom: 0.5, maxZoom: 1 });
        // Up by 123px, rather than in from the right by 219.
        expect(insets).toEqual({ ...BASE, bottom: H - MINIMAP.top + 12 });
    });

    it('at 1920 with the legend open, no card lands under any of it', () => {
        const w = 1920;
        const h = 983;
        const legend: Box = { left: w - 15 - 232, top: 51, right: w - 15, bottom: 260 };
        const lens: Box = { left: w - 15 - 216, top: 15, right: w - 15, bottom: 45 };
        const chips: Box = { left: 15, top: 15, right: 338, bottom: 45 };
        const stack: Box = { left: 15, top: h - 197, right: 47, bottom: h - 15 };
        const minimap: Box = { left: w - 175, top: h - 111, right: w - 15, bottom: h - 15 };
        const southBar: Box = { left: 700, top: h - 61, right: 1220, bottom: h - 15 };
        const bounds: Bounds = { x: 0, y: -30, width: 1520, height: 466 };
        const obstacles = [legend, lens, chips, stack, minimap, southBar];
        const insets = furnitureInsets({ width: w, height: h, bounds, obstacles, base: fractionInsets(w, h), ...ZOOM });
        const graph = placed(bounds, insets, w, h);
        for (const piece of obstacles) expect(overlaps(graph, piece)).toBe(false);
    });

    it('ignores furniture that is empty or off the pane, and a graph with no size', () => {
        const empty: Box = { left: 600, top: 680, right: 600, bottom: 680 };
        const off: Box = { left: -200, top: 10, right: -100, bottom: 40 };
        expect(furnitureInsets({ width: W, height: H, bounds: WIDE, obstacles: [empty, off], base: BASE, ...ZOOM })).toEqual(BASE);
        expect(furnitureInsets({ width: W, height: H, bounds: null, obstacles: [STACK], base: BASE, ...ZOOM })).toEqual(BASE);
    });
});

describe('graphBounds — what React Flow frames', () => {
    it('spans the measured, visible nodes only', () => {
        const node = (x: number, y: number, w?: number, h?: number, hidden = false) => ({
            hidden, measured: { width: w, height: h }, internals: { positionAbsolute: { x, y }, z: 0, userNode: {} as never },
        });
        expect(graphBounds([node(0, 0, 240, 72), node(320, 100, 240, 72), node(5000, 0, 240, 72, true), node(-900, 0)]))
            .toEqual({ x: 0, y: 0, width: 560, height: 172 });
        expect(graphBounds([])).toBeNull();
    });
});

describe('measureFurniture — the panels on the pane', () => {
    afterEach(() => { document.body.innerHTML = ''; });

    const at = (el: Element, left: number, top: number, width: number, height: number) => {
        el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) });
    };

    it('one box per panel, relative to the pane; a parts row counts piece by piece', () => {
        document.body.innerHTML = `
            <div id="pane">
                <div class="react-flow__panel top right" id="ne"></div>
                <div class="react-flow__panel bottom left">
                    <div data-furniture-parts><div id="stack"></div><button id="flowlets"></button></div>
                </div>
                <div class="react-flow__panel bottom center" id="empty"></div>
            </div>`;
        const pane = document.getElementById('pane') as HTMLElement;
        at(pane, 0, 100, 1280, 703);
        at(document.getElementById('ne') as HTMLElement, 1033, 115, 232, 245);
        at(document.getElementById('stack') as HTMLElement, 15, 606, 32, 182);
        at(document.getElementById('flowlets') as HTMLElement, 55, 758, 86, 30);
        at(document.getElementById('empty') as HTMLElement, 640, 788, 0, 0);
        expect(measureFurniture(pane)).toEqual([
            { left: 1033, top: 15, right: 1265, bottom: 260 },
            { left: 15, top: 506, right: 47, bottom: 688 },
            { left: 55, top: 658, right: 141, bottom: 688 },
        ]);
        expect(measureFurniture(null)).toEqual([]);
    });
});

describe('furniturePadding — what goes to fitView', () => {
    it('falls back to the plain fraction when there is nothing to measure', () => {
        expect(furniturePadding({ pane: null, width: W, height: H, nodes: [], ...ZOOM })).toBe(FIT_PADDING);
    });
});
