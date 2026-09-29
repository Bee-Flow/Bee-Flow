/**
 * The knowledge demo's route table, driven through the real transport.
 *
 * Two things are worth pinning here and nothing else is: the routes the
 * Studio asks for EXIST, and the two that a `:id` route would happily
 * swallow are declared before it. A shadowed route does not throw — it
 * answers `null`, which every caller reads as a legitimate empty answer.
 */
import { describe, it, expect } from 'vitest';
import { createDemoTransport } from '../demoTransport';
import { ROUTES, createState } from './knowledge';

const KB = 'kb_demo_productdocs';

function transport() {
    return createDemoTransport(ROUTES, createState());
}

async function get(fetchFn, path) {
    const res = await fetchFn(path);
    expect(res.status, `${path} answered ${res.status}`).toBe(200);
    return res.json();
}

/** Collect named SSE frames the way knowledgeApi.readNamedSse does. */
async function readSse(res) {
    const text = await new Response(res.body).text();
    return text
        .split('\n\n')
        .filter(Boolean)
        .map((frame) => {
            const lines = frame.split('\n');
            const name = lines.find(l => l.startsWith('event:'))?.slice(6).trim();
            const data = lines.find(l => l.startsWith('data:'))?.slice(5).trim();
            return { name, payload: data ? JSON.parse(data) : null };
        });
}

describe('knowledge demo fixtures', () => {
    it('answers the overview summary instead of letting GET /api/kb/:id swallow it', async () => {
        const f = transport();
        const body = await get(f, '/api/kb/usage-summary');
        // The shadowed version of this route returns null (findKb('usage-summary')),
        // which index.jsx turns into `usageByKb = {}` — "used by nothing" for
        // every base. An object keyed by kb id is the only proof it is ours.
        expect(body).not.toBeNull();
        expect(body.summary[KB]).toBeTruthy();
        expect(body.summary[KB].partial).toEqual([]);
    });

    it('the summary counts agree with the per-base usage route', async () => {
        const f = transport();
        const { summary } = await get(f, '/api/kb/usage-summary');
        const { usage } = await get(f, `/api/kb/${KB}/usage`);
        const counts = {};
        for (const u of usage) counts[u.kind] = (counts[u.kind] || 0) + 1;
        expect(summary[KB].counts).toEqual(counts);
        expect(usage.length).toBeGreaterThan(0);
    });

    it('answers suggestions with a loaded, empty list', async () => {
        const f = transport();
        expect(await get(f, '/api/kb/suggestions')).toEqual({ suggestions: [] });
    });

    it('answers the test question as an SSE stream, passages first', async () => {
        const f = transport();
        const docs = await get(f, `/api/kb/${KB}/documents`);
        // A word that is certainly in this base, taken from its own content.
        const word = (docs[0].content.match(/\b[a-z]{6,}\b/i) || ['the'])[0];
        const res = await f(`/api/kb/${KB}/ask`, {
            method: 'POST',
            body: JSON.stringify({ question: `What about ${word}?` }),
        });
        expect(res.status).toBe(200);
        const frames = await readSse(res);
        expect(frames[0].name).toBe('kb_sources');
        expect(frames[0].payload.sources.length).toBeGreaterThan(0);
        for (const s of frames[0].payload.sources) {
            expect(s).toMatchObject({ title: expect.any(String), content: expect.any(String) });
            expect(typeof s.score).toBe('number');
        }
        expect(frames.filter(x => x.name === 'text').length).toBeGreaterThan(0);
        expect(frames.at(-1).name).toBe('done');
    });

    it('a question nothing matches is an empty answer, not an error', async () => {
        const f = transport();
        const res = await f(`/api/kb/${KB}/ask`, {
            method: 'POST',
            body: JSON.stringify({ question: 'zxqwvtplmk unfindable' }),
        });
        const frames = await readSse(res);
        expect(frames[0]).toEqual({ name: 'kb_sources', payload: { sources: [] } });
        expect(frames.some(x => x.name === 'error')).toBe(false);
    });

    it('answers one source document by id, and 404s an unknown one', async () => {
        const f = transport();
        const { sources } = await get(f, `/api/kb/${KB}/sources`);
        const sid = sources[0].id;
        const { documents } = await get(f, `/api/kb/${KB}/sources/${sid}/documents`);
        const one = await get(f, `/api/kb/${KB}/sources/${sid}/documents/${documents[0].id}`);
        expect(one).toEqual(documents[0]);
        // Not 204: "does not exist" and "exists and is empty" are different
        // answers, and the transport turns null into No Content.
        const missing = await f(`/api/kb/${KB}/sources/${sid}/documents/nope`);
        expect(missing.status).toBe(404);
    });

    it('answers the document body on the one route that has one', async () => {
        const f = transport();
        const docs = await get(f, `/api/kb/${KB}/documents`);
        const body = await get(f, `/api/kb/${KB}/documents/${docs[0].id}/content`);
        expect(body.document.id).toBe(docs[0].id);
        expect(body.content).toBe(docs[0].content);
        expect(body.remote_only).toBe(false);
        expect((await f(`/api/kb/${KB}/documents/nope/content`)).status).toBe(404);
    });
});
