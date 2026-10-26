import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import CanvasSouthBar from './CanvasSouthBar';
import type { ComponentProps } from 'react';
import { stub } from '@/test/mocks';

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
        render(<CanvasSouthBar runFocus={stub<ComponentProps<typeof CanvasSouthBar>['runFocus']>(focus())} />);
        expect(screen.getByTestId('canvas-run-banner')).toBeTruthy();
        expect(screen.queryByTestId('canvas-run-elapsed')).toBeNull();
    });

    it('counts the elapsed time from startedAt', () => {
        const started = new Date(Date.now() - (12 * 60 + 33) * 1000).toISOString();
        render(<CanvasSouthBar runFocus={stub<ComponentProps<typeof CanvasSouthBar>['runFocus']>(focus({ startedAt: started }))} />);
        expect(screen.getByTestId('canvas-run-elapsed').textContent).toContain('12m 33s');
    });

    it('keeps the clock on a FAILED run — it says when it stopped, and stops ticking', () => {
        const started = new Date(Date.now() - 9000).toISOString();
        render(<CanvasSouthBar runFocus={stub<ComponentProps<typeof CanvasSouthBar>['runFocus']>(focus({ state: 'error', startedAt: started }))} />);
        expect(screen.getByTestId('canvas-run-elapsed').textContent).toContain('9s');
        expect(screen.getByTestId('canvas-run-banner').textContent).toContain('Step failed');
    });

    it('names the run it belongs to and says the step, not the run, failed', () => {
        const started = '2026-10-15T10:03:00.000Z';
        const runIdentity = { kind: 'test', id: 'run_1', startedAt: started };
        render(<CanvasSouthBar runFocus={stub<ComponentProps<typeof CanvasSouthBar>['runFocus']>(focus({ state: 'error', startedAt: started, done: 2, total: 5 }))} runIdentity={stub<ComponentProps<typeof CanvasSouthBar>['runIdentity']>(runIdentity)} />);
        expect(screen.getByTestId('canvas-run-banner').textContent).toContain('2 of 5 steps completed');
        expect(screen.getByTestId('canvas-run-identity').textContent).toContain('Test run');
        expect(screen.getByTestId('canvas-run-identity').textContent).toContain('2026');
    });

    it('does not call a hydrated non-test run a "Test run"', () => {
        const runIdentity = { kind: 'run', id: 'run_2', startedAt: '2026-10-15T10:03:00.000Z' };
        render(<CanvasSouthBar runFocus={stub<ComponentProps<typeof CanvasSouthBar>['runFocus']>(focus({ state: 'error' }))} runIdentity={stub<ComponentProps<typeof CanvasSouthBar>['runIdentity']>(runIdentity)} />);
        const text = screen.getByTestId('canvas-run-identity').textContent;
        expect(text).not.toContain('Test run');
        expect(text).toContain('Run');
    });

    it('uses the singular for one step', () => {
        render(<CanvasSouthBar runFocus={stub<ComponentProps<typeof CanvasSouthBar>['runFocus']>(focus({ state: 'error', done: 0, total: 1 }))} />);
        expect(screen.getByTestId('canvas-run-steps-done').textContent).toContain('0 of 1 step completed');
    });

    it('shows no run identity when the host names the run elsewhere', () => {
        render(<CanvasSouthBar runFocus={stub<ComponentProps<typeof CanvasSouthBar>['runFocus']>(focus({ state: 'error' }))} />);
        expect(screen.queryByTestId('canvas-run-identity')).toBeNull();
    });

    it('opens the run from "View run"', async () => {
        const onOpen = vi.fn();
        render(<CanvasSouthBar runFocus={stub<ComponentProps<typeof CanvasSouthBar>['runFocus']>(focus({ state: 'error' }))} runIdentity={{ kind: 'test', id: 'run_1', startedAt: null, onOpen }} />);
        await userEvent.click(screen.getByTestId('canvas-run-view'));
        expect(onOpen).toHaveBeenCalledWith('run_1');
    });

    it('has a dismiss button on a failure, none on a live run', async () => {
        const onDismissRun = vi.fn();
        const { rerender } = render(<CanvasSouthBar runFocus={stub<ComponentProps<typeof CanvasSouthBar>['runFocus']>(focus({ state: 'error' }))} onDismissRun={onDismissRun} />);
        await userEvent.click(screen.getByRole('button', { name: 'Dismiss the failed-run notice' }));
        expect(onDismissRun).toHaveBeenCalledTimes(1);
        rerender(<CanvasSouthBar runFocus={stub<ComponentProps<typeof CanvasSouthBar>['runFocus']>(focus())} onDismissRun={onDismissRun} />);
        expect(screen.queryByTestId('canvas-run-dismiss')).toBeNull();
    });

    it('offers "Open the form" as a button that opens the overlay, even without a public page', async () => {
        const onOpenFormOverlay = vi.fn();
        render(<CanvasSouthBar runFocus={stub<ComponentProps<typeof CanvasSouthBar>['runFocus']>(focus({ awaitingForm: true }))} formUrl={null} onOpenFormOverlay={onOpenFormOverlay} />);
        const btn = screen.getByTestId('canvas-run-open-form');
        expect(btn.tagName).toBe('BUTTON');
        await userEvent.click(btn);
        expect(onOpenFormOverlay).toHaveBeenCalledTimes(1);
        expect(screen.queryByTestId('canvas-run-open-form-tab')).toBeNull();
        expect(screen.getByTestId('canvas-run-banner').textContent).toContain('waiting for the form');
    });

    it('keeps the public page as a small secondary link that opens in a new tab', () => {
        render(<CanvasSouthBar runFocus={stub<ComponentProps<typeof CanvasSouthBar>['runFocus']>(focus({ awaitingForm: true }))} formUrl="https://example.test/f/abc" onOpenFormOverlay={() => {}} />);
        const link = screen.getByTestId('canvas-run-open-form-tab');
        expect(link.tagName).toBe('A');
        expect(link.getAttribute('href')).toBe('https://example.test/f/abc');
        expect(link.getAttribute('aria-label')).toBe('Open in a new tab');
        // One that cannot leak the opener to the form page.
        expect(link.getAttribute('rel')).toContain('noopener');
    });

    it('draws NO form control when there is neither an overlay to open nor a page', () => {
        // Never a dead control.
        render(<CanvasSouthBar runFocus={stub<ComponentProps<typeof CanvasSouthBar>['runFocus']>(focus({ awaitingForm: true }))} formUrl={null} />);
        expect(screen.queryByTestId('canvas-run-open-form')).toBeNull();
        expect(screen.queryByTestId('canvas-run-open-form-tab')).toBeNull();
    });

    it('draws no link on an ordinary running step even with a form url around', () => {
        render(<CanvasSouthBar runFocus={stub<ComponentProps<typeof CanvasSouthBar>['runFocus']>(focus({ awaitingForm: false }))} formUrl="https://example.test/f/abc" onOpenFormOverlay={() => {}} />);
        expect(screen.queryByTestId('canvas-run-open-form')).toBeNull();
        expect(screen.queryByTestId('canvas-run-open-form-tab')).toBeNull();
    });

    it('renders nothing of the banner when there is no run at all', () => {
        render(<CanvasSouthBar runFocus={null} />);
        expect(screen.queryByTestId('canvas-run-banner')).toBeNull();
    });
});
