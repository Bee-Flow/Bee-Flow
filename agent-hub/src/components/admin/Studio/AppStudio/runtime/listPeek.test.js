import { describe, it, expect } from 'vitest';
import { buildPeekIndex, peekBadgeLabel, peekKey, peekSections } from './listPeek';

/**
 * The peek's whole value is that the number in the badge is TRUE — a sidebar
 * that says "14 to check" and means eleven is worse than one that says nothing.
 * So the counting rules (aggregate weights, unmatched rows, the cap) are what
 * these tests pin down.
 */

const LINES = [
    { thread: 't1', check: 'onvolledig', name: 'A', note: 'no material' },
    { thread: 't1', check: 'onvolledig', name: 'B', note: 'no thickness' },
    { thread: 't1', check: 'controleren', name: 'C', note: 'marked' },
    { thread: 't2', check: 'controleren', name: 'D', note: '' },
    { thread: '', check: 'onvolledig', name: 'orphan', note: '' },
];

describe('buildPeekIndex', () => {
    it('joins on the match key and counts one per row', () => {
        const index = buildPeekIndex(LINES, { matchKey: 'thread' });
        expect(index.get('t1').count).toBe(3);
        expect(index.get('t2').count).toBe(1);
    });

    it('drops related rows whose join value is empty', () => {
        // They match no list row, so a bucket for them could only make a total
        // somewhere else look wrong.
        const index = buildPeekIndex(LINES, { matchKey: 'thread' });
        expect(index.has('')).toBe(false);
        expect([...index.keys()]).toEqual(['t1', 't2']);
    });

    it('sums countKey instead of counting rows — the aggregate case', () => {
        const agg = [
            { thread: 't1', check: 'onvolledig', n: 87 },
            { thread: 't1', check: 'controleren', n: 4 },
        ];
        const index = buildPeekIndex(agg, { matchKey: 'thread', countKey: 'n', groupKey: 'check' });
        expect(index.get('t1').count).toBe(91);
        expect(index.get('t1').groups.map((g) => [g.value, g.count])).toEqual([
            ['onvolledig', 87], ['controleren', 4],
        ]);
    });

    it('orders groups biggest first and maps their labels', () => {
        const index = buildPeekIndex(LINES, {
            matchKey: 'thread',
            groupKey: 'check',
            groupLabelMap: [{ value: 'onvolledig', label: 'Incomplete' }],
        });
        const groups = index.get('t1').groups;
        expect(groups[0]).toMatchObject({ value: 'onvolledig', label: 'Incomplete', count: 2 });
        // A value with no entry in the map keeps its raw value as its label.
        expect(groups[1]).toMatchObject({ value: 'controleren', label: 'controleren', count: 1 });
    });

    it('is empty without a match key or rows', () => {
        expect(buildPeekIndex(LINES, {}).size).toBe(0);
        expect(buildPeekIndex(null, { matchKey: 'thread' }).size).toBe(0);
        expect(buildPeekIndex('nope', { matchKey: 'thread' }).size).toBe(0);
    });

    it('meets a numeric id with its text form', () => {
        const index = buildPeekIndex([{ ref: 7 }], { matchKey: 'ref' });
        expect(index.get(peekKey('7'))).toBeTruthy();
    });
});

describe('peekBadgeLabel', () => {
    it('puts the count in front of the biggest group', () => {
        const index = buildPeekIndex(LINES, { matchKey: 'thread', groupKey: 'check' });
        expect(peekBadgeLabel(index.get('t1'), 'Check')).toBe('3 onvolledig');
    });

    it('falls back to the row badge label without a group key', () => {
        const index = buildPeekIndex(LINES, { matchKey: 'thread' });
        expect(peekBadgeLabel(index.get('t2'), 'Check')).toBe('1 Check');
    });

    it('leaves a row with nothing behind it alone', () => {
        // "0 to check" on every finished row is noise on exactly the rows that
        // are fine.
        expect(peekBadgeLabel(undefined, 'Done')).toBe('Done');
        expect(peekBadgeLabel({ count: 0, rows: [], groups: [] }, 'Done')).toBe('Done');
    });
});

describe('peekSections', () => {
    it('caps the rows across groups and reports what did not fit', () => {
        const index = buildPeekIndex(LINES, { matchKey: 'thread', groupKey: 'check' });
        const { sections, more } = peekSections(index.get('t1'), 2);
        expect(sections).toHaveLength(1);
        expect(sections[0].rows.map((r) => r.name)).toEqual(['A', 'B']);
        // The group header still carries its TRUE count, so a cut panel never
        // understates the work.
        expect(sections[0].count).toBe(2);
        expect(more).toBe(1);
    });

    it('renders one anonymous section without a group key', () => {
        const index = buildPeekIndex(LINES, { matchKey: 'thread' });
        const { sections, more } = peekSections(index.get('t1'), 10);
        expect(sections).toHaveLength(1);
        expect(sections[0].label).toBe(null);
        expect(more).toBe(0);
    });

    it('answers empty for a row with nothing behind it', () => {
        expect(peekSections(undefined, 6)).toEqual({ sections: [], more: 0 });
    });
});
