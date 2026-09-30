/**
 * A notebook co-edited through a project passes the notebooks gates.
 *
 * /api/notebooks sits behind the notebooks module, the `notebooks` capability,
 * the operator's feature switch and the `use_notebooks` permission. The
 * co-editing routes under /api/projects only ran the project gates, so a
 * member whose plan, organisation or role withdrew notebooks still read a
 * notebook's body (open, sync, the document stream) and, as an editor,
 * rewrote it (updates). Here the gates run for a notebook, after the role
 * gate, and leave a designed page alone.
 *
 * Served for real over the core/collab service and store (PGlite); only the
 * role gate, the resources and the notebooks gates' own verdict are stand-ins
 * (collab.testkit.js, notebookGate.makeNotebookGate({ gates })).
 *
 * Run: cd server && node --test routes/projects/collab.notebookGate.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Y = require('yjs');
const { collabWorld, until, typeInto, b64 } = require('../../core/collab/collab.testkit');
const { serveCollab } = require('./collab.testkit');
const { makeNotebookGate } = require('./notebookGate');

const ANN = { id: 'ann', organizationId: 'org1' };      // editor in p1 and p2
const VAL = { id: 'val', organizationId: 'org1' };      // viewer in p1
const EVE = { id: 'eve', organizationId: 'org1' };      // not a member of p1
const ROLES = { p1: { ann: 'editor', val: 'viewer' }, p2: { ann: 'editor', eve: 'editor' } };

/** What the notebooks gates answer: 'pass', 'refuse' (403) or 'unsure' (503). */
let verdict = 'pass';
const fakeGate = (req, res, next) => {
    if (verdict === 'refuse') return res.status(403).json({ error: 'feature_disabled' });
    if (verdict === 'unsure') { res.set('Retry-After', '1'); return res.status(503).json({ error: 'entitlement_unavailable' }); }
    return next();
};

let w;
let h;

test.before(async () => {
    w = await collabWorld();
    h = serveCollab(w, ROLES, { requireNotebooks: makeNotebookGate({ gates: [fakeGate] }) });
});
test.after(async () => { await h.close(); await w.close(); });
test.afterEach(() => { verdict = 'pass'; });

const call = (method, url, body, user = ANN) => h.call(method, url, { body, user });
const open = (body, user = ANN, project = 'p1') => call('POST', `/api/projects/${project}/docs`, body, user);

async function openAllowed(kind, id, html = '<p>secret plan</p>') {
    w.addResource(kind, id, { html });
    const res = await open({ kind, resourceId: id });
    assert.strictEqual(res.status, 200, res.text);
    return res.body;
}

async function updatesFor(docId) {
    const doc = new Y.Doc();
    const sync = await call('POST', `/api/projects/p1/docs/${docId}/sync`, { sv: '' });
    Y.applyUpdate(doc, Buffer.from(sync.body.update, 'base64'));
    const out = [];
    doc.on('update', (u) => out.push(u));
    typeInto(doc, 0, 0, 'rewritten ');
    return { clientId: doc.clientID, updates: out.map(b64) };
}

function assertUnavailable(res) {
    assert.strictEqual(res.status, 403, res.text);
    assert.strictEqual(res.body.code, 'notebooks_unavailable');
    assert.ok(!('update' in res.body), 'no document content in a refusal');
}

test('refused notebooks: open, sync, updates and presence are 403 notebooks_unavailable, and nothing is written', async () => {
    const { docId, seq } = await openAllowed('notebook', 'nb-closed');
    const batch = await updatesFor(docId);
    verdict = 'refuse';

    assertUnavailable(await open({ kind: 'notebook', resourceId: 'nb-closed' }));
    w.addResource('notebook', 'nb-never', { html: '<p>x</p>' });
    assertUnavailable(await open({ kind: 'notebook', resourceId: 'nb-never' }));
    const made = await w.pg.query("SELECT COUNT(*)::int AS n FROM collab_docs WHERE resource_id = 'nb-never'");
    assert.strictEqual(made.rows[0].n, 0, 'a refused open creates and seeds nothing');

    assertUnavailable(await call('POST', `/api/projects/p1/docs/${docId}/sync`, { sv: '' }, VAL));
    assertUnavailable(await call('POST', `/api/projects/p1/docs/${docId}/sync`, { sv: '' }));
    assertUnavailable(await call('POST', `/api/projects/p1/docs/${docId}/updates`, batch));
    assertUnavailable(await call('POST', `/api/projects/p1/docs/${docId}/awareness`, { query: true }, VAL));

    const head = await w.pg.query('SELECT update_seq FROM collab_docs WHERE id = $1', [docId]);
    assert.strictEqual(Number(head.rows[0].update_seq), seq, 'the refused update was not stored');

    // Allowed again, the same batch goes through: the gate was the only thing in the way.
    verdict = 'pass';
    assert.strictEqual((await call('POST', `/api/projects/p1/docs/${docId}/updates`, batch)).status, 200);
});

test('a gate that cannot tell is 503 notebooks_unknown, never a pass', async () => {
    const { docId } = await openAllowed('notebook', 'nb-unsure');
    verdict = 'unsure';
    const res = await call('POST', `/api/projects/p1/docs/${docId}/sync`, { sv: '' });
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.body.code, 'notebooks_unknown');
});

test('the role gate still answers first: a non-member and a foreign document read 404, not 403', async () => {
    const { docId } = await openAllowed('notebook', 'nb-members');
    verdict = 'refuse';
    assert.strictEqual((await open({ kind: 'notebook', resourceId: 'nb-members' }, EVE)).status, 404);
    assert.strictEqual((await call('POST', `/api/projects/p1/docs/${docId}/sync`, { sv: '' }, EVE)).status, 404);
    // A document id of p1 used through p2, where ann is an editor too.
    assert.strictEqual((await call('POST', `/api/projects/p2/docs/${docId}/sync`, { sv: '' })).status, 404);
    assert.strictEqual((await call('POST', `/api/projects/p1/docs/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}/sync`, { sv: '' })).status, 404);
});

test('a designed page is not a notebook: its co-editing does not ask the notebooks gates', async () => {
    verdict = 'refuse';
    const { docId } = await openAllowed('document', 'page-1', '<p>page</p>');
    const sync = await call('POST', `/api/projects/p1/docs/${docId}/sync`, { sv: '' }, VAL);
    assert.strictEqual(sync.status, 200, sync.text);
    const batch = await updatesFor(docId);
    assert.strictEqual((await call('POST', `/api/projects/p1/docs/${docId}/updates`, batch)).status, 200);
});

test('the document stream does not join a refused notebook: it closes, and no frame carries its body', async () => {
    const { docId } = await openAllowed('notebook', 'nb-stream');
    verdict = 'refuse';
    const s = await h.openStream(`/api/projects/p1/stream?doc=${docId}&docSince=0`, VAL);
    try {
        await until(() => s.frames.some((f) => f.event === 'doc.closed'));
        assert.deepStrictEqual(s.frames.find((f) => f.event === 'doc.closed').data, { docId, reason: 'not_found' });
        assert.ok(!s.frames.some((f) => f.event === 'doc.joined' || f.event === 'doc.update'));
    } finally {
        s.close();
    }

    verdict = 'pass';
    const joined = await h.openStream(`/api/projects/p1/stream?doc=${docId}&docSince=0`, VAL);
    try {
        await until(() => joined.frames.some((f) => f.event === 'doc.joined'));
    } finally {
        joined.close();
    }
});
