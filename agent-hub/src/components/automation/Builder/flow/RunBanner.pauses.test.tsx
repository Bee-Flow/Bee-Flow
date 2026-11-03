import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CanvasSouthBar from './CanvasSouthBar';
import type { RunFocus } from './runFocus';
import type { RunPause } from './runPause';
import type { RunIdentity } from './useFailedRunBanner';

/**
 * The banner of a run that waits (builder-ui RUN-05, RUN-06, RUN-07, pauses
 * F4): it says whose wait it is, offers what un-parks it, lets a test be
 * stopped, stops its clock, and gives the south edge back to the selection and
 * build bars, because a waiting run executes nothing.
 */
const focus = (over: Partial<RunFocus> = {}): RunFocus => ({
    stepId: 'ap', label: 'Sign-off', done: 1, total: 3, state: 'running',
    startedAt: null, awaitingForm: false, awaitingApproval: false, pausedAt: null, ...over,
});
const pause = (over: Partial<RunPause> = {}): RunPause => ({
    isTest: true, isDry: false, canDecide: true, waitingOn: null, versionBehind: false, ...over,
});
const identity = (p: Partial<RunPause> = {}, over: Partial<RunIdentity> = {}): RunIdentity => ({
    kind: p.isTest === false ? 'run' : 'test', id: 'run_1', startedAt: null, pause: pause(p), ...over,
});
const title = () => screen.getByTestId('canvas-run-title').textContent;

describe('the banner of a run waiting for a decision', () => {
    beforeEach(cleanup);

    it('a test: "Waiting for your decision (test)", and Review & decide opens the step', async () => {
        const onReview = vi.fn();
        render(<CanvasSouthBar runFocus={focus({ awaitingApproval: true })} runIdentity={identity({ onReview })} />);
        expect(title()).toBe('Waiting for your decision (test)');
        await userEvent.click(screen.getByTestId('canvas-run-review'));
        expect(onReview).toHaveBeenCalledWith('ap');
    });

    it('somebody else\'s decision: who it waits on, and no Review & decide', () => {
        render(<CanvasSouthBar runFocus={focus({ awaitingApproval: true })} runIdentity={identity({ isTest: false, canDecide: false, waitingOn: { stageName: 'Finance', seatCount: 2 }, onReview: vi.fn() })} />);
        expect(title()).toBe('Waiting for Finance (2)');
        expect(screen.queryByTestId('canvas-run-review')).toBeNull();
        // A production run is not something to stop from the canvas.
        expect(screen.queryByTestId('canvas-run-stop')).toBeNull();
    });

    it('a host that knows nothing about the run makes no claim about whose decision it is', () => {
        render(<CanvasSouthBar runFocus={focus({ awaitingApproval: true })} />);
        expect(title()).toBe('Waiting for a decision');
    });
});

describe('stopping a waiting test', () => {
    beforeEach(cleanup);

    it('"Stop this test" on a live test waiting on a form calls the cancel', async () => {
        const onStop = vi.fn();
        render(<CanvasSouthBar runFocus={focus({ awaitingForm: true, label: 'Delivery' })} runIdentity={identity({ onStop })} onOpenFormOverlay={vi.fn()} />);
        expect(title()).toBe('Waiting for the form');
        const stop = screen.getByTestId('canvas-run-stop');
        expect(stop.textContent).toContain('Stop this test');
        await userEvent.click(stop);
        expect(onStop).toHaveBeenCalledTimes(1);
    });

    it('a dry run is discarded: nothing real happened in it', () => {
        render(<CanvasSouthBar runFocus={focus({ awaitingApproval: true })} runIdentity={identity({ isDry: true, onStop: vi.fn() })} />);
        expect(screen.getByTestId('canvas-run-stop').textContent).toContain('Discard');
    });

    it('a running test has no stop here (the progress banner has its own)', () => {
        render(<CanvasSouthBar runFocus={focus()} runIdentity={identity({ onStop: vi.fn() })} />);
        expect(screen.queryByTestId('canvas-run-stop')).toBeNull();
    });
});

describe('a form wait: a test of mine, or a visitor\'s journey', () => {
    beforeEach(cleanup);

    it('my test offers the page over the canvas', () => {
        render(<CanvasSouthBar runFocus={focus({ awaitingForm: true, label: 'Delivery' })} runIdentity={identity()} onOpenFormOverlay={vi.fn()} />);
        expect(screen.getByTestId('canvas-run-open-form')).toBeTruthy();
        expect(screen.queryByTestId('canvas-run-view')).toBeNull();
    });

    it('a production run says a visitor is on the page, and offers the run, never the page', async () => {
        const onOpen = vi.fn();
        render(<CanvasSouthBar runFocus={focus({ awaitingForm: true, label: 'Delivery' })} runIdentity={identity({ isTest: false, onStop: vi.fn() }, { onOpen })} />);
        expect(title()).toBe('A visitor is on “Delivery”');
        expect(screen.queryByTestId('canvas-run-open-form')).toBeNull();
        expect(screen.queryByTestId('canvas-run-stop')).toBeNull();
        await userEvent.click(screen.getByTestId('canvas-run-view'));
        expect(onOpen).toHaveBeenCalledWith('run_1');
    });
});

describe('the clock of a waiting run', () => {
    afterEach(() => { vi.useRealTimers(); cleanup(); });

    it('stands still at the moment the run paused', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-11-03T12:00:00.000Z'));
        const parked = focus({ awaitingForm: true, startedAt: '2026-11-03T10:00:00.000Z', pausedAt: '2026-11-03T10:00:42.000Z' });
        render(<CanvasSouthBar runFocus={parked} runIdentity={identity()} />);
        expect(screen.getByTestId('canvas-run-elapsed').textContent).toContain('42s');
        act(() => { vi.advanceTimersByTime(5000); });
        expect(screen.getByTestId('canvas-run-elapsed').textContent).toContain('42s');
        expect(screen.getByTestId('canvas-run-banner').querySelector('.animate-ping')).toBeNull();
    });

    it('a running run still counts up', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-11-03T10:00:10.000Z'));
        render(<CanvasSouthBar runFocus={focus({ startedAt: '2026-11-03T10:00:00.000Z' })} />);
        expect(screen.getByTestId('canvas-run-elapsed').textContent).toContain('10s');
        act(() => { vi.advanceTimersByTime(3000); });
        expect(screen.getByTestId('canvas-run-elapsed').textContent).toContain('13s');
    });
});

describe('the south edge: the author\'s work wins over a waiting run', () => {
    beforeEach(cleanup);

    it('the selection bar shows, with the waiting run as a chip beside it', async () => {
        const onShowRun = vi.fn();
        render(<CanvasSouthBar editable selectedCount={2} onDeleteSelection={vi.fn()} runFocus={focus({ awaitingForm: true })} runIdentity={identity()} onShowRun={onShowRun} />);
        expect(screen.getByTestId('canvas-selection-bar')).toBeTruthy();
        expect(screen.queryByTestId('canvas-run-banner')).toBeNull();
        const chip = screen.getByTestId('canvas-run-chip');
        expect(chip.textContent).toContain('Waiting for the form');
        await userEvent.click(chip);
        expect(onShowRun).toHaveBeenCalledTimes(1);
    });

    it('the build banner shows, with the chip', () => {
        render(<CanvasSouthBar buildCue={{ running: true }} runFocus={focus({ awaitingApproval: true })} runIdentity={identity()} />);
        expect(screen.getByTestId('canvas-build-banner')).toBeTruthy();
        expect(screen.getByTestId('canvas-run-chip').textContent).toContain('Waiting for your decision (test)');
    });

    it('a run that executes still holds the edge over a selection', () => {
        render(<CanvasSouthBar editable selectedCount={2} runFocus={focus()} />);
        expect(screen.getByTestId('canvas-run-banner')).toBeTruthy();
        expect(screen.queryByTestId('canvas-selection-bar')).toBeNull();
    });

    it('with the selection in the drawer, the waiting run takes the edge back', () => {
        render(<CanvasSouthBar editable selectedCount={1} selectionInDrawer runFocus={focus({ awaitingForm: true })} runIdentity={identity()} />);
        expect(screen.getByTestId('canvas-run-banner')).toBeTruthy();
    });
});
