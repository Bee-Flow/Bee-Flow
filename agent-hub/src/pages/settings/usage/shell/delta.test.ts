import { describe, expect, it } from 'vitest';
import { formatDelta } from './delta';

describe('formatDelta', () => {
    it('formats a percentage with an arrow', () => {
        expect(formatDelta(-51.2, 'pct')).toEqual({ direction: 'down', text: '↓ 51%' });
        expect(formatDelta(12, 'pct')).toEqual({ direction: 'up', text: '↑ 12%' });
    });
    it('formats points and absolute changes', () => {
        expect(formatDelta(50, 'pts')?.text).toBe('↑ 50 pts');
        expect(formatDelta(-3, 'abs')?.text).toBe('↓ 3');
    });
    it('says same when the change rounds to zero', () => {
        expect(formatDelta(0, 'pct')).toEqual({ direction: 'same', text: 'same' });
        expect(formatDelta(0.4, 'pts')?.direction).toBe('same');
    });
    it('has no text without a previous figure', () => {
        expect(formatDelta(null, 'pct')).toBeNull();
        expect(formatDelta(Number.NaN, 'pct')).toBeNull();
    });
    it('uses the given labels', () => {
        expect(formatDelta(0, 'pct', { same: 'gelijk', pts: 'pnt' })?.text).toBe('gelijk');
    });
});
