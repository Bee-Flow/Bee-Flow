import type { TranslateFn } from '@/core/i18n';

import { deriveRangeParams, isRangePreset, usageQuery, windowQuery, USAGE_ALL_DAYS } from './range';
import {
    feedbackNeedsReview,
    filterFeedback,
    isBreakdownReport,
    periodLabel,
    positiveRate,
    reportTitle,
    shareOf,
    sourceLabel,
    terminationTypeLabel,
    terminationsPerPeriod,
    BREAKDOWN_REPORTS,
} from './report';
import type { FeedbackItem } from './types';

const t: TranslateFn = (_key, fallback, params) =>
    fallback.replace(/\{(\w+)\}/g, (_m, name: string) => String(params?.[name] ?? ''));

const NOW = new Date('2026-09-24T15:30:00Z');

describe('range', () => {
    it('derives each preset like the web', () => {
        expect(deriveRangeParams('7d', NOW)).toEqual({
            days: 7,
            startDate: '2026-09-17T15:30:00.000Z',
            endDate: '2026-09-24T15:30:00.000Z',
            interval: 'day',
        });
        expect(deriveRangeParams('24h', NOW)).toMatchObject({ days: 1, interval: 'hour', startDate: '2026-09-23T15:30:00.000Z' });
        expect(deriveRangeParams('today', NOW)).toMatchObject({ days: 1, interval: 'hour' });
        expect(deriveRangeParams('30d', NOW).days).toBe(30);
        expect(deriveRangeParams('90d', NOW).days).toBe(90);
        expect(deriveRangeParams('all', NOW)).toEqual({ days: null, startDate: null, endDate: null, interval: 'day' });
    });

    it('builds each family its own query', () => {
        const week = deriveRangeParams('7d', NOW);
        expect(usageQuery(week)).toEqual({ days: 7, startDate: week.startDate, endDate: week.endDate });
        expect(windowQuery(week)).toEqual({ startDate: week.startDate, endDate: week.endDate });
        const all = deriveRangeParams('all', NOW);
        expect(usageQuery(all)).toEqual({ days: USAGE_ALL_DAYS });
        expect(windowQuery(all)).toEqual({});
    });

    it('recognises presets', () => {
        expect(isRangePreset('30d')).toBe(true);
        expect(isRangePreset('custom')).toBe(false);
        expect(isRangePreset(undefined)).toBe(false);
    });
});

describe('report helpers', () => {
    it('knows the reports and their titles', () => {
        expect(BREAKDOWN_REPORTS.every(isBreakdownReport)).toBe(true);
        expect(isBreakdownReport('safety')).toBe(false);
        for (const r of BREAKDOWN_REPORTS) expect(reportTitle(r, t)).toBeTruthy();
    });

    it('labels sources, termination types and periods', () => {
        expect(sourceLabel('direct', t)).toBe('Direct Chat');
        expect(sourceLabel('chat', t)).toBe('Agent Chat');
        expect(sourceLabel('mystery', t)).toBe('mystery');
        for (const s of ['notebook', 'research', 'template', 'designer', 'agent_stream', 'other']) {
            expect(sourceLabel(s, t)).not.toBe(s);
        }
        expect(terminationTypeLabel('error', t)).toBe('Errors');
        expect(terminationTypeLabel('max_tokens', t)).toBe('Max tokens');
        expect(terminationTypeLabel('max_iterations', t)).toBe('Max iterations');
        expect(terminationTypeLabel('aborted', t)).toBe('Aborted');
        expect(terminationTypeLabel('new', t)).toBe('new');
        expect(periodLabel('2026-09-24 14:00')).toBe('14:00');
        expect(periodLabel('2026-09-24')).not.toBe('');
    });

    it('scales each row against the largest', () => {
        const rows = [{ cost: 4 }, { cost: 2 }];
        expect(shareOf(2, rows)).toBe(0.5);
        expect(shareOf(1, [])).toBe(0);
    });

    it('filters feedback and judges the positive rate', () => {
        const item = (rating: 'up' | 'down', comment: string | null): FeedbackItem => ({
            id: `${rating}${comment}`, rating, comment, userId: null, agentName: null, model: null, source: null, createdAt: '', hasConversation: false,
        });
        const items = [item('up', null), item('down', 'bad'), item('down', null)];
        expect(filterFeedback(items, 'positive')).toHaveLength(1);
        expect(filterFeedback(items, 'negative')).toHaveLength(2);
        expect(filterFeedback(items, 'comments')).toHaveLength(1);
        expect(filterFeedback(items, 'all')).toHaveLength(3);
        expect(positiveRate({ total: 0, up: 0, down: 0, withComments: 0 })).toBeNull();
        expect(feedbackNeedsReview({ total: 10, up: 5, down: 5, withComments: 0 })).toBe(true);
        expect(feedbackNeedsReview({ total: 4, up: 0, down: 4, withComments: 0 })).toBe(false);
        expect(feedbackNeedsReview({ total: 10, up: 8, down: 2, withComments: 0 })).toBe(false);
    });

    it('stacks terminations per period, oldest first', () => {
        expect(terminationsPerPeriod([
            { period: '2026-09-02', type: 'error', count: 2 },
            { period: '2026-09-01', type: 'error', count: 1 },
            { period: '2026-09-02', type: 'aborted', count: 3 },
        ])).toEqual([{ period: '2026-09-01', count: 1 }, { period: '2026-09-02', count: 5 }]);
    });
});
