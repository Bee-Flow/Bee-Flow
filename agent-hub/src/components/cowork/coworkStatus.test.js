import { describe, it, expect } from 'vitest';
import { coworkStatus, isInFlight, runStatusToken } from './coworkStatus';
import { STATUS_TOKENS } from '../shared/statusTokens';

/**
 * The Cowork row's state, and the colour it comes out as.
 *
 * This module always knew the difference between "running right now" and
 * "deliberately switched off" — the two branches are three lines apart. What
 * it did not have was anywhere to put it: `running` and `paused` carried the
 * identical amber, so the answer was thrown away the moment it was rendered
 * (CW-04). These tests pin both halves: the branch, and the fact that the two
 * branches now end in different colours.
 */

const item = (over = {}) => ({
    id: 'w1',
    isActive: true,
    lastStatus: 'success',
    lastRunAt: new Date().toISOString(),
    runCount: 3,
    ...over,
});

describe('coworkStatus', () => {
    it('reads a running item as running', () => {
        expect(coworkStatus(item({ lastStatus: 'running' }))).toBe(STATUS_TOKENS.running);
    });

    it('counts an inactive, never-run item as in flight while the token still reads idle', () => {
        // "Run now" deactivates server-side BEFORE the run fires, so this is
        // the shape of an item seconds after the button was pressed.
        // isInFlight() already knows something is happening; coworkStatus()
        // does not yet, and this test pins BOTH halves as they are today —
        // the idle token here is the gap the module doc describes, not the
        // desired end state. Change the behaviour and this test changes with
        // it on purpose; do not "fix" one half to match the other name.
        const justStarted = item({ isActive: false, lastRunAt: null, runCount: 0, lastStatus: 'pending' });
        expect(isInFlight(justStarted)).toBe(true);
        expect(coworkStatus(justStarted)).toBe(STATUS_TOKENS.idle);
    });

    it('reads an active, never-run item as queued', () => {
        expect(coworkStatus(item({ lastRunAt: null, runCount: 0, lastStatus: null }))).toBe(STATUS_TOKENS.queued);
    });

    it('keeps a finished one-off finished rather than calling it paused', () => {
        expect(coworkStatus(item({ isActive: false, lastStatus: 'success' }))).toBe(STATUS_TOKENS.success);
    });

    it('reads a switched-off item as paused, and a failed one as failed', () => {
        expect(coworkStatus(item({ isActive: false, lastStatus: 'idle' }))).toBe(STATUS_TOKENS.paused);
        expect(coworkStatus(item({ isActive: false, lastStatus: 'error' }))).toBe(STATUS_TOKENS.error);
    });

    it('does not call a schedule that needs signing in again "paused"', () => {
        // routineAuth switches a schedule off with last_status 'needs_reauth'.
        // Read as "paused" it is indistinguishable from "I switched that off
        // myself", so the one row that should say the unattended work has
        // stopped says nothing at all. The server counts these runs as
        // failures in /stats; the colour agrees with it.
        const stalled = coworkStatus(item({ isActive: false, lastStatus: 'needs_reauth', runCount: 12 }));
        expect(stalled.labelKey).not.toBe('run_status.paused');
        expect(stalled.labelKey).not.toBe('run_status.idle');
        expect(stalled.labelEn).toBe('Needs sign-in');
        expect(stalled.cssVar).toBe(STATUS_TOKENS.error.cssVar);
    });

    it('says so even before it has ever run', () => {
        const never = coworkStatus(item({ isActive: false, lastStatus: 'needs_reauth', lastRunAt: null, runCount: 0 }));
        expect(never.labelEn).toBe('Needs sign-in');
    });

    it('paints running and paused in different colours', () => {
        // The point of CW-04. Before the split these two assertions passed
        // trivially with `toBe`, because both branches returned the same
        // object — the row could not be read at a glance.
        const running = coworkStatus(item({ lastStatus: 'running' }));
        const paused = coworkStatus(item({ isActive: false, lastStatus: 'idle' }));
        expect(running.solid).not.toBe(paused.solid);
        expect(running.badge).not.toBe(paused.badge);
        expect(running.labelKey).toBe('run_status.running');
        expect(paused.labelKey).toBe('run_status.paused');
    });
});

describe('runStatusToken', () => {
    it('is tokenFor for every ordinary status', () => {
        expect(runStatusToken('success')).toBe(STATUS_TOKENS.success);
        expect(runStatusToken('error')).toBe(STATUS_TOKENS.error);
        expect(runStatusToken('running')).toBe(STATUS_TOKENS.running);
        expect(runStatusToken('who-knows')).toBe(STATUS_TOKENS.idle);
    });

    it('gives needs_reauth its own word in the error tone', () => {
        const token = runStatusToken('needs_reauth');
        expect(token).not.toBe(STATUS_TOKENS.idle);
        expect(token.labelEn).toBe('Needs sign-in');
        expect(token.labelKey).toBe('cowork.status.needs_reauth');
        expect(token.cssVar).toBe(STATUS_TOKENS.error.cssVar);
    });
});

describe('isInFlight', () => {
    it('is true while running and while waiting for the first run', () => {
        expect(isInFlight(item({ lastStatus: 'running' }))).toBe(true);
        expect(isInFlight(item({ lastRunAt: null, runCount: 0 }))).toBe(true);
        expect(isInFlight(item())).toBe(false);
    });
});
