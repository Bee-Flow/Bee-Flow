/**
 * The co-editing routes (routes/projects/collab.js) served for real, over the
 * real core/collab service, store (PGlite), sealing and hub. Only the role
 * gate, the resources and the project lookup are stand-ins (collab.testkit).
 *
 * Proven, per route: the role ladder (401 / 404 non-member / 403 viewer on
 * updates), a document is only reachable through its own project, closed
 * schemas, refusals with codes the client acts on (COLLAB_UNSUPPORTED,
 * COLLAB_DISABLED, CLIENT_ID_CONFLICT, UPDATE_TOO_LARGE, DOC_TOO_LARGE,
 * PROJECT_KEY_UNAVAILABLE), legacy content seeded once, stored bytes sealed,
 * presence stamped with the session user, and the project stream carrying
 * `doc.*` frames without `id:` lines.
 *
 * Run: cd server && node --test routes/projects/collab.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Y = require('yjs');
const awarenessProtocol = require('y-protocols/awareness');
const { assertRefused } = require('../../core/http/routeHarness');
const { collabWorld, until, docText, typeInto, b64 } = require('../../core/collab/collab.testkit');
const { serveCollab } = require('./collab.testkit');
const { decodeAwareness } = require('../../core/collab/wire');

const ANN = { id: 'ann', organizationId: 'org1' };      // editor in p1 and p2
const VAL = { id: 'val', organizationId: 'org1' };      // viewer in p1
const EVE = { id: 'eve', organizationId: 'org1' };      // not a member of p1
const ROLES = {
    p1: { ann: 'editor', val: 'viewer', owen: 'owner', bob: 'editor' },
    p2: { ann: 'editor', eve: 'editor' },
    sol: { ann: 'editor' },
};

let w;
let h;

/** A request as `user` (ANN by default; null for no session). */
const api = {
    call: (method, url, { body, user } = {}) => h.call(method, url, { body, user: user === null ? undefined : (user || ANN) }),
};

test.before(async () => {
    w = await collabWorld({ limits: { maxUpdateBytes: 4096, maxBatchBytes: 8192, maxDocBytes: 64 * 1024 } });
    await w.addProject('sol', { kind: 'solution' });
    h = serveCollab(w, ROLES);
});

test.after(async () => { await h.close(); await w.close(); });

const open = (body, user = ANN, project = 'p1') => api.call('POST', `/api/projects/${project}/docs`, { body, user });

async function openNotebook(id, extra = {}) {
    w.addResource('notebook', id, extra);
    const res = await open({ kind: 'notebook', resourceId: id });
    assert.strictEqual(res.status, 200, res.text);
    return res.body;
}

/** A client copy synced from the server. */
async function syncedClient(docId, user = ANN, project = 'p1') {
    const doc = new Y.Doc();
    const res = await api.call('POST', `/api/projects/${project}/docs/${docId}/sync`, { body: { sv: '' }, user });
    assert.strictEqual(res.status, 200, res.text);
    Y.applyUpdate(doc, Buffer.from(res.body.update, 'base64'));
    return { doc, seq: res.body.seq, canEdit: res.body.canEdit };
}

function localChanges(doc, fn) {
    const out = [];
    const onUpdate = (u) => out.push(u);
    doc.on('update', onUpdate);
    fn();
    doc.off('update', onUpdate);
    return out;
}

test('open: the role ladder, and canEdit follows the role', async () => {
    w.addResource('notebook', 'nb-ladder');
    assert.strictEqual((await open({ kind: 'notebook', resourceId: 'nb-ladder' }, null)).status, 401);
    assert.strictEqual((await open({ kind: 'notebook', resourceId: 'nb-ladder' }, EVE)).status, 404);
    const viewer = await open({ kind: 'notebook', resourceId: 'nb-ladder' }, VAL);
    assert.strictEqual(viewer.status, 200);
    assert.strictEqual(viewer.body.canEdit, false);
    const editor = await open({ kind: 'notebook', resourceId: 'nb-ladder' });
    assert.strictEqual(editor.body.canEdit, true);
    assert.strictEqual(editor.body.docId, viewer.body.docId, 'one document per resource');
});

test('open: only for a supported resource filed in this project', async () => {
    w.addResource('notebook', 'nb-elsewhere', { projectId: 'p2' });
    assert.strictEqual((await open({ kind: 'notebook', resourceId: 'nb-elsewhere' })).status, 404);
    assert.strictEqual((await open({ kind: 'notebook', resourceId: 'nb-missing' })).status, 404);
    w.addResource('document', 'letter-1', { supported: false });
    const designed = await open({ kind: 'document', resourceId: 'letter-1' });
    assert.strictEqual(designed.status, 409);
    assert.strictEqual(designed.body.code, 'COLLAB_UNSUPPORTED');
    w.addResource('notebook', 'nb-sol', { projectId: 'sol' });
    const sol = await open({ kind: 'notebook', resourceId: 'nb-sol' }, ANN, 'sol');
    assert.strictEqual(sol.status, 409);
    assert.strictEqual(sol.body.code, 'COLLAB_UNSUPPORTED');
    assertRefused(assert, await open({ kind: 'deck', resourceId: 'x' }), 'body.kind', /notebook or document/);
    assertRefused(assert, await open({ kind: 'notebook', resourceId: 'x', extra: 1 }), null, /does not take "extra"/);
});

test('open: switched off is a 503 the client falls back on', async () => {
    w.addResource('notebook', 'nb-off');
    w.settings.enabled = false;
    try {
        const res = await open({ kind: 'notebook', resourceId: 'nb-off' });
        assert.strictEqual(res.status, 503);
        assert.strictEqual(res.body.code, 'COLLAB_DISABLED');
    } finally {
        w.settings.enabled = true;
    }
});

test('open: legacy content is seeded once, as the import, and sync returns it', async () => {
    const first = await openNotebook('nb-legacy', { html: '<p>Hello</p><p>World</p>' });
    assert.strictEqual(first.seq, 1);
    const again = await open({ kind: 'notebook', resourceId: 'nb-legacy' });
    assert.strictEqual(again.body.seq, 1, 'not imported twice');
    const client = await syncedClient(first.docId, VAL);
    assert.strictEqual(docText(client.doc), 'Hello\n\nWorld');
    assert.strictEqual(client.canEdit, false);
    const rows = await w.pg.query('SELECT origin, user_id FROM collab_doc_updates WHERE doc_id = $1', [first.docId]);
    assert.deepStrictEqual(rows.rows, [{ origin: 'import', user_id: null }]);
    const empty = await openNotebook('nb-empty');
    assert.strictEqual(empty.seq, 0);
});

test('sync: a document is only reachable through its own project', async () => {
    const { docId } = await openNotebook('nb-cross');
    // ann is an editor in p2 too; the id still does not resolve there.
    const cross = await api.call('POST', `/api/projects/p2/docs/${docId}/sync`, { body: { sv: '' } });
    assert.strictEqual(cross.status, 404);
    const crossWrite = await api.call('POST', `/api/projects/p2/docs/${docId}/updates`, { body: { clientId: 1, updates: [b64(Y.encodeStateAsUpdate(new Y.Doc()))] } });
    assert.strictEqual(crossWrite.status, 404);
    assert.strictEqual((await api.call('POST', `/api/projects/p1/docs/nope/sync`, { body: { sv: '' } })).status, 404);
    const badSv = await api.call('POST', `/api/projects/p1/docs/${docId}/sync`, { body: { sv: 'AAE' } });
    assert.strictEqual(badSv.status, 400);
    assert.strictEqual(badSv.body.code, 'INVALID_ENCODING');
    assertRefused(assert, await api.call('POST', `/api/projects/p1/docs/${docId}/sync`, { body: {} }), 'body.sv');
});

test('updates: editors write, sealed at rest; viewers get 403', async () => {
    const { docId } = await openNotebook('nb-write');
    const c = await syncedClient(docId);
    const updates = localChanges(c.doc, () => typeInto(c.doc, 0, 0, 'Top secret plan'));
    const viewer = await api.call('POST', `/api/projects/p1/docs/${docId}/updates`, { body: { clientId: c.doc.clientID, updates: updates.map(b64) }, user: VAL });
    assert.strictEqual(viewer.status, 403);
    const res = await api.call('POST', `/api/projects/p1/docs/${docId}/updates`, { body: { clientId: c.doc.clientID, updates: updates.map(b64) } });
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.body.seq, 1);

    const stored = await w.pg.query('SELECT body, user_id, origin FROM collab_doc_updates WHERE doc_id = $1', [docId]);
    const body = Buffer.from(stored.rows[0].body);
    assert.strictEqual(body[0], 0x01, 'AES-GCM frame');
    assert.ok(!body.includes(Buffer.from('Top secret')), 'no plaintext at rest');
    assert.deepStrictEqual({ user_id: stored.rows[0].user_id, origin: stored.rows[0].origin }, { user_id: 'ann', origin: 'user' });
    assert.ok(!JSON.stringify(w.transients).includes('Top secret'), 'no content on the bus');

    const other = await syncedClient(docId, VAL);
    assert.strictEqual(docText(other.doc), 'Top secret plan');
});

test('updates: a client id belongs to the member who used it first', async () => {
    const { docId } = await openNotebook('nb-clients');
    const c = await syncedClient(docId);
    const first = localChanges(c.doc, () => typeInto(c.doc, 0, 0, 'mine'));
    assert.strictEqual((await api.call('POST', `/api/projects/p1/docs/${docId}/updates`, { body: { clientId: c.doc.clientID, updates: first.map(b64) } })).status, 200);
    const more = localChanges(c.doc, () => typeInto(c.doc, 0, 4, '!'));
    const stolen = await api.call('POST', `/api/projects/p1/docs/${docId}/updates`, {
        body: { clientId: c.doc.clientID, updates: more.map(b64) }, user: { id: 'bob', organizationId: 'org1' },
    });
    assert.strictEqual(stolen.status, 409);
    assert.strictEqual(stolen.body.code, 'CLIENT_ID_CONFLICT');
});

test('updates: caps and garbage are refused before anything is stored', async () => {
    const { docId } = await openNotebook('nb-caps');
    const c = await syncedClient(docId);
    const url = `/api/projects/p1/docs/${docId}/updates`;
    const big = localChanges(c.doc, () => typeInto(c.doc, 0, 0, 'x'.repeat(5000)));
    const tooBig = await api.call('POST', url, { body: { clientId: c.doc.clientID, updates: big.map(b64) } });
    assert.strictEqual(tooBig.status, 413);
    assert.strictEqual(tooBig.body.code, 'UPDATE_TOO_LARGE');
    const hugeBody = await api.call('POST', url, { body: { clientId: 1, updates: ['A'.repeat(70_000)] } });
    assert.strictEqual(hugeBody.status, 413);
    assert.strictEqual(hugeBody.body.code, 'UPDATE_TOO_LARGE');
    const garbage = await api.call('POST', url, { body: { clientId: 1, updates: [b64(new Uint8Array([5, 3, 200, 1]))] } });
    assert.strictEqual(garbage.status, 400);
    assert.strictEqual(garbage.body.code, 'INVALID_UPDATE');
    assertRefused(assert, await api.call('POST', url, { body: { clientId: 1, updates: Array(33).fill('AA==') } }), 'body.updates', /at most 32/);
    assertRefused(assert, await api.call('POST', url, { body: { clientId: -1, updates: ['AA=='] } }), 'body.clientId');
    const rows = await w.pg.query('SELECT COUNT(*)::int AS n FROM collab_doc_updates WHERE doc_id = $1', [docId]);
    assert.strictEqual(rows.rows[0].n, 0);

    // The document cap.
    let status = 200;
    let code = null;
    for (let i = 0; i < 40 && status === 200; i += 1) {
        const chunk = localChanges(c.doc, () => typeInto(c.doc, i, 0, 'y'.repeat(3000)));
        const r = await api.call('POST', url, { body: { clientId: c.doc.clientID, updates: chunk.map(b64) } });
        status = r.status;
        code = r.body.code;
    }
    assert.strictEqual(status, 413);
    assert.strictEqual(code, 'DOC_TOO_LARGE');
});

function awarenessOf(doc, state) {
    const aw = new awarenessProtocol.Awareness(doc);
    aw.setLocalState(state);
    const u = awarenessProtocol.encodeAwarenessUpdate(aw, [doc.clientID]);
    aw.destroy();
    return b64(u);
}

test('awareness: stamped with the session user; query; leave only by its author', async () => {
    const { docId } = await openNotebook('nb-presence');
    const url = `/api/projects/p1/docs/${docId}/awareness`;
    const doc = new Y.Doc();
    w.transients.length = 0;
    const res = await api.call('POST', url, { body: { update: awarenessOf(doc, { user: { id: 'owen', name: 'Owen' }, cursor: null }) }, user: VAL });
    assert.deepStrictEqual(res.body, { ok: true });
    const [ev] = w.transients.filter((t) => t.kind === 'doc.awareness');
    assert.strictEqual(ev.docId, docId);
    assert.strictEqual(decodeAwareness(Buffer.from(ev.u, 'base64'))[0].state.user.id, 'val', 'the session decides who this is');

    assert.deepStrictEqual((await api.call('POST', url, { body: { query: true }, user: VAL })).body, { ok: true });
    assert.ok(w.transients.some((t) => t.kind === 'doc.awareness.query' && t.docId === docId));

    // Somebody else cannot withdraw val's presence; val can.
    w.transients.length = 0;
    await api.call('POST', url, { body: { leave: doc.clientID } });
    assert.strictEqual(w.transients.length, 0);
    await api.call('POST', url, { body: { leave: doc.clientID }, user: VAL });
    assert.deepStrictEqual(w.transients.map((t) => [t.kind, t.left]), [['doc.awareness', [doc.clientID]]]);

    // Presence under a client id bound to another writer is dropped.
    const c = await syncedClient(docId);
    const ups = localChanges(c.doc, () => typeInto(c.doc, 0, 0, 'a'));
    await api.call('POST', `/api/projects/p1/docs/${docId}/updates`, { body: { clientId: c.doc.clientID, updates: ups.map(b64) } });
    const spoof = await api.call('POST', url, { body: { update: awarenessOf(c.doc, { cursor: 1 }) }, user: VAL });
    assert.deepStrictEqual(spoof.body, { ok: false });

    assertRefused(assert, await api.call('POST', url, { body: { query: true, leave: 3 } }), null, /exactly one of/);
    assert.strictEqual((await api.call('POST', url, { body: { query: true }, user: EVE })).status, 404);
});

test('no project key: 503 with a code, and nothing is written', async () => {
    w.addResource('notebook', 'nb-nokey', { html: '<p>x</p>' });
    w.failKeys(true);
    try {
        const res = await open({ kind: 'notebook', resourceId: 'nb-nokey' });
        assert.strictEqual(res.status, 503);
        assert.strictEqual(res.body.code, 'PROJECT_KEY_UNAVAILABLE');
    } finally {
        w.failKeys(false);
    }
    const rows = await w.pg.query("SELECT d.seeded_at, (SELECT COUNT(*)::int FROM collab_doc_updates u WHERE u.doc_id = d.id) AS n FROM collab_docs d WHERE d.resource_id = 'nb-nokey'");
    assert.strictEqual(rows.rows[0].seeded_at, null);
    assert.strictEqual(rows.rows[0].n, 0);
    // With the key back the same document opens and seeds.
    assert.strictEqual((await open({ kind: 'notebook', resourceId: 'nb-nokey' })).body.seq, 1);
});

test('the project stream carries doc.* frames without id lines, only for its own project', async () => {
    const { docId, seq } = await openNotebook('nb-stream', { html: '<p>base</p>' });
    const s = await h.openStream(`/api/projects/p1/stream?doc=${docId}&docSince=${seq}`, VAL);
    const cross = await h.openStream(`/api/projects/p2/stream?doc=${docId}&docSince=0`, ANN);
    try {
        await until(() => s.frames.some((f) => f.event === 'ready'));
        const c = await syncedClient(docId);
        const ups = localChanges(c.doc, () => typeInto(c.doc, 0, 4, ' line'));
        await api.call('POST', `/api/projects/p1/docs/${docId}/updates`, { body: { clientId: c.doc.clientID, updates: ups.map(b64) } });
        await until(() => s.frames.some((f) => f.event === 'doc.update'));
        const frame = s.frames.find((f) => f.event === 'doc.update');
        assert.ok(!/^id: /m.test(frame.raw), 'no id line: the project cursor does not move');
        assert.strictEqual(frame.data.docId, docId);
        assert.strictEqual(frame.data.from, 1);
        assert.strictEqual(frame.data.seq, 2);
        assert.deepStrictEqual(frame.data.by, ['ann']);
        const follower = new Y.Doc();
        Y.applyUpdate(follower, Buffer.from((await api.call('POST', `/api/projects/p1/docs/${docId}/sync`, { body: { sv: '' } })).body.update, 'base64'));
        assert.strictEqual(docText(follower), 'base line');

        await until(() => cross.frames.some((f) => f.event === 'doc.closed'));
        assert.deepStrictEqual(cross.frames.find((f) => f.event === 'doc.closed').data, { docId, reason: 'not_found' });
        assert.ok(!cross.frames.some((f) => f.event === 'doc.update'), 'nothing leaks into another project');
        assert.ok(!s.frames.some((f) => f.event === 'doc.moved'), 'the doorbell is not a client frame');
    } finally {
        s.close();
        cross.close();
    }
});

test('other transient frames still reach every viewer of the project: a designed document\'s section presence', async () => {
    const s = await h.openStream('/api/projects/p1/stream', VAL);
    try {
        await until(() => s.frames.some((f) => f.event === 'ready'));
        // What routes/studioDocuments/presence.js publishes: ids and a section id.
        w.bus.emit('p1', {
            transient: true, kind: 'document.presence', actorId: 'ann', targetType: 'document', targetId: 'd1',
            payload: { documentId: 'd1', clientId: 'client-ann-1', sectionId: 'pricing', state: 'editing' },
        });
        await until(() => s.frames.some((f) => f.event === 'document.presence'));
        const frame = s.frames.find((f) => f.event === 'document.presence');
        assert.ok(!/^id: /m.test(frame.raw), 'transient: no id line');
        assert.deepStrictEqual(frame.data.payload, { documentId: 'd1', clientId: 'client-ann-1', sectionId: 'pricing', state: 'editing' });
    } finally {
        s.close();
    }
});

test('updates: one update up to the service\'s own cap is accepted; past it, 413 with its code, never a bare 400', async () => {
    // The schema once capped a base64 update at 360,000 characters (about
    // 263 KB) while the service takes 576 KB: a catch-up with two pictures
    // was refused with 400 invalid_request, which ends the live session.
    const world = await collabWorld();
    const served = serveCollab(world, ROLES, { maxBodyBytes: world.collab.limits.maxBodyBytes });
    try {
        world.addResource('notebook', 'nb-wide', { html: '<p>x</p>' });
        const opened = await served.call('POST', '/api/projects/p1/docs', { body: { kind: 'notebook', resourceId: 'nb-wide' }, user: ANN });
        const { docId } = opened.body;
        const doc = new Y.Doc();
        Y.applyUpdate(doc, Buffer.from((await served.call('POST', `/api/projects/p1/docs/${docId}/sync`, { body: { sv: '' }, user: ANN })).body.update, 'base64'));
        const url = `/api/projects/p1/docs/${docId}/updates`;

        const wide = localChanges(doc, () => typeInto(doc, 1, 0, 'p'.repeat(400 * 1024)));
        assert.ok(b64(wide[0]).length > 360_000, 'past the old schema cap');
        const ok = await served.call('POST', url, { body: { clientId: doc.clientID, updates: wide.map(b64) }, user: ANN });
        assert.strictEqual(ok.status, 200, ok.text);

        const tooWide = localChanges(doc, () => typeInto(doc, 2, 0, 'q'.repeat(600 * 1024)));
        const refused = await served.call('POST', url, { body: { clientId: doc.clientID, updates: tooWide.map(b64) }, user: ANN });
        assert.strictEqual(refused.status, 413);
        assert.strictEqual(refused.body.code, 'UPDATE_TOO_LARGE');
    } finally {
        await served.close();
        await world.close();
    }
});

test('the project stream: a document that cannot be attached closes with a reason the editor falls back on', async () => {
    const { docId } = await openNotebook('nb-unavailable', { html: '<p>x</p>' });
    const attachStream = w.collab.attachStream;
    w.collab.attachStream = async () => { throw new Error('hub down'); };
    const s = await h.openStream(`/api/projects/p1/stream?doc=${docId}`, VAL);
    try {
        await until(() => s.frames.some((f) => f.event === 'doc.closed'));
        assert.deepStrictEqual(s.frames.find((f) => f.event === 'doc.closed').data, { docId, reason: 'detached', cause: 'unavailable' });
    } finally {
        w.collab.attachStream = attachStream;
        s.close();
    }
});
