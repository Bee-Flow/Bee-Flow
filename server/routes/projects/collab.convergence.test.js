/**
 * Convergence: three editors type into the same document at once, and every
 * byte travels through the real handlers — POST /docs/:docId/updates up, the
 * real project stream (`GET /:id/stream?doc=`) down, POST /sync to repair —
 * over the real store (PGlite), sealing and hub.
 *
 * The network is hostile on purpose (seeded, so a failure replays):
 *   - batches are sometimes sent twice (a retried POST),
 *   - sometimes held back and sent after a later batch (reordering),
 *   - stream frames are sometimes dropped, which the client notices from
 *     `from` and repairs with a state-vector sync,
 *   - clients sometimes throw their cursor away and resync outright.
 *
 * At the end every copy must be identical (Yjs state and text), and the
 * server's own rendering of the document (what the mirror, the AI and exports
 * read) must say the same. When the editor bundle is built, the same run is
 * repeated with the real converter.
 *
 * Run: cd server && node --test routes/projects/collab.convergence.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Y = require('yjs');
const { collabWorld, until, docText, typeInto, ytextString, b64 } = require('../../core/collab/collab.testkit');
const { serveCollab } = require('./collab.testkit');
const { loadBundle, makeConverter } = require('../../core/collab/convert');

const USERS = ['ann', 'bob', 'cat'].map((id) => ({ id, organizationId: 'org1' }));
const ROLES = { p1: { ann: 'editor', bob: 'editor', cat: 'owner' } };

/** A small seeded PRNG, so a failing run can be replayed exactly. */
function prng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'plan', 'budget', 'draft', 'note', 'team', 'launch'];

async function runScenario({ seed, converter }) {
    const w = await collabWorld({ converter });
    const h = serveCollab(w, ROLES);
    const rand = prng(seed);
    const pick = (list) => list[Math.floor(rand() * list.length)];
    try {
        w.addResource('notebook', 'nb-1', { html: '<p>Kickoff</p><p>Agenda</p>' });
        const opened = await h.call('POST', '/api/projects/p1/docs', { body: { kind: 'notebook', resourceId: 'nb-1' }, user: USERS[0] });
        assert.strictEqual(opened.status, 200, opened.text);
        const { docId } = opened.body;
        const base = `/api/projects/p1/docs/${docId}`;

        const clients = [];
        for (const user of USERS) {
            const c = { user, doc: new Y.Doc(), seq: 0, outbox: [], held: null, resyncs: 0, dropped: 0 };
            c.doc.on('update', (u, origin) => { if (origin !== 'remote') c.outbox.push(u); });
            c.sync = async () => {
                const res = await h.call('POST', `${base}/sync`, { body: { sv: b64(Y.encodeStateVector(c.doc)) }, user });
                assert.strictEqual(res.status, 200, res.text);
                Y.applyUpdate(c.doc, Buffer.from(res.body.update, 'base64'), 'remote');
                c.seq = Math.max(c.seq, res.body.seq);
                c.resyncs += 1;
            };
            await c.sync();
            c.stream = await h.openStream(`/api/projects/p1/stream?doc=${docId}&docSince=${c.seq}`, user, (f) => {
                if (f.event === 'doc.resync') { c.pendingResync = true; return; }
                if (f.event !== 'doc.update') return;
                // A lossy network: this frame never arrives.
                if (rand() < 0.1) { c.dropped += 1; c.pendingResync = true; return; }
                if (f.data.from > c.seq) { c.pendingResync = true; return; }
                Y.applyUpdate(c.doc, Buffer.from(f.data.u, 'base64'), 'remote');
                c.seq = Math.max(c.seq, f.data.seq);
            });
            clients.push(c);
        }
        await until(() => clients.every((c) => c.stream.frames.some((f) => f.event === 'ready')));

        const post = async (c, batch) => {
            const res = await h.call('POST', `${base}/updates`, { body: { clientId: c.doc.clientID, updates: batch.map(b64) }, user: c.user });
            assert.strictEqual(res.status, 200, res.text);
        };

        for (let round = 0; round < 40; round += 1) {
            for (const c of clients) {
                const fragment = c.doc.getXmlFragment('content');
                const action = rand();
                if (action < 0.6) {
                    const index = Math.floor(rand() * (fragment.length + 1));
                    const block = fragment.get(Math.min(index, fragment.length - 1));
                    const at = block ? Math.floor(rand() * (ytextString(block.get(0)).length + 1)) : 0;
                    typeInto(c.doc, index, at, ` ${pick(WORDS)}`);
                } else if (action < 0.8 && fragment.length > 0) {
                    const t = fragment.get(Math.floor(rand() * fragment.length)).get(0);
                    const len = ytextString(t).length;
                    if (len > 2) t.delete(Math.floor(rand() * (len - 2)), 2);
                }
                if (c.outbox.length && rand() < 0.7) {
                    const batch = c.outbox.splice(0);
                    if (c.held === null && rand() < 0.2) {
                        c.held = batch;            // reordering: send it after the next one
                    } else {
                        await post(c, batch);
                        if (rand() < 0.15) await post(c, batch);   // a retried POST
                        if (c.held) { await post(c, c.held); c.held = null; }
                    }
                }
                if (c.pendingResync || rand() < 0.05) { c.pendingResync = false; await c.sync(); }
            }
        }

        // Quiesce: everything sent, every stream drained, one last repair sync.
        for (const c of clients) {
            if (c.held) { await post(c, c.held); c.held = null; }
            if (c.outbox.length) await post(c, c.outbox.splice(0));
        }
        const head = (await w.store.getDoc(docId)).updateSeq;
        await until(() => clients.every((c) => c.seq >= head || c.pendingResync || c.dropped > 0));
        for (const c of clients) await c.sync();

        const [first, ...rest] = clients;
        const text = docText(first.doc);
        for (const c of rest) {
            assert.deepStrictEqual(c.doc.getXmlFragment('content').toJSON(), first.doc.getXmlFragment('content').toJSON());
            assert.strictEqual(docText(c.doc), text);
        }
        assert.ok(first.doc.getXmlFragment('content').length >= 2, 'the seeded paragraphs took part');
        assert.ok(text.length > 20, 'real text was typed');
        assert.ok(clients.some((c) => c.dropped > 0), 'the scenario really dropped frames');

        // The server renders the same document.
        const served = await w.collab.read('notebook', 'nb-1');
        return { served, clients, first, head };
    } finally {
        await h.close();
        await w.close();
    }
}

test('three editors converge through the real handlers despite duplication, reordering, loss and resyncs', async () => {
    for (const seed of [7, 1234, 99991]) {
        const { served, first } = await runScenario({ seed });
        assert.strictEqual(served.markdown, docText(first.doc), `seed ${seed}: the server renders what the editors see`);
    }
});

const bundle = loadBundle();
test('the same run with the editor bundle: the materialised Markdown matches the editors', { skip: !bundle && 'the editor bundle is not built (npm run build:editor-collab)' }, async () => {
    const converter = makeConverter({ bundle });
    const { served, first } = await runScenario({ seed: 424242, converter });
    const expected = bundle.astToMarkdown(bundle.fragmentToAst(first.doc.getXmlFragment('content')));
    assert.strictEqual(served.markdown, expected);
});
