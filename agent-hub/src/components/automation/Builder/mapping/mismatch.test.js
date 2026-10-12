import { describe, it, expect } from 'vitest';
import { columnForSlot, detectMismatch, fieldForSlot, remediesFor, mismatchSentence, kindAtPath, NEWLINE } from './mismatch';

/**
 * "It doesn't fit, so ask" (artboard 2a). The remedies must emit only what the
 * server engine really runs, the default must be the design's first choice,
 * and the gate must stay quiet wherever a claim would be a guess.
 */
const ROOT = {
    steps: {
        a: { output: { warnings: ['Column Budget 2026 is empty', 'Row 12 unlabelled'], rows: [{ id: 1, name: 'x' }, { id: 2, name: 'y' }], balance: { assets: 1, liabilities: 1 } } },
    },
};

describe('detectMismatch — what counts as not fitting', () => {
    it('a list, a table and a group into one value each ask their own question', () => {
        expect(detectMismatch({ actualKind: 'list', expectedKind: 'text' })?.code).toBe('list_into_one');
        // A table is NOT folded into the list question any more: 2c's answer
        // for a table in a text slot is "as a table", which is not one of the
        // list remedies.
        expect(detectMismatch({ actualKind: 'table', expectedKind: 'number' })?.code).toBe('table_into_one');
        expect(detectMismatch({ actualKind: 'group', expectedKind: 'text' })?.code).toBe('group_into_one');
        // A dropdown takes one of its options, never an array of them.
        expect(detectMismatch({ actualKind: 'list', expectedKind: 'choice' })?.code).toBe('list_into_one');
    });

    it('never warns where the server would happily stringify, or where nothing is known', () => {
        expect(detectMismatch({ actualKind: 'number', expectedKind: 'text' })).toBeNull();
        expect(detectMismatch({ actualKind: 'yesno', expectedKind: 'text' })).toBeNull();
        expect(detectMismatch({ actualKind: 'unknown', expectedKind: 'text' })).toBeNull();
        expect(detectMismatch({ actualKind: 'list', expectedKind: 'unknown' })).toBeNull();
        expect(detectMismatch({ actualKind: 'list', expectedKind: 'list' })).toBeNull();
        expect(detectMismatch({ actualKind: 'text', expectedKind: 'number' })).toBeNull();
    });
});

describe('remediesFor — the four choices, in the design order, plus more', () => {
    it('offers join-with-newlines first, then first, then count, then one-per-item', () => {
        const r = remediesFor('steps.a.output.warnings', ROOT, { allowForEach: true });
        expect(r.defaultId).toBe('join');
        expect(r.primary.map(x => x.id)).toEqual(['join', 'first', 'count', 'foreach']);
        expect(r.primary[0].binding).toEqual({ kind: 'expr', value: `join(steps.a.output.warnings, "${NEWLINE === '\n' ? '\\n' : NEWLINE}")` });
        expect(r.primary[1].binding).toEqual({ kind: 'expr', value: 'first(steps.a.output.warnings)' });
        expect(r.primary[2].binding).toEqual({ kind: 'expr', value: 'count(steps.a.output.warnings)' });
        expect(r.primary[3].forEach).toMatchObject({ overRef: 'steps.a.output.warnings', maxIterations: 100 });
        expect(r.primary[3].binding.kind).toBe('ref');
    });

    it('the count is the real count, never a hard-coded 1', () => {
        const r = remediesFor('steps.a.output.warnings', ROOT);
        expect(r.count).toBe(2);
        expect(r.primary.find(x => x.id === 'count').labelParams).toEqual({ n: 2 });
        expect(r.primary.find(x => x.id === 'count').preview).toBe('2');
    });

    it('keeps "the whole list" and "the last one" behind more', () => {
        const r = remediesFor('steps.a.output.warnings', ROOT);
        expect(r.more.map(x => x.id)).toEqual(['join_comma', 'last', 'each']);
        expect(r.more.find(x => x.id === 'each').binding).toEqual({ kind: 'ref', path: 'steps.a.output.warnings' });
    });

    it('leaves out the per-item run when the host cannot offer it', () => {
        const r = remediesFor('steps.a.output.warnings', ROOT, { allowForEach: false });
        expect(r.primary.map(x => x.id)).toEqual(['join', 'first', 'count']);
    });

    it('previews with the sample data', () => {
        const r = remediesFor('steps.a.output.warnings', ROOT);
        expect(r.primary[0].preview).toContain('Column Budget 2026 is empty');
        expect(r.primary[1].preview).toContain('Column Budget 2026 is empty');
    });
});

describe('mismatchSentence — words, not types', () => {
    it('says list of N, needs one text', () => {
        expect(mismatchSentence({ actualKind: 'list', expectedKind: 'text', count: 3 }))
            .toBe('is a list of 3, this needs one text. What do you want?');
    });
    it('asks for a field inside a group', () => {
        expect(mismatchSentence({ actualKind: 'group', expectedKind: 'number' }))
            .toBe('is a group, this needs one number. Pick a field inside it.');
    });
    it('never prints "array" or "object"', () => {
        for (const k of ['list', 'table', 'group']) {
            const s = mismatchSentence({ actualKind: k, expectedKind: 'text', count: 1 });
            expect(s).not.toMatch(/array|object|string/);
        }
    });
});

describe('kindAtPath', () => {
    it('reads the kind of what the path resolves to', () => {
        expect(kindAtPath('steps.a.output.warnings', ROOT)).toBe('list');
        expect(kindAtPath('steps.a.output.rows', ROOT)).toBe('table');
        expect(kindAtPath('steps.a.output.balance', ROOT)).toBe('group');
        expect(kindAtPath('steps.a.output.nope', ROOT)).toBe('unknown');
        expect(kindAtPath('x', null)).toBe('unknown');
    });
});

describe('columnForSlot', () => {
    const root = { steps: { a: { output: { accounts: [{ id: 1, email: 'x@y.nl', displayName: 'X', provisioned: false }] } } } };
    const P = 'steps.a.output.accounts';
    it('takes the column the slot is named after, also as its tail (accountId → id)', () => {
        expect(columnForSlot(P, root, { slot: 'accountId', expectedKind: 'number' })).toBe(`${P}[*].id`);
        expect(columnForSlot(P, root, { slot: 'email', expectedKind: 'email' })).toBe(`${P}[*].email`);
        expect(columnForSlot(P, root, { slot: 'recipientEmail', expectedKind: 'email' })).toBe(`${P}[*].email`);
    });
    it('else a lone column of the wanted kind; never for a text slot', () => {
        expect(columnForSlot(P, root, { slot: 'count', expectedKind: 'number' })).toBe(`${P}[*].id`);
        expect(columnForSlot(P, root, { slot: 'flag', expectedKind: 'yesno' })).toBe(`${P}[*].provisioned`);
        expect(columnForSlot(P, root, { slot: 'title', expectedKind: 'text' })).toBeNull();
    });
});

describe('fieldForSlot', () => {
    const root = { steps: { a: { output: { customer: { name: 'Acme BV', email: 'info@acme.example', address: { city: 'Utrecht' } } } } } };
    const P = 'steps.a.output.customer';
    it('takes the field the slot is named after, also as its tail', () => {
        expect(fieldForSlot(P, root, { slot: 'email', expectedKind: 'email' })).toBe(`${P}.email`);
        expect(fieldForSlot(P, root, { slot: 'customerName', expectedKind: 'text' })).toBe(`${P}.name`);
    });
    it('a title slot takes the record\'s headline; a body keeps the summary (null)', () => {
        expect(fieldForSlot(P, root, { slot: 'title', expectedKind: 'text' })).toBe(`${P}.name`);
        expect(fieldForSlot(P, root, { slot: 'content', expectedKind: 'text' })).toBeNull();
    });
    it('a non-text slot takes a lone field of its kind', () => {
        expect(fieldForSlot(P, root, { slot: 'to', expectedKind: 'email' })).toBe(`${P}.email`);
    });
});
