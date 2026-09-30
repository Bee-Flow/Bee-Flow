import { describe, expect, it } from 'vitest';
import { ARM_TTL_MS, decideClaim, type CaptureArm, type CaptureState } from './useProjectMeetingCapture';

const NOW = 1_000_000_000;
const ARM: CaptureArm = { projectId: 'p1', version: 3, session: 7, at: NOW - 1000 };
const state = (over: Partial<CaptureState> = {}): CaptureState => ({ version: 4, lastResultId: 'm-new', session: 7, ...over });

describe('decideClaim', () => {
    it('ignores results when no capture was armed for this project', () => {
        expect(decideClaim(null, 'p1', state(), NOW)).toBe('ignore');
        expect(decideClaim(ARM, 'p2', state(), NOW)).toBe('ignore');
    });

    it('waits until a capture finishes after the arm', () => {
        expect(decideClaim(ARM, 'p1', state({ version: 3, lastResultId: 'm-old' }), NOW)).toBe('wait');
    });

    it('claims a result that finished after the arm', () => {
        expect(decideClaim(ARM, 'p1', state(), NOW)).toBe('claim');
    });

    it('disarms when someone else already took the result', () => {
        expect(decideClaim(ARM, 'p1', state({ lastResultId: null }), NOW)).toBe('disarm');
    });

    it('drops an arm older than the time limit instead of claiming', () => {
        const stale = { ...ARM, at: NOW - ARM_TTL_MS - 1 };
        expect(decideClaim(stale, 'p1', state(), NOW)).toBe('disarm');
    });

    it('never claims a later meeting when more than one capture finished since the arm', () => {
        // R1 (ours) finished unclaimed, then R2 (a private one) overwrote it.
        expect(decideClaim(ARM, 'p1', state({ version: 5, lastResultId: 'm-private' }), NOW)).toBe('disarm');
    });

    it('never claims a capture that was opened from somewhere else since the arm', () => {
        // The armed capture failed without a result; the next one came from the
        // meeting palette and is the first to finish.
        expect(decideClaim(ARM, 'p1', state({ session: 8, lastResultId: 'm-private' }), NOW)).toBe('disarm');
        expect(decideClaim(ARM, 'p1', state({ session: 8, version: 3 }), NOW)).toBe('disarm');
    });
});
