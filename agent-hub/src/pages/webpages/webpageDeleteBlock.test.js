// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readDeleteBlock, blockHasFindings, DELETE_BLOCK_KINDS } from './webpageDeleteBlock';

/**
 * The reader for the webpage delete guard's 409.
 *
 * One failure matters more than every other case here: a refusal that is read
 * as "nothing uses this page". So each shape is tested twice — once where it
 * really answers, once where it is damaged and must report EVERY kind as
 * unchecked instead of none.
 */

const err = (status, body) => Object.assign(new Error('boom'), { status, body, code: body?.code || null });

const ROW = { kind: 'solution', id: 'p1', title: 'Offertes', role: 'contains', ownerId: 'u1' };

describe('readDeleteBlock — a real refusal', () => {
    it('reads the list and the unchecked kinds off an error carrying the body', () => {
        const b = readDeleteBlock(err(409, { code: 'in_use', usage: [ROW], unchecked: ['agent'] }));
        expect(b.blocked).toBe(true);
        expect(b.usage).toEqual([ROW]);
        expect(b.unchecked).toEqual(['agent']);
        expect(b.readable).toBe(true);
        expect(blockHasFindings(b)).toBe(true);
    });

    it('reads a payload that was RESOLVED rather than thrown', () => {
        const b = readDeleteBlock({ code: 'in_use', usage: [], unchecked: ['agent'] });
        expect(b.blocked).toBe(true);
        expect(b.usage).toEqual([]);
        expect(b.unchecked).toEqual(['agent']);
    });

    it('an empty list with an empty unchecked is a refusal that found something elsewhere', () => {
        // The guard only answers 409 when it has a reason; a body that says
        // both are empty is still a refusal and must not be read as consent.
        const b = readDeleteBlock(err(409, { code: 'in_use', usage: [], unchecked: [] }));
        expect(b.blocked).toBe(true);
        expect(b.unchecked).toEqual([]);
        expect(blockHasFindings(b)).toBe(false);
    });

    it('drops non-object rows but keeps the list readable', () => {
        const b = readDeleteBlock(err(409, { code: 'in_use', usage: [ROW, null, 'nope'], unchecked: [] }));
        expect(b.usage).toEqual([ROW]);
        expect(b.readable).toBe(true);
    });

    it('keeps only string kinds', () => {
        const b = readDeleteBlock(err(409, { code: 'in_use', usage: [], unchecked: ['agent', 0, null, ''] }));
        expect(b.unchecked).toEqual(['agent']);
    });
});

describe('readDeleteBlock — a refusal it cannot read', () => {
    it('a 409 with no body at all reports EVERY kind as unchecked, never none', () => {
        const b = readDeleteBlock(err(409, null));
        expect(b.blocked).toBe(true);
        expect(b.usage).toEqual([]);
        expect(b.unchecked).toEqual([...DELETE_BLOCK_KINDS]);
        expect(b.readable).toBe(false);
    });

    it('a `usage` that is not an array is unreadable, not empty', () => {
        const b = readDeleteBlock(err(409, { code: 'in_use', usage: 'lots', unchecked: [] }));
        expect(b.readable).toBe(false);
        expect(b.usage).toEqual([]);
        // `unchecked` was readable and said nothing was skipped — the reader
        // reports each half on its own evidence.
        expect(b.unchecked).toEqual([]);
    });

    it('an `unchecked` that is not an array means none of it was checked', () => {
        const b = readDeleteBlock(err(409, { code: 'in_use', usage: [ROW] }));
        expect(b.unchecked).toEqual([...DELETE_BLOCK_KINDS]);
        expect(b.readable).toBe(true);
    });
});

describe('readDeleteBlock — not the guard speaking', () => {
    it('a 500 is not a refusal and claims nothing in either direction', () => {
        const b = readDeleteBlock(err(500, { error: 'Failed to delete webpage' }));
        expect(b.blocked).toBe(false);
        expect(b.unchecked).toEqual([]);
    });

    it('a network error, a success and rubbish are all "not blocked"', () => {
        for (const x of [new Error('offline'), { success: true }, null, undefined, 'nope', 42, []]) {
            expect(readDeleteBlock(x).blocked).toBe(false);
        }
    });

    it('blockHasFindings is false for anything that is not a read block', () => {
        expect(blockHasFindings(null)).toBe(false);
        expect(blockHasFindings(readDeleteBlock({ success: true }))).toBe(false);
    });
});
