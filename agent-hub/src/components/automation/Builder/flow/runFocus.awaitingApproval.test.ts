// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { computeRunFocus } from './runFocus';
import { isParked } from './runPause';

/**
 * A run waiting for a decision gets a banner, like one waiting on a form
 * (builder-ui RUN-05, pauses F4): before, computeRunFocus looked only for
 * running, awaiting_form and error rows, so a run parked on an approval had no
 * banner and the only cue was a small badge on a card that may be off-screen.
 */
const DEF = { trigger: { id: 't1' }, steps: [{ id: 'ap', label: 'Sign-off' }, { id: 'mail', label: 'Send mail' }] };

describe('computeRunFocus — a run waiting for a decision', () => {
    it('names the approval step and says it waits, with nothing executing', () => {
        const focus = computeRunFocus({
            definition: DEF,
            runSteps: [
                { stepId: 't1', status: 'success', startedAt: '2026-11-03T10:00:00.000Z' },
                { stepId: 'ap', status: 'awaiting_approval', startedAt: '2026-11-03T10:00:04.000Z' },
            ],
        });
        expect(focus!.stepId).toBe('ap');
        expect(focus!.label).toBe('Sign-off');
        expect(focus!.awaitingApproval).toBe(true);
        expect(focus!.awaitingForm).toBe(false);
        // A pause is not a failure.
        expect(focus!.state).toBe('running');
        expect(isParked(focus)).toBe(true);
    });

    it('stops the clock where the run paused', () => {
        const focus = computeRunFocus({
            definition: DEF,
            runSteps: [
                { stepId: 't1', status: 'success', startedAt: '2026-11-03T10:00:00.000Z' },
                { stepId: 'ap', status: 'awaiting_approval', startedAt: '2026-11-03T10:00:04.000Z' },
            ],
        });
        expect(focus!.startedAt).toBe('2026-11-03T10:00:00.000Z');
        expect(focus!.pausedAt).toBe('2026-11-03T10:00:04.000Z');
    });

    it('lets a running step win: that is where the run is', () => {
        const focus = computeRunFocus({
            definition: DEF,
            runSteps: [{ stepId: 'ap', status: 'awaiting_approval' }, { stepId: 'mail', status: 'running' }],
        });
        expect(focus!.stepId).toBe('mail');
        expect(focus!.awaitingApproval).toBe(false);
        expect(focus!.pausedAt).toBeNull();
        expect(isParked(focus)).toBe(false);
    });

    it('does not claim a wait the run has moved past: a decision was just given and the run executes again', () => {
        const focus = computeRunFocus({
            definition: DEF,
            runInFlight: true,
            runSteps: [{ stepId: 't1', status: 'success' }, { stepId: 'ap', status: 'awaiting_approval' }],
        });
        expect(focus!.awaitingApproval).toBe(false);
        expect(focus!.awaitingForm).toBe(false);
        expect(focus!.stepId).toBeNull();
        expect(isParked(focus)).toBe(false);
    });

    it('ignores the wait of a step that is no longer on the canvas', () => {
        expect(computeRunFocus({ definition: DEF, runSteps: [{ stepId: 'gone', status: 'awaiting_approval' }] })).toBeNull();
    });

    it('a failure is never parked', () => {
        const focus = computeRunFocus({ definition: DEF, runSteps: [{ stepId: 'mail', status: 'error' }] });
        expect(focus!.state).toBe('error');
        expect(isParked(focus)).toBe(false);
    });
});
