// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest';

import { formatRelative } from './relativeTime';

/**
 * CHARACTERISATION — the compact timestamp on the project activity feed (PRJ-0).
 *
 * Small, but it is the clock two project surfaces read from, and PRJ-4 wants to
 * change how activity is dated. Pinning the current buckets makes that change
 * visible instead of incidental.
 */

const at = (iso) => vi.setSystemTime(new Date(iso));
afterEach(() => vi.useRealTimers());

function withNow(nowIso, fn) {
    vi.useFakeTimers();
    at(nowIso);
    try { return fn(); } finally { vi.useRealTimers(); }
}

describe('the buckets', () => {
    it('says nothing at all for a missing timestamp', () => {
        expect(formatRelative(null)).toBe('');
        expect(formatRelative(undefined)).toBe('');
        expect(formatRelative('')).toBe('');
    });

    it('calls the last minute "just now"', () => {
        withNow('2026-09-06T12:00:00Z', () => {
            expect(formatRelative('2026-09-06T11:59:31Z')).toBe('just now');
        });
    });

    it('counts minutes up to the hour', () => {
        withNow('2026-09-06T12:00:00Z', () => {
            expect(formatRelative('2026-09-06T11:55:00Z')).toBe('5m ago');
        });
    });

    it('counts hours up to the day', () => {
        withNow('2026-09-06T12:00:00Z', () => {
            expect(formatRelative('2026-09-06T09:00:00Z')).toBe('3h ago');
        });
    });

    it('counts days up to the week', () => {
        withNow('2026-09-06T12:00:00Z', () => {
            expect(formatRelative('2026-09-03T12:00:00Z')).toBe('3d ago');
        });
    });

    it('falls back to a plain date beyond a week', () => {
        withNow('2026-09-06T12:00:00Z', () => {
            const out = formatRelative('2026-07-01T12:00:00Z');
            expect(out).toBe(new Date('2026-07-01T12:00:00Z').toLocaleDateString());
        });
    });

    it('reads a clock-skewed future timestamp as "just now" rather than negative', () => {
        withNow('2026-09-06T12:00:00Z', () => {
            expect(formatRelative('2026-09-06T12:05:00Z')).toBe('just now');
        });
    });
});

// wrat: this helper ROUNDS while utils/dateFormatters.formatRelativeTime — the
// one the project CARDS use — FLOORS, so the same event is "1m ago" on the list
// and "2m ago" in the activity feed. Hoort in stage PRJ-4 te veranderen, waar
// de feed naar dateFormatters verhuist.
describe('the rounding this helper does and the card list does not', () => {
    it('rounds 90 seconds up to two minutes', () => {
        withNow('2026-09-06T12:00:00Z', () => {
            expect(formatRelative('2026-09-06T11:58:30Z')).toBe('2m ago');
        });
    });

    it('rounds the last twenty seconds before the hour up to a whole hour', () => {
        withNow('2026-09-06T12:00:00Z', () => {
            // 59m40s. The card list, which floors, would still say "59m ago".
            expect(formatRelative('2026-09-06T11:00:20Z')).toBe('1h ago');
        });
    });

    it('rounds twenty-three-and-a-half hours all the way up to a day', () => {
        withNow('2026-09-06T12:00:00Z', () => {
            // The card list, which floors, would still call this "23h ago".
            expect(formatRelative('2026-09-05T12:30:00Z')).toBe('1d ago');
        });
    });
});
