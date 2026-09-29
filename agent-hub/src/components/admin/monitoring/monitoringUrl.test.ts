import { describe, expect, it } from 'vitest';
import { monitoringUrl } from './monitoringUrl';

describe('monitoringUrl', () => {
    it('starts the query with "?" even when the range adds no filters (the "all time" case)', () => {
        expect(monitoringUrl('/api/usage/timeline', { interval: 'day' })).toBe('/api/usage/timeline?interval=day');
    });

    it('joins range filters and the interval into one query string', () => {
        expect(monitoringUrl('/api/usage/timeline', { startDate: '2026-09-01', endDate: '2026-09-24', interval: 'hour' }))
            .toBe('/api/usage/timeline?startDate=2026-09-01&endDate=2026-09-24&interval=hour');
    });

    it('leaves out empty values and returns the bare path when nothing is left', () => {
        expect(monitoringUrl('/api/usage/summary', { startDate: '', endDate: undefined, org: null })).toBe('/api/usage/summary');
    });
});
