// @vitest-environment node
/**
 * The freshness cell is the only place the overview says whether a knowledge
 * base is actually working, so its ORDER of rules is the thing worth pinning:
 * a broken KB must not be able to read as a healthy one because it also has a
 * schedule.
 */
import { describe, it, expect } from 'vitest';
import { TONE, cronParams, freshnessOf, refreshModeKey, strongestRefresh, toMillis } from './freshness';

const NOW = Date.parse('2026-09-04T12:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

describe('toMillis', () => {
    it('takes a Date, a number or an ISO string', () => {
        expect(toMillis(new Date(NOW))).toBe(NOW);
        expect(toMillis(NOW)).toBe(NOW);
        expect(toMillis('2026-09-04T12:00:00Z')).toBe(NOW);
        expect(toMillis(undefined)).toBeNull();
    });
});

describe('strongestRefresh', () => {
    it('folds several schedules into the most frequent one', () => {
        const best = strongestRefresh([
            { refreshMode: 'schedule' }, { refreshMode: 'live' }, { refreshMode: 'manual' },
        ]);
        expect(best.mode).toBe('live');
    });

    it('ignores manual sources entirely', () => {
        expect(strongestRefresh([{ refreshMode: 'manual' }, { refreshMode: 'manual' }])).toBeNull();
        expect(strongestRefresh([])).toBeNull();
        expect(strongestRefresh(null)).toBeNull();
    });

    it('accepts the snake_case the server row still uses', () => {
        expect(strongestRefresh([{ refresh_mode: 'on_change' }]).mode).toBe('on_change');
    });
});

describe('freshnessOf', () => {
    it('says when content last arrived, handing the caller the timestamp', () => {
        const v = freshnessOf({ documentCount: 12, lastContentAt: ago(2 * 60_000), sourceCount: 3 });
        expect(v.tone).toBe(TONE.OK);
        expect(v.key).toBe('knowledge.freshness.updated');
        // `at` is the raw stamp; the words come from useRelativeTime.
        expect(v.at).toBe(NOW - 2 * 60_000);
    });

    it('raises the alarm for an empty knowledge base something depends on', () => {
        const v = freshnessOf({ documentCount: 0, sourceCount: 1 }, { usageCount: 1 });
        expect(v.tone).toBe(TONE.PROBLEM);
        expect(v.key).toBe('knowledge.freshness.empty_in_use');
    });

    it('lets the problem beat the promise', () => {
        // A weekly schedule that has never delivered is broken TODAY. Saying
        // "weekly" here is a true sentence that hides the only useful one.
        const v = freshnessOf(
            { documentCount: 0, sourceCount: 1 },
            { sources: [{ refreshMode: 'schedule', refreshCron: '0 6 * * 1' }], usageCount: 2 },
        );
        expect(v.tone).toBe(TONE.PROBLEM);
    });

    it('stays quiet when the KB is empty but nothing uses it', () => {
        // usageCount 0 is also what "not loaded yet" looks like, so an unknown
        // usage must never raise the alarm on its own.
        const v = freshnessOf({ documentCount: 0, sourceCount: 0 }, { usageCount: 0 });
        expect(v.tone).toBe(TONE.IDLE);
        expect(v.key).toBe('knowledge.freshness.no_sources');
    });

    it('promises the schedule when nothing has arrived yet', () => {
        const v = freshnessOf(
            { documentCount: 0, sourceCount: 1 },
            { sources: [{ refreshMode: 'schedule', refreshCron: '0 6 * * 1' }] },
        );
        expect(v.tone).toBe(TONE.IDLE);
        expect(v.key).toBe('knowledge.refresh.schedule');
        expect(v.params).toEqual({ every: 'week', day: 1 });
    });

    it('uses the list payload counter when it has no source rows', () => {
        // The overview lists KBs without fetching each one's sources.
        const v = freshnessOf({ documentCount: 0, sourceCount: 2, autoRefreshCount: 1 });
        expect(v.key).toBe('knowledge.freshness.auto');
    });

    it('accepts the snake_case list row unchanged', () => {
        const v = freshnessOf({ document_count: 4, last_content_at: ago(2 * 60_000) });
        expect(v.key).toBe('knowledge.freshness.updated');
    });
});

describe('cronParams', () => {
    it('names the shapes the schedule chooser can produce', () => {
        expect(cronParams({ refreshCron: '0 6 * * 1' })).toEqual({ every: 'week', day: 1 });
        expect(cronParams({ refreshCron: '0 6 15 * *' })).toEqual({ every: 'month', day: 15 });
        expect(cronParams({ refreshCron: '0 6 * * *' })).toEqual({ every: 'day' });
    });

    it('falls back to no parameters rather than guess at a hand-written cron', () => {
        // A wrong sentence about when data refreshes is worse than a vague one.
        expect(cronParams({ refreshCron: '*/7 3 * * 1-5' })).toEqual({});
        expect(cronParams({ refreshCron: '0 0 6 * * 1' })).toEqual({}); // 6-field
        expect(cronParams({})).toEqual({});
        expect(cronParams(null)).toEqual({});
    });
});

describe('refreshModeKey', () => {
    it('maps every mode, and anything unknown to manual', () => {
        expect(refreshModeKey('live')).toBe('knowledge.refresh.live');
        expect(refreshModeKey('on_change')).toBe('knowledge.refresh.on_change');
        expect(refreshModeKey('after_meeting')).toBe('knowledge.refresh.after_meeting');
        expect(refreshModeKey('schedule')).toBe('knowledge.refresh.schedule');
        expect(refreshModeKey('manual')).toBe('knowledge.refresh.manual');
        expect(refreshModeKey('something_new')).toBe('knowledge.refresh.manual');
    });
});
