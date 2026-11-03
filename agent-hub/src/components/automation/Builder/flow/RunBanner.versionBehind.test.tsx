import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CanvasSouthBar from './CanvasSouthBar';
import type { RunFocus } from './runFocus';
import type { RunPause } from './runPause';
import type { RunIdentity } from './useFailedRunBanner';

/**
 * A waiting test of a version the working copy has moved past (tests-and-docs
 * F9): what continues is the version it started on, not what the canvas shows.
 * The banner says so and offers both ways on: keep going on the old version,
 * or restart on the current one with this run's answers (a dry run seeded by
 * answersFromRunId).
 */
const parked: RunFocus = {
    stepId: 'fp', label: 'Delivery', done: 1, total: 3, state: 'running',
    startedAt: null, awaitingForm: true, awaitingApproval: false, pausedAt: null,
};
const identity = (p: Partial<RunPause> = {}, id = 'run_1'): RunIdentity => ({
    kind: 'test', id, startedAt: null,
    pause: { isTest: true, isDry: true, canDecide: null, waitingOn: null, versionBehind: true, ...p },
});

describe('the version-behind notice', () => {
    beforeEach(cleanup);

    it('says the test started on an older version, and restarts on the current one', async () => {
        const onRestart = vi.fn();
        render(<CanvasSouthBar runFocus={parked} runIdentity={identity({ onRestart })} />);
        expect(screen.getByTestId('canvas-run-version-behind').textContent).toContain('This test started on an older version');
        await userEvent.click(screen.getByTestId('canvas-run-restart'));
        expect(onRestart).toHaveBeenCalledTimes(1);
    });

    it('"Continue on the old version" puts the notice away for that run only', async () => {
        const { rerender } = render(<CanvasSouthBar runFocus={parked} runIdentity={identity({ onRestart: vi.fn() })} />);
        await userEvent.click(screen.getByTestId('canvas-run-keep-version'));
        expect(screen.queryByTestId('canvas-run-version-behind')).toBeNull();
        // The banner itself stays: the run still waits.
        expect(screen.getByTestId('canvas-run-banner')).toBeTruthy();
        rerender(<CanvasSouthBar runFocus={parked} runIdentity={identity({ onRestart: vi.fn() }, 'run_2')} />);
        expect(screen.getByTestId('canvas-run-version-behind')).toBeTruthy();
    });

    it('is absent for a current test, a production run, and a run that is not waiting', () => {
        const { rerender } = render(<CanvasSouthBar runFocus={parked} runIdentity={identity({ versionBehind: false })} />);
        expect(screen.queryByTestId('canvas-run-version-behind')).toBeNull();
        rerender(<CanvasSouthBar runFocus={parked} runIdentity={identity({ isTest: false })} />);
        expect(screen.queryByTestId('canvas-run-version-behind')).toBeNull();
        rerender(<CanvasSouthBar runFocus={{ ...parked, awaitingForm: false }} runIdentity={identity()} />);
        expect(screen.queryByTestId('canvas-run-version-behind')).toBeNull();
    });

    it('offers no restart where the host cannot start one', () => {
        render(<CanvasSouthBar runFocus={parked} runIdentity={identity()} />);
        expect(screen.getByTestId('canvas-run-keep-version')).toBeTruthy();
        expect(screen.queryByTestId('canvas-run-restart')).toBeNull();
    });
});
