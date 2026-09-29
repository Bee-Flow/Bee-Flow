import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The Fit button hands the camera back to the build. A gesture on the canvas
 * takes it away (the hook stops following); Fit is "show me everything again",
 * and pressing it must re-arm following without a second control — so `onFit`
 * IS the press when it is given (the hand-back takes its own wide shot; a
 * second fit from the stack on top of it was two moves), and without it the
 * stack fits on its own.
 */
const rf = { zoomIn: vi.fn(), zoomOut: vi.fn(), zoomTo: vi.fn(), fitView: vi.fn() };
vi.mock('@xyflow/react', async (importOriginal) => {
    const orig = await importOriginal();
    return {
        ...orig,
        useReactFlow: () => rf,
        useStore: (selector) => selector({ transform: [0, 0, 0.5] }),
    };
});

const { default: CanvasZoomStack } = await import('./CanvasZoomStack');

describe('CanvasZoomStack — Fit re-arms following', () => {
    beforeEach(() => { cleanup(); for (const fn of Object.values(rf)) fn.mockReset(); });

    it('shows the store zoom as a rounded percentage', () => {
        render(<CanvasZoomStack />);
        expect(screen.getByTestId('canvas-zoom-pct').textContent).toBe('50%');
    });

    it('Fit with onFit is one act: onFit once, and no fitView of the stack\'s own on top of it', () => {
        const onFit = vi.fn();
        render(<CanvasZoomStack onFit={onFit} />);
        fireEvent.click(screen.getByRole('button', { name: /fit the whole flow/i }));
        expect(onFit).toHaveBeenCalledTimes(1);
        expect(rf.fitView).not.toHaveBeenCalled();
    });

    it('Fit without onFit still fits — the prop is optional', () => {
        render(<CanvasZoomStack />);
        expect(() => fireEvent.click(screen.getByRole('button', { name: /fit the whole flow/i }))).not.toThrow();
        expect(rf.fitView).toHaveBeenCalledTimes(1);
    });

    it('a canvas that is gone does not throw out of the stack\'s own fit', () => {
        rf.fitView.mockImplementation(() => { throw new Error('no flow'); });
        render(<CanvasZoomStack />);
        expect(() => fireEvent.click(screen.getByRole('button', { name: /fit the whole flow/i }))).not.toThrow();
    });
});

describe('CanvasZoomStack — the presenter toggle', () => {
    beforeEach(() => { cleanup(); for (const fn of Object.values(rf)) fn.mockReset(); });

    it('is absent without a handler — a thumbnail or inspector canvas has no projector', () => {
        render(<CanvasZoomStack />);
        expect(screen.queryByTestId('canvas-presenter-toggle')).toBeNull();
    });

    it('reads as an unpressed switch, says what it does, and calls the handler once per press', () => {
        const onTogglePresenter = vi.fn();
        render(<CanvasZoomStack presenter={false} onTogglePresenter={onTogglePresenter} />);
        const btn = screen.getByTestId('canvas-presenter-toggle');
        expect(btn.getAttribute('aria-pressed')).toBe('false');
        expect(btn.getAttribute('aria-label')).toBe('Presenter mode');
        expect(btn.getAttribute('title')).toMatch(/projector/i);
        fireEvent.click(btn);
        expect(onTogglePresenter).toHaveBeenCalledTimes(1);
        // The press itself moves no camera: the mode changes how things read.
        expect(rf.fitView).not.toHaveBeenCalled();
        expect(rf.zoomTo).not.toHaveBeenCalled();
    });

    it('pressed, it offers the way out', () => {
        render(<CanvasZoomStack presenter onTogglePresenter={() => {}} />);
        const btn = screen.getByTestId('canvas-presenter-toggle');
        expect(btn.getAttribute('aria-pressed')).toBe('true');
        expect(btn.getAttribute('aria-label')).toBe('Leave presenter mode');
    });
});

/**
 * A short canvas (the step drawer open on a laptop screen) lays the stack
 * down as one row, − 100% + fit, and leaves the whole-canvas acts out.
 */
describe('CanvasZoomStack — compact, on a short canvas', () => {
    beforeEach(() => { cleanup(); for (const fn of Object.values(rf)) fn.mockReset(); });

    it('is one row: zoom out, the percentage, zoom in, fit', () => {
        render(<CanvasZoomStack compact onWrapToFit={() => {}} onTogglePresenter={() => {}} />);
        const stack = screen.getByTestId('canvas-zoom-stack');
        expect(stack.className).toContain('flex-row');
        expect(stack.hasAttribute('data-compact')).toBe(true);
        expect([...stack.querySelectorAll('button')].map(b => b.getAttribute('aria-label')))
            .toEqual(['Zoom out', 'Zoom to 100%', 'Zoom in', 'Fit the whole flow on screen']);
    });

    it('leaves out Wrap to fit and the presenter switch until the canvas has room', () => {
        render(<CanvasZoomStack compact onWrapToFit={() => {}} onTogglePresenter={() => {}} />);
        expect(screen.queryByRole('button', { name: 'Wrap to fit' })).toBeNull();
        expect(screen.queryByTestId('canvas-presenter-toggle')).toBeNull();
    });

    it('standing, it keeps every control in its column', () => {
        render(<CanvasZoomStack onWrapToFit={() => {}} onTogglePresenter={() => {}} />);
        const stack = screen.getByTestId('canvas-zoom-stack');
        expect(stack.className).toContain('flex-col');
        expect(stack.querySelectorAll('button')).toHaveLength(6);
    });
});
