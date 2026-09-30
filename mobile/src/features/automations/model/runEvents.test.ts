/**
 * A run's end is what refreshes the routines list; its start and its steps
 * are not, so a busy loop never re-reads the list.
 */

import { isSettledRunEvent } from './runEvents';

describe('isSettledRunEvent', () => {
    it('is true for a run that finished or failed', () => {
        expect(isSettledRunEvent({ type: 'run.finished' })).toBe(true);
        expect(isSettledRunEvent({ type: 'run.failed' })).toBe(true);
    });

    it('is false for a start, a step and anything unknown', () => {
        for (const type of ['run.started', 'step.started', 'step.finished', 'step.heartbeat', 'run.other']) {
            expect(isSettledRunEvent({ type })).toBe(false);
        }
    });
});
