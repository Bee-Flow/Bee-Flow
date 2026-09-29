/**
 * The Android side of the webpage delete guard.
 *
 * The failure this file exists to catch is not a wrong sentence — it is a
 * DELETE that cannot happen at all. The server refuses every unconfirmed
 * request (two of its kinds are structurally unanswerable, so `complete` is
 * never true), and the app used to send only the bare request: every press
 * ended in a toast reading "Could not check what uses this webpage" and the
 * page stayed. Not stricter — broken, for 100% of pages.
 *
 * The other half of the same trap is the cure that is worse: always sending
 * `?confirm=1`. That deletes fine and never shows anybody what they are
 * breaking. So both halves are pinned here.
 *
 * Run: cd mobile && ./node_modules/.bin/jest src/features/publishing/deleteBlock.test.ts
 */

import {
    DELETE_BLOCK_KINDS,
    describeDeleteBlock,
    kindNoun,
    readDeleteBlock,
} from './deleteBlock';

class ApiErrorLike extends Error {
    status?: number;
    body?: unknown;
    constructor(message: string, init: { status?: number; body?: unknown } = {}) {
        super(message);
        this.status = init.status;
        this.body = init.body;
    }
}

const refusal = (body: unknown) =>
    new ApiErrorLike('This webpage is still in use', { status: 409, body });

describe('readDeleteBlock', () => {
    it('reads the guard out of the ApiError the client throws', () => {
        const block = readDeleteBlock(
            refusal({
                error: 'This webpage is still in use',
                code: 'in_use',
                usage: [{ kind: 'solution', id: 'p1', title: 'Offertes', role: 'contains' }],
                unchecked: ['chat', 'agent'],
                complete: false,
            }),
        );
        expect(block.blocked).toBe(true);
        expect(block.readable).toBe(true);
        expect(block.usage).toHaveLength(1);
        expect(block.unchecked).toEqual(['chat', 'agent']);
    });

    it('an unreadable 409 body reports EVERY kind as unchecked, not none', () => {
        // Refusing with nothing readable is exactly the case that must not be
        // mistaken for a clean list.
        const block = readDeleteBlock(new ApiErrorLike('boom', { status: 409, body: null }));
        expect(block.blocked).toBe(true);
        expect(block.readable).toBe(false);
        expect(block.unchecked).toEqual([...DELETE_BLOCK_KINDS]);
    });

    it('an `unchecked` that is not an array is itself an unreadable answer', () => {
        const block = readDeleteBlock(refusal({ code: 'in_use', usage: [], unchecked: 'agent' }));
        expect(block.unchecked).toEqual([...DELETE_BLOCK_KINDS]);
    });

    it('is not the guard for a 500, an offline failure or a plain success', () => {
        for (const x of [
            new ApiErrorLike('server', { status: 500, body: { error: 'nope' } }),
            new Error('offline'),
            null,
            undefined,
            { success: true },
        ]) {
            expect(readDeleteBlock(x).blocked).toBe(false);
        }
    });
});

describe('describeDeleteBlock', () => {
    it('names what was found and what could not be checked', () => {
        const text = describeDeleteBlock({
            blocked: true,
            usage: [{ kind: 'solution', id: 'p1', title: 'Offertes', role: 'contains' }],
            unchecked: ['chat', 'agent'],
            readable: true,
        });
        expect(text).toContain('One thing uses this page');
        expect(text).toContain('Offertes');
        expect(text).toContain('Could not be checked: chats, agents');
        expect(text).toContain('not announced and not undone');
    });

    it('an empty list with unchecked kinds never reads as “nothing uses this”', () => {
        const text = describeDeleteBlock({
            blocked: true, usage: [], unchecked: ['chat', 'agent'], readable: true,
        });
        expect(text).toContain('Nothing was found');
        expect(text).toContain('Could not be checked');
        expect(text).not.toMatch(/nothing uses this page\.$/i);
    });

    it('says so when the check did not answer at all', () => {
        const text = describeDeleteBlock({
            blocked: true, usage: [], unchecked: [...DELETE_BLOCK_KINDS], readable: false,
        });
        expect(text).toContain('did not answer at all');
    });
});

describe('kindNoun', () => {
    it('keeps an unknown kind under its own name instead of calling it “items”', () => {
        // The server's list is open. "Could not be checked: items" reads as
        // "something unnameable"; the raw token at least names the thing.
        expect(kindNoun('form', 2)).toBe('form');
        expect(kindNoun('automation', 2)).toBe('routines');
        expect(kindNoun('automation')).toBe('routine');
    });
});
