/**
 * Deleting a knowledge base: the bare request first, `?confirm=1` only when
 * the person has seen what uses it (server/routes/knowledgeBases/detail.js).
 * And the passage search global search shares: no retry, a long timeout, and
 * the caller's signal, so a replaced keystroke's request is cancelled.
 *
 * Run: cd mobile && ./node_modules/.bin/jest src/features/knowledge/api/endpoints.test.ts
 */

import { api } from '@/core/api/client';

import { deleteKnowledgeBase, searchKnowledgeBases } from './endpoints';

jest.mock('@/core/api/client', () => {
    const actual = jest.requireActual('@/core/api/client');
    return { ...actual, api: { ...actual.api, delete: jest.fn(), post: jest.fn() } };
});

const del = api.delete as jest.Mock;
const post = api.post as jest.Mock;

beforeEach(() => {
    del.mockReset();
    del.mockResolvedValue({ success: true });
});

describe('deleteKnowledgeBase', () => {
    it('sends the first request without a confirmation', async () => {
        await deleteKnowledgeBase('kb1');
        expect(del).toHaveBeenCalledWith('/api/kb/kb1', undefined);
    });

    it('sends ?confirm=1 once the guard’s answer has been confirmed', async () => {
        await deleteKnowledgeBase('kb1', { confirmedBreaking: true });
        expect(del).toHaveBeenCalledWith('/api/kb/kb1', { query: { confirm: '1' } });
    });
});

describe('searchKnowledgeBases', () => {
    it('searches everything reachable, with the caller’s signal and no retry', async () => {
        post.mockResolvedValueOnce({ results: [{ id: 'r1', content: 'x', document_id: 'd1' }] });
        const signal = new AbortController().signal;
        const hits = await searchKnowledgeBases('invoice', [], 8, signal);
        expect(post).toHaveBeenCalledWith(
            '/api/kb/search',
            { query: 'invoice', kb_ids: [], top_k: 8 },
            { signal, retry: false, timeoutMs: 45_000 },
        );
        expect(hits.map((h) => h.document_id)).toEqual(['d1']);
    });
});
