/** The /api/studio readers keep "not yours" (absent) apart from "none" (0 / []). */

import { readDescribeIt, readStudioAttention, readStudioCounts, readStudioSearch } from './readers';

describe('readStudioCounts', () => {
    it('keeps only the numeric keys, and leaves a gated key absent', () => {
        expect(readStudioCounts({ counts: { apps: 3, runs: '2', agents: 'x' }, makers: 4 })).toEqual({
            counts: { apps: 3, runs: 2 },
            makers: 4,
        });
        expect(readStudioCounts(null)).toEqual({ counts: {}, makers: null });
    });
});

describe('readStudioAttention', () => {
    it('reads rows and never assumes a complete answer', () => {
        const read = readStudioAttention({
            rows: [{ source: 'agentNoKb', code: 'x', severity: 'warning', kind: 'agent', targetId: 'a1', message: 'M', deepLink: '/app/studio/agents/a1' }],
            total: 3,
            unavailable: ['kbEmptyInUse'],
        });
        expect(read.rows[0]).toMatchObject({ severity: 'warning', remediation: null, deepLink: '/app/studio/agents/a1' });
        expect(read).toMatchObject({ total: 3, unavailable: ['kbEmptyInUse'], capped: [], gated: [], complete: false });
    });

    it('reads an unknown severity as info', () => {
        expect(readStudioAttention({ rows: [{ severity: 'fatal' }] }).rows[0]?.severity).toBe('info');
    });
});

describe('readStudioSearch', () => {
    it('keeps a searched-but-empty kind as [] and drops a kind that was not searched', () => {
        const read = readStudioSearch({
            query: 'inv',
            tooShort: false,
            results: { apps: [{ id: 'a', name: 'Invoices' }, { name: 'no id' }], skills: [], broken: 'x' },
            errors: ['datatables'],
        });
        expect(read.results).toEqual({ apps: [{ id: 'a', name: 'Invoices' }], skills: [] });
        expect(read.errors).toEqual(['datatables']);
    });
});

describe('readDescribeIt', () => {
    it('reads a decided answer, trimmed', () => {
        expect(
            readDescribeIt({
                kind: ' kb ',
                name: ' Quotes ',
                seed: 'Collect the quotes. ',
                companions: [{ kind: 'agent', name: 'Quote bot', why: 'answers questions' }],
                available: ['kb', 'agent'],
                undecided: [],
            }),
        ).toEqual({
            kind: 'kb',
            name: 'Quotes',
            seed: 'Collect the quotes.',
            companions: [{ kind: 'agent', name: 'Quote bot' }],
            available: ['kb', 'agent'],
            undecided: [],
        });
    });

    it('never guesses a kind it does not know', () => {
        const read = readDescribeIt({ kind: 'spreadsheet', name: 'X', seed: 'Y', available: ['automation'] });
        expect(read?.kind).toBeNull();
        expect(readDescribeIt({ kind: 42 })?.kind).toBeNull();
    });

    it('drops broken companions instead of repairing them, and never repeats the main kind', () => {
        const read = readDescribeIt({
            kind: 'automation',
            companions: [
                { kind: 'automation', name: 'again' },
                { kind: 'nope', name: 'unknown' },
                null,
                'datatable',
                { kind: 'datatable', name: 'twice' },
                { name: 'no kind' },
            ],
        });
        expect(read?.companions).toEqual([{ kind: 'datatable', name: '' }]);
    });

    it('keeps "no list" (unknown) apart from "an empty list" (none), and filters the lists to known kinds', () => {
        expect(readDescribeIt({ kind: null })).toMatchObject({ available: null, undecided: [] });
        expect(readDescribeIt({ kind: null, available: [], undecided: ['app', 'app', 'x'] })).toMatchObject({
            available: [],
            undecided: ['app'],
        });
    });

    it('reads the server\'s "nothing to route to" answer as a kind-less answer', () => {
        expect(readDescribeIt({ kind: null, name: null, seed: null, companions: [], available: [], undecided: [] })).toEqual({
            kind: null,
            name: '',
            seed: '',
            companions: [],
            available: [],
            undecided: [],
        });
    });

    it('answers null for a body that is not an answer at all, never "no kind"', () => {
        expect(readDescribeIt(null)).toBeNull();
        expect(readDescribeIt('ok')).toBeNull();
        expect(readDescribeIt([])).toBeNull();
    });
});
