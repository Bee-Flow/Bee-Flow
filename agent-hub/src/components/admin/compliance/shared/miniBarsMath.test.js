// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { bucketHistory, formatDelta, valueOf, DAY_MS, LEGACY_COLUMN } from './miniBarsMath';

// A fixed clock: 14 Sep 2026 12:00 local.
const NOW = new Date(2026, 8, 14, 12, 0, 0).getTime();
const daysAgo = (d, hour = 9) => new Date(NOW - d * DAY_MS + (hour - 12) * 3_600_000).toISOString();
const row = (d, overall, extra = {}) => ({ captured_at: daysAgo(d), overall_score: overall, ...extra });

describe('miniBarsMath.bucketHistory — twelve equal windows over the last 90 days', () => {
    it('an empty, absent or malformed history yields all-zero bars and no delta — never a throw', () => {
        for (const history of [undefined, null, [], 'nope', 42, [null, {}, { captured_at: 'not a date', overall_score: 50 }, { captured_at: daysAgo(3), overall_score: 'x' }]]) {
            const r = bucketHistory(history, { now: NOW });
            expect(r.values).toEqual(new Array(12).fill(0));
            expect(r.filled).toEqual(new Array(12).fill('empty'));
            expect(r.first).toBeNull();
            expect(r.last).toBeNull();
            expect(r.delta).toBeNull();
        }
    });

    it('the LAST row of a window wins, and a busy afternoon stays one bar', () => {
        // Three sweeps on the same day (the newest is 79); a 7.5-day bucket.
        const history = [
            row(2, 70, { captured_at: daysAgo(2, 8) }),
            row(2, 79, { captured_at: daysAgo(2, 17) }),
            row(2, 74, { captured_at: daysAgo(2, 12) }),
        ];
        const r = bucketHistory(history, { now: NOW });
        expect(r.values[11]).toBe(79);
        expect(r.filled[11]).toBe('measured');
        expect(r.filled.filter(f => f === 'measured')).toHaveLength(1);
    });

    it('carries a value forward through quiet windows instead of dropping to zero', () => {
        // A sweep 40 days ago, then silence: buckets 6..11 all read 62.
        const r = bucketHistory([row(40, 62)], { now: NOW });
        const firstIdx = r.filled.indexOf('measured');
        expect(firstIdx).toBe(6); // 90 d / 12 = 7.5 d per bucket; 40 d ago → (90−40)/7.5 = 6.67 → bucket 6
        for (let i = 0; i < firstIdx; i++) { expect(r.filled[i]).toBe('empty'); expect(r.values[i]).toBe(0); }
        for (let i = firstIdx + 1; i < 12; i++) { expect(r.filled[i]).toBe('carried'); expect(r.values[i]).toBe(62); }
        expect(r.delta).toBe(0); // first and last non-empty bucket both 62
    });

    it('the newest row BEFORE the window seeds the carry, so a quiet first fortnight is not a hole', () => {
        const r = bucketHistory([row(200, 40), row(100, 55), row(10, 70)], { now: NOW });
        expect(r.filled[0]).toBe('carried');
        expect(r.values[0]).toBe(55); // the 100-day-old row, not the 200-day-old one
        expect(r.filled[10]).toBe('measured'); // 10 d ago → (90−10)/7.5 = 10.67 → bucket 10
        expect(r.values[11]).toBe(70);
        expect(r.filled[11]).toBe('carried');
        expect(r.first).toBe(55);
        expect(r.last).toBe(70);
        expect(r.delta).toBe(15);
    });

    it('signed delta between the first and the last non-empty bucket, over a rising and a falling series', () => {
        const rising = bucketHistory([row(85, 70), row(50, 74), row(1, 79)], { now: NOW });
        expect(rising.delta).toBe(9);
        const falling = bucketHistory([row(85, 66), row(30, 58)], { now: NOW });
        expect(falling.delta).toBe(-8);
    });

    it('respects days/bars and clamps rows stamped after `now` into the last bucket', () => {
        const r = bucketHistory([row(-1, 91), row(25, 50)], { now: NOW, days: 30, bars: 6 });
        expect(r.values).toHaveLength(6);
        expect(r.days).toBe(30);
        expect(r.values[5]).toBe(91);
        expect(r.filled[5]).toBe('measured');
        expect(r.values[0]).toBe(50); // 25 d ago at 09:00 — 5 d 3 h after the window start, 5-day buckets → bucket 0
    });

    it('scores are clamped to 0..100 and rounded', () => {
        const r = bucketHistory([row(1, 104.6), row(20, -3)], { now: NOW });
        expect(r.values[11]).toBe(100);
        expect(r.values[9]).toBe(0);
        expect(r.filled[9]).toBe('measured');
    });
});

describe('miniBarsMath.valueOf — which number a row holds for a framework', () => {
    const r = {
        captured_at: daysAgo(1), overall_score: 75, gdpr_score: 79, aia_score: 58, iso_score: 88,
        scores: { gdpr: 80, nis2: 66 },
    };

    it('reads scores[frameworkId] first, the legacy column second, overall when no framework is asked', () => {
        expect(valueOf(r, 'gdpr')).toBe(80);      // JSONB wins over the legacy column
        expect(valueOf(r, 'aia')).toBe(58);       // not in scores → aia_score
        expect(valueOf(r, 'iso27001')).toBe(88);  // → iso_score
        expect(valueOf(r, 'nis2')).toBe(66);
        expect(valueOf(r)).toBe(75);
        expect(valueOf(r, '')).toBe(75);
        expect(LEGACY_COLUMN).toEqual({ gdpr: 'gdpr_score', aia: 'aia_score', iso27001: 'iso_score' });
    });

    it('a legacy framework whose column is empty has NO value (overall is not a stand-in); a newer framework falls back to overall', () => {
        const old = { captured_at: daysAgo(1), overall_score: 75, gdpr_score: null };
        expect(valueOf(old, 'gdpr')).toBeNull();
        expect(valueOf(old, 'cra')).toBe(75);
        expect(valueOf(null, 'gdpr')).toBeNull();
        expect(valueOf({ overall_score: 'abc' })).toBeNull();
        expect(valueOf({ overall_score: '61' })).toBe(61);
    });

    it('per-framework bucketing uses that framework’s series', () => {
        const history = [
            { captured_at: daysAgo(60), overall_score: 70, scores: { gdpr: 70, aia: 66 } },
            { captured_at: daysAgo(1), overall_score: 79, scores: { gdpr: 79, aia: 58 } },
        ];
        expect(bucketHistory(history, { now: NOW, frameworkId: 'gdpr' }).delta).toBe(9);
        expect(bucketHistory(history, { now: NOW, frameworkId: 'aia' }).delta).toBe(-8);
        // A framework absent from every row → all empty, no delta.
        const none = bucketHistory([{ captured_at: daysAgo(1), gdpr_score: 5 }], { now: NOW, frameworkId: 'iso27001' });
        expect(none.delta).toBeNull();
        expect(none.filled.every(f => f === 'empty')).toBe(true);
    });
});

describe('miniBarsMath.formatDelta', () => {
    it('prints a signed delta with a real minus sign, ±0 for no change, null for no trend', () => {
        expect(formatDelta(9)).toBe('+9');
        expect(formatDelta(-8)).toBe('−8');
        expect(formatDelta(0)).toBe('±0');
        expect(formatDelta(2.6)).toBe('+3');
        expect(formatDelta(null)).toBeNull();
        expect(formatDelta(undefined)).toBeNull();
        expect(formatDelta(NaN)).toBeNull();
    });
});
