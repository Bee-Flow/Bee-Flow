import { describe, it, expect } from 'vitest';
import { hasTopicRules, hostFromPreview, planTopicPreview, MAX_PREVIEW_TEXTS } from './topicPreview';
import { matchCounts } from './routeIntents';

/**
 * Counting "is about" rules against sample rows: what is sent, which rows the
 * answer covers, and that the SAME counting path then counts them.
 */
const RULES = [
    { name: 'complaints', expr: 'isAbout(item.body, "a complaint")' },
    { name: 'invoices', expr: 'isAbout(item.body, "an invoice") || endsWith(item.name, ".pdf")' },
];
const ROWS = [
    { body: ' Broken parcel! ', name: 'a.txt' },
    { body: 'Invoice 12 attached', name: 'b.pdf' },
    { body: 'Broken parcel!', name: 'c.txt' },
    { name: 'd.txt' },
];

describe('planTopicPreview', () => {
    it('sends each distinct text once, against the full topic list', () => {
        const plan = planTopicPreview(RULES, ROWS);
        expect(plan).toEqual({
            labels: ['a complaint', 'an invoice'],
            texts: ['Broken parcel!', 'Invoice 12 attached'],
            rows: ROWS,
        });
    });

    it('nothing to ask without an isAbout rule or without rows', () => {
        expect(planTopicPreview([{ name: 'x', expr: 'item.a == 1' }], ROWS)).toBeNull();
        expect(planTopicPreview(RULES, null)).toBeNull();
        expect(hasTopicRules(RULES)).toBe(true);
        expect(hasTopicRules([{ expr: 'contains(item.a, "x")' }])).toBe(false);
    });

    it('stops at the endpoint ceiling and says which rows the answer covers', () => {
        const many = Array.from({ length: MAX_PREVIEW_TEXTS + 5 }, (_, i) => ({ body: `text ${i}` }));
        const plan = planTopicPreview(RULES, many)!;
        expect(plan.texts.length).toBe(MAX_PREVIEW_TEXTS);
        expect(plan.rows.length).toBe(MAX_PREVIEW_TEXTS);
    });
});

describe('hostFromPreview + matchCounts', () => {
    it('counts isAbout rules from the classifier answer, with the other rules as before', () => {
        const host = hostFromPreview({
            texts: ['Broken parcel!', 'Invoice 12 attached'],
            scores: [{ 'a complaint': 0.9, 'an invoice': 0.1 }, { 'a complaint': 0.05, 'an invoice': 0.95 }],
            defaultThreshold: 0.5,
        });
        const counts = matchCounts(RULES, ROWS, { host }) as NonNullable<ReturnType<typeof matchCounts>>;
        expect(counts.perRule.map((r: { matched: number }) => r.matched)).toEqual([2, 1]);
        expect(counts.perRule.map((r: { failed: number }) => r.failed)).toEqual([0, 0]);
        expect(counts.unmatched).toBe(1);
    });

    it('a malformed answer is no host', () => {
        expect(hostFromPreview({ texts: ['a'], scores: [] })).toBeNull();
        expect(hostFromPreview(null)).toBeNull();
    });
});
