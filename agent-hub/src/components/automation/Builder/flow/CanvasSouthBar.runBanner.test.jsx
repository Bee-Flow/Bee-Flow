import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import CanvasSouthBar from './CanvasSouthBar';

/**
 * The run banner's two claims: how long this has been going, and the one
 * control that un-parks a run waiting on a form.
 *
 * `formatElapsed` and `computeRunFocus` were already pinned (flow/runFocus.
 * test.js). What was not: that the banner actually RENDERS the clock, and that
 * "Open the form" is absent when there is no form page to open. A dead link on
 * a stuck run is worse than no link — the user clicks it, nothing happens, and
 * the run stays parked.
 */
const focus = (over = {}) => ({
    stepId: 's1', label: 'Ask for approval', done: 1, total: 3,
    state: 'running', startedAt: null, awaitingForm: false, ...over,
});

describe('CanvasSouthBar — the run banner', () => {
    beforeEach(() => { cleanup(); vi.useRealTimers(); });

    it('shows no elapsed clock when the run has no start time', () => {
        // A run row without startedAt is a run we cannot time. "0s" would be a
        // number the banner invented.
        render(<CanvasSouthBar runFocus={focus()} />);
        expect(screen.getByTestId('canvas-run-banner')).toBeTruthy();
        expect(screen.queryByTestId('canvas-run-elapsed')).toBeNull();
    });

    it('counts the elapsed time from startedAt', () => {
        const started = new Date(Date.now() - (12 * 60 + 33) * 1000).toISOString();
        render(<CanvasSouthBar runFocus={focus({ startedAt: started })} />);
        expect(screen.getByTestId('canvas-run-elapsed').textContent).toContain('12m 33s');
    });

    it('keeps the clock on a FAILED run — it says when it stopped, and stops ticking', () => {
        const started = new Date(Date.now() - 9000).toISOString();
        render(<CanvasSouthBar runFocus={focus({ state: 'error', startedAt: started })} />);
        expect(screen.getByTestId('canvas-run-elapsed').textContent).toContain('9s');
        expect(screen.getByTestId('canvas-run-banner').textContent).toContain('Run failed at');
    });

    it('offers "Open the form" only when the run is parked on one AND a page exists', () => {
        render(<CanvasSouthBar runFocus={focus({ awaitingForm: true })} formUrl="https://example.test/f/abc" />);
        const link = screen.getByTestId('canvas-run-open-form');
        expect(link.tagName).toBe('A');
        expect(link.getAttribute('href')).toBe('https://example.test/f/abc');
        // An anchor a viewer can middle-click, and one that cannot leak the
        // opener to the form page.
        expect(link.getAttribute('rel')).toContain('noopener');
        expect(screen.getByTestId('canvas-run-banner').textContent).toContain('waiting for the form');
    });

    it('draws NO link when the automation is parked but has no form page provisioned', () => {
        // Never a dead control: the refusal path this whole banner is judged on.
        render(<CanvasSouthBar runFocus={focus({ awaitingForm: true })} formUrl={null} />);
        expect(screen.queryByTestId('canvas-run-open-form')).toBeNull();
    });

    it('draws no link on an ordinary running step even with a form url around', () => {
        render(<CanvasSouthBar runFocus={focus({ awaitingForm: false })} formUrl="https://example.test/f/abc" />);
        expect(screen.queryByTestId('canvas-run-open-form')).toBeNull();
    });

    it('renders nothing of the banner when there is no run at all', () => {
        render(<CanvasSouthBar runFocus={null} />);
        expect(screen.queryByTestId('canvas-run-banner')).toBeNull();
    });
});
