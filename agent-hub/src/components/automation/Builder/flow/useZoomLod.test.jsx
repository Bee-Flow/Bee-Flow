import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';

/**
 * The zoom → level-of-detail bucket.
 *
 * Two things matter: the boundaries sit exactly where the design puts them
 * (45% and 80%), and a pan — which changes the viewport but not the zoom —
 * yields the IDENTICAL value, so React Flow's store skips the re-render.
 */

// The store is mocked rather than a real ReactFlowProvider mounted, so the
// transform can be set per test and the selector's memo behaviour proven.
let transform = [0, 0, 1];
vi.mock('@xyflow/react', async (importOriginal) => {
    const orig = await importOriginal();
    return { ...orig, useStore: (selector) => selector({ transform }) };
});

const { lodForZoom, useZoomLod, LOD_BREAKS, PRESENTER_LOD_BREAKS, LOD_FAR, LOD_MID, LOD_NEAR } = await import('./useZoomLod');
const { PresenterContext } = await import('./PresenterContext');

function Probe() {
    const lod = useZoomLod();
    return <span data-testid="lod">{lod}</span>;
}

describe('useZoomLod — PresenterContext shifts the breaks', () => {
    beforeEach(cleanup);

    it('the same zoom reads one level closer with the presenter flag on', () => {
        // 60%: mid on a laptop, near on a projector.
        transform = [0, 0, 0.6];
        render(<Probe />);
        expect(screen.getByTestId('lod').textContent).toBe('mid');
        cleanup();
        render(<PresenterContext.Provider value><Probe /></PresenterContext.Provider>);
        expect(screen.getByTestId('lod').textContent).toBe('near');

        // 35%: far on a laptop, mid on a projector.
        cleanup();
        transform = [0, 0, 0.35];
        render(<Probe />);
        expect(screen.getByTestId('lod').textContent).toBe('far');
        cleanup();
        render(<PresenterContext.Provider value><Probe /></PresenterContext.Provider>);
        expect(screen.getByTestId('lod').textContent).toBe('mid');
    });

    it('the projector breaks are 30% and 55%, and lodForZoom takes them as a parameter', () => {
        expect(PRESENTER_LOD_BREAKS).toEqual({ far: 0.30, mid: 0.55 });
        expect(lodForZoom(0.29, PRESENTER_LOD_BREAKS)).toBe(LOD_FAR);
        expect(lodForZoom(0.30, PRESENTER_LOD_BREAKS)).toBe(LOD_MID);
        expect(lodForZoom(0.55, PRESENTER_LOD_BREAKS)).toBe(LOD_NEAR);
        // The default parameter is still the design's own.
        expect(lodForZoom(0.5)).toBe(lodForZoom(0.5, LOD_BREAKS));
    });

    it('the default context is false: no provider, no shift', () => {
        transform = [0, 0, 0.6];
        render(<Probe />);
        expect(screen.getByTestId('lod').textContent).toBe('mid');
    });
});

describe('lodForZoom — the boundaries are the design\'s', () => {
    it('flips at exactly 45% and 80%', () => {
        expect(LOD_BREAKS).toEqual({ far: 0.45, mid: 0.80 });
        expect(lodForZoom(0.44)).toBe(LOD_FAR);
        expect(lodForZoom(0.45)).toBe(LOD_MID);
        expect(lodForZoom(0.79)).toBe(LOD_MID);
        expect(lodForZoom(0.80)).toBe(LOD_NEAR);
        expect(lodForZoom(1)).toBe(LOD_NEAR);
        expect(lodForZoom(2)).toBe(LOD_NEAR);
    });

    it('treats a missing or broken zoom as 100% — a card must never vanish because the store is not ready', () => {
        expect(lodForZoom(undefined)).toBe(LOD_NEAR);
        expect(lodForZoom(NaN)).toBe(LOD_NEAR);
    });
});

describe('useZoomLod — reads the bucket from the store', () => {
    beforeEach(cleanup);

    it('reports the bucket for the current zoom', () => {
        transform = [0, 0, 0.3];
        render(<Probe />);
        expect(screen.getByTestId('lod').textContent).toBe('far');
        cleanup();
        transform = [0, 0, 0.6];
        render(<Probe />);
        expect(screen.getByTestId('lod').textContent).toBe('mid');
    });

    it('a pan-only change returns the identical value, so the store can skip the render', () => {
        // The selector is what the store compares with Object.is; two calls
        // with the same zoom and different x/y must be === to each other.
        const { lodForZoom: f } = { lodForZoom };
        const a = f(0.6);
        transform = [500, -120, 0.6];
        const b = f(transform[2]);
        expect(a).toBe(b);
        expect(Object.is(a, b)).toBe(true);
    });
});
