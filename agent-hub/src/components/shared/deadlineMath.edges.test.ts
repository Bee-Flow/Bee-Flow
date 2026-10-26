import { describe, expect, it } from 'vitest';
import { DAY_MS, addCalendarMonths, clockState } from './deadlineMath';

/**
 * `urgentBelowMs` makes a clock urgent only when it is a finite number above
 * zero. Pinned for every kind of input so the guard can be spelled with a
 * `typeof` check (Number.isFinite is already false for every non-number).
 */

const NOW = Date.parse('2026-09-14T09:12:00Z');
const base = { dueAt: NOW + DAY_MS, startedAt: NOW - 2 * DAY_MS, now: NOW };
const stateFor = (urgentBelowMs: unknown) => clockState({ ...base, urgentBelowMs: urgentBelowMs as number }).state;

describe('clockState — urgentBelowMs', () => {
    it('is not urgent without a usable threshold', () => {
        for (const bad of [undefined, null, NaN, Infinity, -Infinity, 0, -1, -DAY_MS, '86400000', '', true, false, {}, []]) {
            expect(stateFor(bad), String(bad)).toBe('ok');
        }
    });

    it('is urgent when the remaining time is within a positive finite threshold', () => {
        expect(stateFor(DAY_MS)).toBe('urgent');
        expect(stateFor(2 * DAY_MS)).toBe('urgent');
        expect(stateFor(DAY_MS - 1)).toBe('ok');
        expect(stateFor(0.5)).toBe('ok');
    });

    it('overdue wins over any threshold', () => {
        expect(clockState({ ...base, now: NOW + 2 * DAY_MS, urgentBelowMs: 5 * DAY_MS }).state).toBe('overdue');
        expect(clockState({ ...base, now: NOW + 2 * DAY_MS, urgentBelowMs: Infinity }).state).toBe('overdue');
    });

    it('is not called without arguments', () => {
        expect(clockState().state).toBe('none');
    });
});

describe('addCalendarMonths — months', () => {
    const jan31 = Date.UTC(2026, 0, 31, 10, 0, 0);

    it('adds whole months, clamping to the last day of a short month', () => {
        expect(addCalendarMonths(jan31, 1)).toBe(Date.UTC(2026, 1, 28, 10, 0, 0));
        expect(addCalendarMonths(jan31, 0)).toBe(jan31);
        expect(addCalendarMonths(jan31, -1)).toBe(Date.UTC(2025, 11, 31, 10, 0, 0));
    });

    it('is null unless months is an integer number', () => {
        for (const bad of [undefined, null, NaN, Infinity, 1.5, '1', '', true, {}, []]) {
            expect(addCalendarMonths(jan31, bad as number), String(bad)).toBeNull();
        }
    });

    it('is null for an unreadable date', () => {
        for (const bad of [undefined, null, '', 'nope', NaN]) {
            expect(addCalendarMonths(bad, 1), String(bad)).toBeNull();
        }
    });
});
