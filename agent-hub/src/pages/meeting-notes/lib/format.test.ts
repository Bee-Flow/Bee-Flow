import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatRelativeDate } from './format';

/**
 * formatRelativeDate takes `now - d` in seconds. Pinned so the Date arithmetic
 * can be written with getTime(): both operands are Date objects there, valueOf
 * and getTime are the same number, and an invalid input never reaches the
 * subtraction (it returns '' first).
 */

const NOW = new Date('2026-09-14T09:12:00Z');

describe('formatRelativeDate', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
    });
    afterEach(() => vi.useRealTimers());

    const ago = (s: number) => new Date(NOW.getTime() - s * 1000);

    it('is empty for nothing and for an unreadable date', () => {
        expect(formatRelativeDate(undefined)).toBe('');
        expect(formatRelativeDate(null)).toBe('');
        expect(formatRelativeDate('')).toBe('');
        expect(formatRelativeDate('not a date')).toBe('');
        expect(formatRelativeDate(NaN)).toBe('');
    });

    it('walks the ladder', () => {
        expect(formatRelativeDate(ago(0))).toBe('just now');
        expect(formatRelativeDate(ago(44))).toBe('just now');
        expect(formatRelativeDate(ago(45))).toBe('0m ago');
        expect(formatRelativeDate(ago(60))).toBe('1m ago');
        expect(formatRelativeDate(ago(3599))).toBe('59m ago');
        expect(formatRelativeDate(ago(3600))).toBe('1h ago');
        expect(formatRelativeDate(ago(86399))).toBe('23h ago');
        expect(formatRelativeDate(ago(86400))).toBe('1d ago');
        expect(formatRelativeDate(ago(604799))).toBe('6d ago');
    });

    it('a future date is "just now"', () => {
        expect(formatRelativeDate(new Date(NOW.getTime() + 86400 * 1000))).toBe('just now');
    });

    it('accepts a Date, an ISO string and an epoch number', () => {
        const then = ago(7200);
        expect(formatRelativeDate(then)).toBe('2h ago');
        expect(formatRelativeDate(then.toISOString())).toBe('2h ago');
        expect(formatRelativeDate(then.getTime())).toBe('2h ago');
    });

    it('older than a week: the short date, with the year only when it is not this year', () => {
        const sameYear = new Date('2026-03-02T10:00:00Z');
        const otherYear = new Date('2025-03-02T10:00:00Z');
        expect(formatRelativeDate(sameYear)).toBe(sameYear.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
        expect(formatRelativeDate(otherYear)).toBe(otherYear.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }));
    });
});
