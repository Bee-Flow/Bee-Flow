import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { saveAttachedKnowledgeBases } from './conversationKbApi';

/**
 * The point of this module is the RETURN VALUE, so that is what is pinned:
 * a success reports the server's stored list, and every other outcome reports
 * that nothing was stored. "It probably saved" is the one answer the composer
 * must never act on — it would put the request back on screen as though it
 * were the answer.
 */

const respond = (status, body, { readable = true } = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => { if (!readable) throw new Error('not json'); return body; },
    text: async () => '',
});

beforeEach(() => {
    vi.spyOn(global, 'fetch').mockResolvedValue(respond(200, { success: true, knowledgeBaseIds: [] }));
});

afterEach(() => { vi.restoreAllMocks(); });

describe('saveAttachedKnowledgeBases — the request', () => {
    it('PATCHes the conversation with the list as its only field', async () => {
        await saveAttachedKnowledgeBases('conv-1', ['kb1', 'kb2']);
        const [url, options] = global.fetch.mock.calls[0];
        expect(String(url)).toContain('/ai/direct/conversations/conv-1');
        expect(options.method).toBe('PATCH');
        expect(JSON.parse(options.body)).toEqual({ knowledgeBaseIds: ['kb1', 'kb2'] });
    });

    it('sends an empty list as an explicit detach', async () => {
        await saveAttachedKnowledgeBases('conv-1', []);
        expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({ knowledgeBaseIds: [] });
    });

    it('does not call the API without a conversation to write to', async () => {
        const result = await saveAttachedKnowledgeBases(null, ['kb1']);
        expect(global.fetch).not.toHaveBeenCalled();
        expect(result).toMatchObject({ ok: false, reason: 'failed' });
    });
});

describe('saveAttachedKnowledgeBases — reading back what was stored', () => {
    it('reports the SERVER list, not the one that was sent', async () => {
        // The server deduplicates, trims and re-authorises. Three ids in, one
        // id stored — and the composer has to show the one.
        global.fetch.mockResolvedValue(respond(200, { success: true, knowledgeBaseIds: ['kb1'] }));
        const result = await saveAttachedKnowledgeBases('conv-1', ['kb1', 'kb2', 'kb2']);
        expect(result).toEqual({ ok: true, knowledgeBaseIds: ['kb1'] });
    });

    it('drops anything in that list that is not a usable id', async () => {
        global.fetch.mockResolvedValue(respond(200, { knowledgeBaseIds: ['kb1', '', null, 3] }));
        const result = await saveAttachedKnowledgeBases('conv-1', ['kb1']);
        expect(result).toEqual({ ok: true, knowledgeBaseIds: ['kb1'] });
    });

    it('treats a 200 it cannot read as a failure, not a success', async () => {
        // The write happened; WHAT it wrote is unknown. Reporting success here
        // is exactly the substitution this module exists to prevent.
        global.fetch.mockResolvedValue(respond(200, { success: true }));
        expect(await saveAttachedKnowledgeBases('conv-1', ['kb1'])).toMatchObject({ ok: false, reason: 'failed' });

        global.fetch.mockResolvedValue(respond(200, null, { readable: false }));
        expect(await saveAttachedKnowledgeBases('conv-1', ['kb1'])).toMatchObject({ ok: false, reason: 'failed' });
    });
});

describe('saveAttachedKnowledgeBases — refusals', () => {
    it('names the ids the server refused, and stores nothing', async () => {
        global.fetch.mockResolvedValue(respond(400, {
            error: 'One or more knowledge bases are not available',
            invalid: ['kb9'],
        }));
        expect(await saveAttachedKnowledgeBases('conv-1', ['kb1', 'kb9'])).toEqual({
            ok: false, reason: 'invalid', invalid: ['kb9'], status: 400,
        });
    });

    it('separates a refused SHAPE from refused ids', async () => {
        global.fetch.mockResolvedValue(respond(400, { error: 'Too many knowledge bases' }));
        expect(await saveAttachedKnowledgeBases('conv-1', ['kb1'])).toMatchObject({ ok: false, reason: 'rejected' });
    });

    it('maps the statuses that mean something specific', async () => {
        const cases = [[403, 'forbidden'], [404, 'gone'], [503, 'unavailable'], [500, 'failed']];
        for (const [status, reason] of cases) {
            global.fetch.mockResolvedValue(respond(status, { error: 'nope' }));
            expect(await saveAttachedKnowledgeBases('conv-1', ['kb1'])).toMatchObject({ ok: false, reason });
        }
    });

    it('survives the network being gone', async () => {
        global.fetch.mockRejectedValue(new Error('offline'));
        expect(await saveAttachedKnowledgeBases('conv-1', ['kb1'])).toMatchObject({ ok: false, reason: 'failed' });
    });
});
