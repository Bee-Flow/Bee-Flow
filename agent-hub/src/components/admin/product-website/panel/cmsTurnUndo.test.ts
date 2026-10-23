import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revertBuilderTurn } from './cmsTurnUndo';
import type { BuilderTurn } from './useCmsPanelState';

interface Call {
    method: string;
    path: string;
    body: unknown;
}

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const entry = (id: string, slug: string, title = slug) => ({ id, slug, title, isHomepage: false });

describe('revertBuilderTurn', () => {
    const calls: Call[] = [];

    beforeEach(() => {
        calls.length = 0;
        // What the server holds after the turn: it created pg_new, reordered the pages and retitled pg_b.
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
            const url = new URL(String(input), 'http://localhost');
            const path = url.pathname.replace('/api/cms/sites/pj_site', '');
            const method = init?.method ?? 'GET';
            calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
            if (method === 'GET' && path === '') {
                return json(200, { site: { rev: 9, homepageId: 'pg_b', pages: [entry('pg_b', 'b', 'B (AI title)'), entry('pg_a', 'a')] } });
            }
            if (method === 'GET' && path === '/pages/pg_a') return json(200, { id: 'pg_a', rev: 4 });
            if (method === 'GET' && path === '/pages/pg_b') return json(200, { id: 'pg_b', rev: 12 });
            if (method === 'PUT' && path === '') return json(200, { site: { rev: 10 } });
            if (method === 'PUT' && /^\/pages\/pg_[a-z]+$/.test(path)) {
                const sent = (JSON.parse(String(init?.body)) as { page: { rev: number } }).page.rev;
                return json(200, { page: { rev: sent + 1 } });
            }
            return json(200, { success: true });
        });
    });
    afterEach(() => { vi.restoreAllMocks(); });

    it('deletes what the turn created and restores chrome, page settings, order, homepage and pages at the revisions stored now', async () => {
        const turn: BuilderTurn = {
            preSite: { id: 'pj_site', rev: 2, name: 'Before', homepageId: 'pg_a', pages: [entry('pg_a', 'a'), entry('pg_b', 'b', 'B')] },
            prePages: [{ id: 'pg_a', rev: 1, title: 'A', blocks: [] }, { id: 'pg_b', rev: 1, title: 'B', blocks: [] }],
            created: ['pg_new'],
            touched: new Set(['pg_new', 'pg_b']),
            draftsSeen: 3,
        };

        const restored = await revertBuilderTurn('pj_site', turn);

        expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
            'DELETE /pages/pg_new',
            'GET ',
            'PUT ',                       // chrome, at the stored revision
            'PUT /pages/pg_b/meta',       // the AI retitled it
            'PUT /pages/order',
            'PUT /pages/pg_a/homepage',
            'GET /pages/pg_b',
            'PUT /pages/pg_b',
        ]);
        expect((calls[2].body as { site: { rev: number } }).site.rev).toBe(9);
        expect(calls[3].body).toMatchObject({ title: 'B', slug: 'b' });
        expect(calls[4].body).toEqual({ orderedIds: ['pg_a', 'pg_b'] });
        expect((calls[7].body as { page: { rev: number } }).page.rev).toBe(12);

        // The panel gets the documents back with the revisions the server just stored.
        expect(restored.site?.rev).toBe(10);
        expect(restored.pages.find((p) => p.id === 'pg_b')?.rev).toBe(13);
        expect(restored.pages.find((p) => p.id === 'pg_a')?.rev).toBe(1);
    });
});
