/**
 * The clock formatter, pinned.
 *
 * This exists because of what the de-duplication pass did NOT do. There are two
 * `formatDuration`s in this app — this one and the one in
 * features/automate/format.ts — and they were left separate on the argument
 * that they take different units and render different shapes on purpose. An
 * argument like that is only worth making if both shapes are written down, so
 * both files now have a test that says what theirs does. If someone later
 * decides the two really should merge, these two files are the specification
 * of what a merged one would have to satisfy — and the reason it cannot.
 */

import { formatDuration, formatElapsed } from './format';

describe('formatDuration (seconds → clock)', () => {
    it('reads as minutes and seconds under an hour', () => {
        expect(formatDuration(484)).toBe('8:04');
        expect(formatDuration(90)).toBe('1:30');
        expect(formatDuration(59)).toBe('0:59');
        expect(formatDuration(3599)).toBe('59:59');
    });

    it('grows an hours field rather than counting past 60 minutes', () => {
        // The whole reason this is not `${minutes}:${seconds}`: a 65-minute
        // meeting that reads "65:30" looks like a different recording from the
        // one the detail screen calls "1:05:30".
        expect(formatDuration(3600)).toBe('1:00:00');
        expect(formatDuration(3930)).toBe('1:05:30');
    });

    it('floors fractional seconds instead of rounding into the next tick', () => {
        expect(formatDuration(59.9)).toBe('0:59');
    });

    it('reads absent, zero and nonsense as a zeroed clock, not a dash', () => {
        // Deliberately NOT the automate copy's em dash. A recording with no
        // length is a real recording that went wrong, and 0:00 says that; a run
        // with no duration simply has not started, which is what a dash says.
        expect(formatDuration(0)).toBe('0:00');
        expect(formatDuration(null)).toBe('0:00');
        expect(formatDuration(undefined)).toBe('0:00');
        expect(formatDuration(-5)).toBe('0:00');
        expect(formatDuration(Number.NaN)).toBe('0:00');
    });
});

describe('formatElapsed (the live timer)', () => {
    it('zero-pads the minutes so the digits do not shift width', () => {
        // formatDuration says "8:04" and this says "08:04" for the same input,
        // and that is the point: this one is on screen for an hour at a time
        // while the number climbs, and a timer whose left edge jumps at ten
        // minutes looks broken.
        expect(formatElapsed(484)).toBe('08:04');
        expect(formatElapsed(0)).toBe('00:00');
        expect(formatElapsed(600)).toBe('10:00');
    });

    it('adds the hours field once there is one', () => {
        expect(formatElapsed(3930)).toBe('1:05:30');
    });

    it('never counts below zero', () => {
        expect(formatElapsed(-3)).toBe('00:00');
    });
});
