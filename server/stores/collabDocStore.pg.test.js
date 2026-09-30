/**
 * collab_docs / collab_doc_updates / collab_doc_clients against a real
 * Postgres (@electric-sql/pglite, in-process). The store is built with
 * makeCollabDocStore over the PGlite handle: no module mocking.
 *
 * Proven:
 *   - the DDL runs twice without complaint (boot runs it on every start);
 *   - one document per resource field, found only through its own project;
 *   - seq is gapless per document, also for appends that race, and
 *     independent between documents; the seal callback gets that seq;
 *   - the size cap refuses before anything is written;
 *   - a client id belongs to its first author: new structs under it from
 *     someone else are refused, re-sent structs it already holds are not,
 *     and a user cannot write under an id bound to the AI;
 *   - seeding happens once, also when two opens race;
 *   - loadState is contiguous, compaction is compare-and-set, keeps rows in
 *     the grace window and never deletes past the checkpoint;
 *   - the work list picks idle, large and lagging documents only, refuses a
 *     threshold it does not know by name, and leaves out documents put off
 *     after a failure or fenced for a fold-back;
 *   - a fence refuses appends; the delete is compare-and-set on the seq;
 *   - the mirror lease has one holder, and its release records the seq and
 *     the measured size; the owner's content cap asks for a measurement;
 *   - authors are grouped per person/origin/agent; erasure anonymises;
 *   - deleting the project removes documents, logs and bindings.
 *
 * Run: cd server && node --test stores/collabDocStore.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pgliteDb } = require('../testUtils/pgliteDb');
const { makeCollabDocStore, DDL, CollabStoreError } = require('./collabDocStore');

const { pg, db } = pgliteDb();
const store = makeCollabDocStore(db);

let n = 0;
const nextId = (p) => `${p}-${++n}`;
const CAP = 10_000;
const sealer = (tag) => (seq) => Buffer.from(`${tag}:${seq}`);

async function newDoc(projectId = 'p1', extra = {}) {
    const { doc } = await store.ensureDoc({ id: nextId('doc'), projectId, kind: 'notebook', resourceId: nextId('nb'), createdBy: 'ann', ...extra });
    return doc;
}

function append(doc, extra = {}) {
    return store.appendUpdate({
        docId: doc.id, projectId: doc.projectId, userId: 'ann', origin: 'user',
        byteLen: 10, clients: [], seal: sealer('u'), maxStateBytes: CAP, ...extra,
    });
}

async function refused(promise, code) {
    await assert.rejects(promise, (err) => err instanceof CollabStoreError && err.code === code);
}

before(async () => {
    await pg.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL, organization_id TEXT DEFAULT '')");
    await pg.exec(DDL);
    await pg.exec(DDL);
    await pg.query("INSERT INTO projects (id, name, owner_id, organization_id) VALUES ('p1', 'p1', 'o', 'org1'), ('p2', 'p2', 'o', '')");
});

after(async () => { await pg.close(); });

test('one document per resource field, found only through its project', async () => {
    const first = await store.ensureDoc({ id: 'd-a', projectId: 'p1', kind: 'notebook', resourceId: 'nb-a', createdBy: 'ann' });
    const again = await store.ensureDoc({ id: 'd-b', projectId: 'p1', kind: 'notebook', resourceId: 'nb-a', createdBy: 'bob' });
    assert.strictEqual(first.created, true);
    assert.strictEqual(again.created, false);
    assert.strictEqual(again.doc.id, 'd-a');
    assert.strictEqual(first.doc.keyScope, 'project');
    assert.strictEqual(first.doc.ywire, 'y13v1');
    assert.ok(await store.findDoc('p1', 'd-a'));
    assert.strictEqual(await store.findDoc('p2', 'd-a'), null, 'not through another project');
    await assert.rejects(store.ensureDoc({ id: 'x', projectId: 'p1', kind: 'deck', resourceId: 'r' }), /kind must be one of/);
});

test('seq is gapless per document, also for racing appends, and the seal gets it', async () => {
    const a = await newDoc();
    const b = await newDoc();
    const results = await Promise.all(Array.from({ length: 12 }, () => append(a)));
    assert.deepStrictEqual(results.map((r) => r.seq).sort((x, y) => x - y), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.strictEqual((await append(b)).seq, 1, 'independent per document');
    const rows = await store.listUpdates(a.id, 0, 100);
    assert.deepStrictEqual(rows.map((r) => r.body.toString()), rows.map((r) => `u:${r.seq}`));
    assert.ok(Buffer.isBuffer(rows[0].body));
    const doc = await store.getDoc(a.id);
    assert.strictEqual(doc.updateSeq, 12);
    assert.strictEqual(doc.pendingCount, 12);
    assert.strictEqual(doc.pendingBytes, 120);
    assert.ok(doc.lastEditAt && doc.sessionStartedAt);
    assert.deepStrictEqual((await store.listUpdates(a.id, 10, 100)).map((r) => r.seq), [11, 12]);
});

test('an append names its project, and the size cap refuses before writing', async () => {
    const doc = await newDoc();
    await refused(append(doc, { projectId: 'p2' }), 'NOT_FOUND');
    await refused(append(doc, { byteLen: CAP + 1 }), 'DOC_TOO_LARGE');
    await append(doc, { byteLen: CAP - 5 });
    await refused(append(doc, { byteLen: 10 }), 'DOC_TOO_LARGE');
    assert.strictEqual((await store.getDoc(doc.id)).updateSeq, 1, 'refusals wrote nothing');
    await assert.rejects(append(doc, { origin: 'robot', byteLen: 1 }), /origin must be one of/);
});

test('a client id belongs to its first author', async () => {
    const doc = await newDoc();
    await append(doc, { clients: [{ clientId: 101, to: 5 }], declaredClientId: 101 });
    // The same author continues.
    await append(doc, { clients: [{ clientId: 101, to: 9 }], declaredClientId: 101 });
    // Someone else adding NEW structs under it is refused, and nothing lands.
    await refused(append(doc, { userId: 'bob', clients: [{ clientId: 101, to: 12 }] }), 'CLIENT_ID_CONFLICT');
    // ...or merely declaring it as their session id.
    await refused(append(doc, { userId: 'bob', declaredClientId: 101 }), 'CLIENT_ID_CONFLICT');
    // Re-sending structs the server already holds is a duplicate, not a write.
    const dup = await append(doc, { userId: 'bob', clients: [{ clientId: 101, to: 9 }, { clientId: 202, to: 3 }], declaredClientId: 202 });
    assert.strictEqual(dup.seq, 3);
    assert.deepStrictEqual(await store.clientBinding(doc.id, 101), { userId: 'ann', origin: 'user', maxClock: 9 });
    assert.deepStrictEqual(await store.clientBinding(doc.id, 202), { userId: 'bob', origin: 'user', maxClock: 3 });
    // An id bound to an AI write cannot be used by the person it wrote for.
    await append(doc, { origin: 'ai', agentId: 'ag1', clients: [{ clientId: 303, to: 4 }] });
    await refused(append(doc, { clients: [{ clientId: 303, to: 6 }] }), 'CLIENT_ID_CONFLICT');
    assert.strictEqual(await store.clientBinding(doc.id, 999), null);
});

test('seeding happens once, also when two opens race', async () => {
    const doc = await newDoc();
    let builds = 0;
    const build = async () => {
        builds += 1;
        return { byteLen: 7, clients: [{ clientId: 7, to: 3 }], seal: sealer('seed'), sealCheckpoint: sealer('cp') };
    };
    const [x, y] = await Promise.all([store.seedOnce(doc.id, build), store.seedOnce(doc.id, build)]);
    assert.strictEqual(builds, 1);
    assert.deepStrictEqual([x.seeded, y.seeded].sort(), [false, true]);
    assert.strictEqual(x.seq, 1);
    assert.strictEqual(y.seq, 1);
    const seeded = await store.getDoc(doc.id);
    assert.ok(seeded.seededAt);
    // The import is nobody's edit: mirror, checkpoint and feed are all "current".
    assert.strictEqual(seeded.materializedSeq, 1);
    assert.strictEqual(seeded.checkpointSeq, 1);
    assert.strictEqual(seeded.lastEditAt, null);
    const [row] = await store.listUpdates(doc.id, 0, 10);
    assert.strictEqual(row.origin, 'import');
    assert.strictEqual(row.userId, null);
    assert.deepStrictEqual(await store.clientBinding(doc.id, 7), { userId: null, origin: 'import', maxClock: 3 });
    const state = await store.loadState(doc.id, { withCheckpoint: true });
    assert.strictEqual(state.doc.checkpointSnapshot.toString(), 'cp:1');

    const empty = await newDoc();
    const r = await store.seedOnce(empty.id, async () => null);
    assert.deepStrictEqual(r, { seeded: true, seq: 0 });
    assert.ok((await store.getDoc(empty.id)).seededAt);
    await refused(store.seedOnce('nope', build), 'NOT_FOUND');
});

test('loadState is contiguous; compaction is compare-and-set and respects grace and checkpoint', async () => {
    const doc = await newDoc();
    for (let i = 0; i < 6; i += 1) await append(doc);
    let state = await store.loadState(doc.id);
    assert.deepStrictEqual(state.updates.map((u) => u.seq), [1, 2, 3, 4, 5, 6]);
    assert.strictEqual(state.doc.snapshot, null);

    // A checkpoint at 4: rows after it are the next version's contributors.
    await store.recordCheckpoint(doc.id, { seq: 4, snapshot: Buffer.from('cp4') });
    assert.ok((await store.getDoc(doc.id)).sessionStartedAt, 'more arrived after the checkpoint: session stays open');

    // Inside the grace window nothing is deleted, but the snapshot moves.
    assert.strictEqual(await store.compact({ docId: doc.id, expectedSnapshotSeq: 0, uptoSeq: 6, snapshot: Buffer.from('s6'), stateBytes: 40, deleteUpTo: 4, graceMs: 60_000 }), true);
    let after6 = await store.getDoc(doc.id);
    assert.strictEqual(after6.snapshotSeq, 6);
    assert.strictEqual(after6.retainedFrom, 1);
    assert.strictEqual(after6.pendingCount, 0);
    assert.strictEqual(after6.stateBytes, 40);
    // A second compaction from the old snapshot loses the race.
    assert.strictEqual(await store.compact({ docId: doc.id, expectedSnapshotSeq: 0, uptoSeq: 6, snapshot: Buffer.from('old'), stateBytes: 1, deleteUpTo: 6, graceMs: 0 }), false);

    await append(doc);
    await pg.query("UPDATE collab_doc_updates SET created_at = NOW() - INTERVAL '1 hour' WHERE doc_id = $1", [doc.id]);
    assert.strictEqual(await store.compact({ docId: doc.id, expectedSnapshotSeq: 6, uptoSeq: 7, snapshot: Buffer.from('s7'), stateBytes: 44, deleteUpTo: 4, graceMs: 0 }), true);
    after6 = await store.getDoc(doc.id);
    assert.strictEqual(after6.retainedFrom, 5, 'never past the checkpoint');
    assert.deepStrictEqual((await store.listUpdates(doc.id, 0, 10)).map((u) => u.seq), [5, 6, 7]);
    state = await store.loadState(doc.id);
    assert.strictEqual(state.doc.snapshot.toString(), 's7');
    assert.deepStrictEqual(state.updates, [], 'nothing after the snapshot');
    assert.strictEqual(await store.loadState('missing'), null);
});

test('loadState notices a hole and refuses to build a gapped state', async () => {
    const doc = await newDoc();
    for (let i = 0; i < 3; i += 1) await append(doc);
    await pg.query('DELETE FROM collab_doc_updates WHERE doc_id = $1 AND seq = 2', [doc.id]);
    await refused(store.loadState(doc.id), 'STATE_MOVING');
});

/** Record a mirror write of `seq` the way core/collab does: under the lease. */
async function materialised(docId, seq) {
    assert.ok((await store.claimMirror(docId, 't')).materializedSeq !== undefined);
    await store.releaseMirror(docId, 't', { seq, contentBytes: 0 });
}

test('the materialised seq never moves back; authorsBetween groups per author', async () => {
    const doc = await newDoc();
    await append(doc);
    await append(doc, { userId: 'bob' });
    await append(doc, { userId: 'ann', origin: 'ai', agentId: 'ag1' });
    await append(doc);
    await materialised(doc.id, 3);
    await materialised(doc.id, 2);
    assert.strictEqual((await store.getDoc(doc.id)).materializedSeq, 3);
    assert.deepStrictEqual(await store.authorsBetween(doc.id, 0, 4), [
        { userId: 'ann', origin: 'user', agentId: null },
        { userId: 'bob', origin: 'user', agentId: null },
        { userId: 'ann', origin: 'ai', agentId: 'ag1' },
    ]);
    assert.deepStrictEqual(await store.authorsBetween(doc.id, 3, 4), [{ userId: 'ann', origin: 'user', agentId: null }]);
    await store.recordCheckpoint(doc.id, { seq: 4, snapshot: null });
    const closed = await store.getDoc(doc.id);
    assert.strictEqual(closed.checkpointSeq, 4);
    assert.strictEqual(closed.sessionStartedAt, null, 'nothing after the checkpoint: session closed');
});

test('the work list picks idle, large and lagging documents only', async () => {
    await pg.query('DELETE FROM collab_docs');
    const t = { compactCount: 3, compactBytes: 1000, sessionIdleMs: 60_000, materialiseIdleMs: 10_000, materialiseMaxLagMs: 60_000, sessionMaxMs: 120_000 };
    const quiet = await newDoc();
    await store.seedOnce(quiet.id, async () => null);
    const busy = await newDoc();
    await append(busy);
    await materialised(busy.id, 1);
    await store.recordCheckpoint(busy.id, { seq: 1, snapshot: null });
    await pg.query('UPDATE collab_docs SET pending_count = 0 WHERE id = $1', [busy.id]);
    const large = await newDoc();
    for (let i = 0; i < 4; i += 1) await append(large);
    const idle = await newDoc();
    await append(idle);
    await pg.query("UPDATE collab_docs SET last_edit_at = NOW() - INTERVAL '2 minutes' WHERE id = $1", [idle.id]);

    const ids = (await store.listWork(t)).map((d) => d.id);
    assert.ok(!ids.includes(quiet.id), 'nothing to do');
    assert.ok(!ids.includes(busy.id), 'current and compacted');
    assert.ok(ids.includes(large.id), 'many pending updates');
    assert.ok(ids.includes(idle.id), 'idle with pending work');

    // A threshold under another name was NULL in SQL, and a NULL comparison
    // silently selected nothing: it is refused instead.
    const { sessionIdleMs, ...renamed } = t;
    await assert.rejects(store.listWork({ ...renamed, idleMs: sessionIdleMs }), /numeric sessionIdleMs/);

    // Put off after a failure, or being folded back: not listed.
    await store.deferWork(idle.id, 60_000);
    await store.fence(large.id);
    const later = (await store.listWork(t)).map((d) => d.id);
    assert.ok(!later.includes(idle.id), 'deferred');
    assert.ok(!later.includes(large.id), 'fenced');
    await store.unfence(large.id);
    await append(idle);
    assert.ok((await store.listWork(t)).some((d) => d.id === idle.id), 'an edit lifts the back-off');
});

test('a fence refuses appends until it is lifted; the delete only takes the state that was folded back', async () => {
    const doc = await newDoc();
    await append(doc);
    assert.strictEqual(await store.fence(doc.id), true);
    await assert.rejects(append(doc), (e) => e instanceof CollabStoreError && e.code === 'DOC_CLOSING');
    await store.unfence(doc.id);
    await append(doc);
    assert.strictEqual(await store.deleteDoc(doc.id, { uptoSeq: 1 }), false, 'seq 2 was never folded back');
    assert.ok(await store.getDoc(doc.id));
    assert.strictEqual(await store.deleteDoc(doc.id, { uptoSeq: 2 }), true);
    assert.strictEqual(await store.fence(doc.id), false, 'gone');
});

test('the mirror lease: one writer at a time, and the release records the seq and the measured size', async () => {
    const doc = await newDoc();
    await append(doc);
    await append(doc);
    assert.deepStrictEqual(await store.claimMirror(doc.id, 'a'), { materializedSeq: 0 });
    assert.deepStrictEqual(await store.claimMirror(doc.id, 'b'), { busy: true });
    await store.releaseMirror(doc.id, 'b', { seq: 9, contentBytes: 1 });
    assert.strictEqual((await store.getDoc(doc.id)).materializedSeq, 0, 'only the holder releases');
    await store.releaseMirror(doc.id, 'a', { seq: 1, contentBytes: 500 });
    const row = (await pg.query('SELECT materialized_seq, content_bytes, unmeasured_bytes FROM collab_docs WHERE id = $1', [doc.id])).rows[0];
    assert.deepStrictEqual([Number(row.materialized_seq), Number(row.content_bytes), Number(row.unmeasured_bytes)], [1, 500, 10], 'seq 2 (10 bytes) is not measured yet');
    assert.deepStrictEqual(await store.claimMirror(doc.id, 'b'), { materializedSeq: 1 });
    assert.strictEqual(await store.claimMirror('nope', 'c'), null);
});

test('the owner\'s content cap: an estimate past it asks for a measurement; a measurement past it is refused', async () => {
    const doc = await newDoc();
    await append(doc);
    const withCap = (extra) => append(doc, { maxContentBytes: 25, ...extra });
    await withCap({});
    await assert.rejects(withCap({}), (e) => e.code === 'CONTENT_UNMEASURED', '10 + 10 + 10 bytes may pass 25');
    await assert.rejects(withCap({ measured: { bytes: 26, atSeq: 2 } }), (e) => e.code === 'DOC_TOO_LARGE');
    await withCap({ measured: { bytes: 12, atSeq: 2 } });
    const row = (await pg.query('SELECT content_bytes, unmeasured_bytes FROM collab_docs WHERE id = $1', [doc.id])).rows[0];
    assert.deepStrictEqual([Number(row.content_bytes), Number(row.unmeasured_bytes)], [12, 0]);
    await withCap({});
});

test('documents are listed per organisation, with the org-less fallback', async () => {
    const mine = await newDoc('p1');
    const orgless = await newDoc('p2');
    const org1 = (await store.listByOrg('org1', '__default__')).map((d) => d.id);
    assert.ok(org1.includes(mine.id));
    assert.ok(!org1.includes(orgless.id));
    const fallback = (await store.listByOrg('__default__', '__default__')).map((d) => d.id);
    assert.ok(fallback.includes(orgless.id));
    assert.ok(!fallback.includes(mine.id));
});

test('documents are listed per project (for folding them back before the project is deleted)', async () => {
    const here = await newDoc('p1');
    const there = await newDoc('p2');
    const p1 = (await store.listByProject('p1')).map((d) => d.id);
    assert.ok(p1.includes(here.id));
    assert.ok(!p1.includes(there.id));
    assert.deepStrictEqual(await store.listByProject('nope'), []);
});

test('erasure anonymises the log and the bindings; the project delete cascades', async () => {
    const doc = await newDoc('p2');
    await append(doc, { userId: 'erin', clients: [{ clientId: 55, to: 2 }] });
    const counts = await store.anonymiseUser('erin');
    assert.deepStrictEqual(counts, { updates: 1, clients: 1, docs: 0 });
    const [row] = await store.listUpdates(doc.id, 0, 10);
    assert.strictEqual(row.userId, null);

    assert.strictEqual((await store.listByResource('notebook', doc.resourceId)).length, 1);
    await pg.query("DELETE FROM projects WHERE id = 'p2'");
    assert.strictEqual(await store.getDoc(doc.id), null);
    const left = await pg.query('SELECT COUNT(*)::int AS n FROM collab_doc_updates WHERE doc_id = $1', [doc.id]);
    assert.strictEqual(left.rows[0].n, 0);
    assert.strictEqual(await store.deleteDoc(doc.id), false);
});
