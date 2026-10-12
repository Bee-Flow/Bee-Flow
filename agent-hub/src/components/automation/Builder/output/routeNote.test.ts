import { describe, it, expect } from 'vitest';
import { listUnitKey, routeContextOf, routeNoteOf, routeOutputsOf, routeSentence, routeSummaryOf, routeUnit } from './routeNote';

const t = (_key: string, fallback?: unknown, vars?: Record<string, unknown>) =>
    String(fallback ?? '').replace(/\{(\w+)\}/g, (_, v) => String(vars?.[v] ?? ''));

// What the runner records (execCollections.js / execControl.js).
const FILTER_OUT = { items: [{ id: 1 }, { id: 2 }, { id: 3 }], count: 3, inputCount: 4, rejectedCount: 1 };
const SPLIT_OUT = {
    mode: 'collection', branch: 'case:pdf', branches: ['case:pdf', 'case:word', 'case:powerpoint', 'case:default'],
    matchesByCase: { pdf: [1, 2, 3, 4], word: [5, 6], powerpoint: [7], default: [8, 9, 10, 11] },
    counts: { pdf: 4, word: 2, powerpoint: 1, default: 4 }, total: 11, matched: 'pdf,word,powerpoint,default',
};

describe('routeNoteOf', () => {
    it('a filter output: kept of total, from the counts', () => {
        expect(routeNoteOf(FILTER_OUT)).toEqual({ kind: 'kept', kept: 3, total: 4 });
        expect(routeNoteOf({ items: [], count: 0, inputCount: 4, rejectedCount: 4 })).toEqual({ kind: 'kept', kept: 0, total: 4 });
    });

    it('a list switch: outputs in case order, then Otherwise', () => {
        const note = routeNoteOf(SPLIT_OUT, { caseOrder: ['word', 'pdf', 'powerpoint'] });
        expect(note).toEqual({
            kind: 'split', total: 11, fanOut: false,
            parts: [
                { name: 'word', count: 2, otherwise: false },
                { name: 'pdf', count: 4, otherwise: false },
                { name: 'powerpoint', count: 1, otherwise: false },
                { name: 'default', count: 4, otherwise: true },
            ],
        });
    });

    it('a case that matched nothing still shows; counts fall back to matchesByCase', () => {
        const { counts: _c, ...noCounts } = SPLIT_OUT;
        const note = routeNoteOf({ ...noCounts, matchesByCase: { pdf: [1] } }, { caseOrder: ['pdf', 'csv'], fanOut: true });
        expect(note).toEqual({
            kind: 'split', total: 11, fanOut: true,
            parts: [{ name: 'pdf', count: 1, otherwise: false }, { name: 'csv', count: 0, otherwise: false }],
        });
    });

    it('null for anything else', () => {
        expect(routeNoteOf(null)).toBeNull();
        expect(routeNoteOf([1, 2])).toBeNull();
        expect(routeNoteOf({ items: [1], count: 1 })).toBeNull();
        expect(routeNoteOf({ branch: 'case:a', value: 'x' })).toBeNull();
        expect(routeNoteOf({ mode: 'collection', counts: { a: 1 } })).toBeNull();
    });
});

describe('the unit (P3)', () => {
    it('is the last key of the list, humanised and lower case', () => {
        expect(listUnitKey('steps.r.output.messages[*].attachments')).toBe('attachments');
        expect(routeUnit('steps.r.output.messages', t)).toBe('messages');
        expect(routeUnit('steps.r.output["Story Points"]', t)).toBe('story points');
        expect(routeUnit('trigger.output.rows', t)).toBe('rows');
    });

    it('"items" when the list has no name of its own', () => {
        expect(routeUnit('steps.r.output', t)).toBe('items');
        expect(routeUnit('', t)).toBe('items');
        expect(routeUnit(undefined, t)).toBe('items');
        expect(routeUnit('steps.r.output.[', t)).toBe('items');
    });
});

describe('routeContextOf', () => {
    it('a filter and a list switch get one; a whole-run Condition and other steps do not', () => {
        expect(routeContextOf({ type: 'filter', arrayRef: 'steps.r.output.messages', expr: 'true' }, t))
            .toEqual({ unit: 'messages', caseOrder: [], fanOut: false });
        expect(routeContextOf({
            type: 'switch', arrayRef: 'steps.r.output.messages[*].attachments', matchMode: 'all',
            cases: [{ name: 'pdf', expr: 'x' }, { name: 'word', expr: 'y' }],
        }, t)).toEqual({ unit: 'attachments', caseOrder: ['pdf', 'word'], fanOut: true });
        expect(routeContextOf({ type: 'switch', cases: [{ name: 'a' }] }, t)).toBeNull();
        expect(routeContextOf({ type: 'condition', expr: 'x' }, t)).toBeNull();
        expect(routeContextOf({ type: 'loop', arrayRef: 'steps.r.output.messages' }, t)).toBeNull();
        expect(routeContextOf(null, t)).toBeNull();
    });
});

describe('routeSentence (P1/P2)', () => {
    it('kept, kept none', () => {
        expect(routeSentence({ kind: 'kept', kept: 3, total: 4 }, 'messages', t)).toBe('Kept 3 of 4 messages');
        expect(routeSentence({ kind: 'kept', kept: 0, total: 4 }, 'messages', t)).toBe('Kept none of 4 messages');
    });

    it('split, with and without fan-out', () => {
        const note = routeNoteOf(SPLIT_OUT, { caseOrder: ['pdf', 'word', 'powerpoint'] })!;
        expect(routeSentence(note, 'attachments', t)).toBe('pdf 4 · word 2 · powerpoint 1 · Otherwise 4 (11 attachments in all)');
        expect(routeSentence({ ...note, fanOut: true } as typeof note, 'attachments', t))
            .toBe('pdf 4 · word 2 · powerpoint 1 · Otherwise 4 (11 attachments in all) · one item can go down several outputs');
    });
});

describe('routeSummaryOf / routeOutputsOf: a list switch is not "1 record" of internals', () => {
    const route = { unit: 'attachments', caseOrder: ['word', 'pdf', 'powerpoint'] };

    it('counts a list switch in its unit', () => {
        expect(routeSummaryOf(SPLIT_OUT, route, t)).toEqual({ count: 11, kind: 'records', label: '11 attachments' });
    });

    it('leaves a filter, another output and a step without a route to the generic summary', () => {
        expect(routeSummaryOf(FILTER_OUT, route, t)).toBeNull();
        expect(routeSummaryOf({ a: 1 }, route, t)).toBeNull();
        expect(routeSummaryOf(SPLIT_OUT, null, t)).toBeNull();
    });

    it('shows the outputs in case order with Otherwise last, and nothing of the filing', () => {
        const shown = routeOutputsOf(SPLIT_OUT, route);
        expect(Object.keys(shown ?? {})).toEqual(['word', 'pdf', 'powerpoint', 'default']);
        expect(shown?.pdf).toEqual([1, 2, 3, 4]);
    });

    it('is null when the recording holds no rows, or for any other output', () => {
        expect(routeOutputsOf({ ...SPLIT_OUT, matchesByCase: {} }, route)).toBeNull();
        expect(routeOutputsOf(FILTER_OUT, route)).toBeNull();
        expect(routeOutputsOf(SPLIT_OUT, null)).toBeNull();
    });
});
