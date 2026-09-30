/**
 * The shared reader of the server's `409 in_use` delete guard.
 *
 * The failure this exists to catch is a delete that can never happen: every
 * first DELETE of a recording is refused today, and a phone that only showed
 * the refusal as a toast left the meeting where it was, for every meeting. The
 * opposite cure — always sending the confirmation — deletes fine and never
 * shows anybody what breaks. Both halves are pinned: the reader for all four
 * bodies, and which request carries which confirmation.
 *
 * Run: cd mobile && ./node_modules/.bin/jest src/core/api/deleteGuard.test.ts
 */

import { ApiError, api } from './client';
import { GUARD_KINDS, guardedDelete, readDeleteGuard, type GuardedResource } from './deleteGuard';

jest.mock('./client', () => {
    const actual = jest.requireActual('./client');
    return { ...actual, api: { ...actual.api, delete: jest.fn() } };
});

const del = api.delete as jest.Mock;

const refusal = (body: unknown) => new ApiError('This thing is still in use', { status: 409, body });

beforeEach(() => {
    del.mockReset();
    del.mockResolvedValue({ success: true });
});

describe('readDeleteGuard — the four bodies the server sends', () => {
    it('reads a recording refusal, foreign rows and all', () => {
        // routes/transcriptions/noteActions.js — redactForeign strips the title
        // of a row somebody else owns; the reader keeps the row, not a guess.
        const guard = readDeleteGuard(
            refusal({
                error: 'This meeting is still in use',
                code: 'in_use',
                usage: [
                    { kind: 'kb', id: 'kb1', title: 'Sales', role: 'collects' },
                    { kind: 'automation', id: 'a1', title: null, foreign: true },
                ],
                unchecked: ['notebook'],
            }),
            'recording',
        );
        expect(guard).toEqual({
            blocked: true,
            readable: true,
            usage: [
                { kind: 'kb', id: 'kb1', title: 'Sales', role: 'collects' },
                { kind: 'automation', id: 'a1', title: null, foreign: true },
            ],
            unchecked: ['notebook'],
        });
    });

    it('reads the refusal that is only "could not check" — today’s normal case', () => {
        const guard = readDeleteGuard(
            refusal({ code: 'in_use', usage: [], unchecked: ['notebook'] }),
            'recording',
        );
        expect(guard.blocked).toBe(true);
        expect(guard.usage).toEqual([]);
        expect(guard.unchecked).toEqual(['notebook']);
    });

    it('reads a knowledge-base refusal', () => {
        const guard = readDeleteGuard(
            refusal({
                error: 'This knowledge base is still in use',
                code: 'in_use',
                usage: [{ kind: 'agent', id: 'ag1', title: 'Helpdesk', role: 'searches' }],
                unchecked: ['template', 'support'],
            }),
            'knowledgeBase',
        );
        expect(guard.usage.map((r) => r.title)).toEqual(['Helpdesk']);
        expect(guard.unchecked).toEqual(['template', 'support']);
    });

    it('reads a skill refusal', () => {
        const guard = readDeleteGuard(
            refusal({
                error: 'This skill is still in use',
                code: 'in_use',
                usage: [{ kind: 'agent', id: 'ag1', title: 'Writer', role: 'chat' }],
                unchecked: [],
            }),
            'skill',
        );
        expect(guard).toMatchObject({ blocked: true, readable: true, unchecked: [] });
        expect(guard.usage).toHaveLength(1);
    });

    it('reads a webpage refusal, `complete` and all', () => {
        const guard = readDeleteGuard(
            refusal({ code: 'in_use', usage: [], unchecked: ['chat', 'agent'], complete: false }),
            'webpage',
        );
        expect(guard.unchecked).toEqual(['chat', 'agent']);
    });

    it('reads the payload itself as well as the error that carries it', () => {
        const guard = readDeleteGuard({ code: 'in_use', usage: [], unchecked: ['agent'] }, 'skill');
        expect(guard.blocked).toBe(true);
        expect(guard.unchecked).toEqual(['agent']);
    });
});

describe('readDeleteGuard — an unreadable answer is "I know nothing", never "nothing"', () => {
    it.each(Object.keys(GUARD_KINDS) as GuardedResource[])(
        'a bare 409 for a %s reports every kind that guard scans as unchecked',
        (resource) => {
            const guard = readDeleteGuard(new ApiError('boom', { status: 409, body: null }), resource);
            expect(guard.blocked).toBe(true);
            expect(guard.readable).toBe(false);
            expect(guard.unchecked).toEqual([...GUARD_KINDS[resource]]);
        },
    );

    it('an `unchecked` that is not an array falls back to the full list', () => {
        const guard = readDeleteGuard(refusal({ code: 'in_use', usage: [], unchecked: 'notebook' }), 'recording');
        expect(guard.unchecked).toEqual(['kb', 'automation', 'notebook']);
    });

    it('drops rows that are not objects and kinds that are not words', () => {
        const guard = readDeleteGuard(
            refusal({ code: 'in_use', usage: [null, 'x', { kind: 'agent' }], unchecked: ['', 3, 'app'] }),
            'knowledgeBase',
        );
        expect(guard.usage).toEqual([{ kind: 'agent' }]);
        expect(guard.unchecked).toEqual(['app']);
    });

    it('is not the guard for a 500, a 404, an offline failure or a plain success', () => {
        for (const x of [
            new ApiError('server', { status: 500, body: { error: 'nope' } }),
            new ApiError('gone', { status: 404, body: { error: 'Not found' } }),
            new Error('offline'),
            null,
            undefined,
            { success: true },
        ]) {
            expect(readDeleteGuard(x, 'recording').blocked).toBe(false);
        }
    });
});

describe('guardedDelete — which request carries which confirmation', () => {
    it('sends the first request bare, for every resource', async () => {
        for (const resource of Object.keys(GUARD_KINDS) as GuardedResource[]) {
            await guardedDelete('/api/x/1', resource);
            await guardedDelete('/api/x/1', resource, false);
        }
        for (const call of del.mock.calls) expect(call).toEqual(['/api/x/1', undefined]);
    });

    it('confirms with ?confirm=1 for recordings, knowledge bases and webpages', async () => {
        for (const resource of ['recording', 'knowledgeBase', 'webpage'] as const) {
            await guardedDelete('/api/x/1', resource, true);
        }
        for (const call of del.mock.calls) expect(call).toEqual(['/api/x/1', { query: { confirm: '1' } }]);
    });

    it('confirms a skill with ?confirmBreaking=true — `confirm=1` is a 400 there', async () => {
        await guardedDelete('/api/skills/s1', 'skill', true);
        expect(del).toHaveBeenCalledWith('/api/skills/s1', { query: { confirmBreaking: 'true' } });
    });
});
