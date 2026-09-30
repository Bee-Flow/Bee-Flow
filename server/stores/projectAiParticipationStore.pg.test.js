/**
 * project_ai_watch / project_ai_decisions / project_ai_feedback against a
 * real Postgres (@electric-sql/pglite, in-process), through
 * makeProjectAiParticipationStore: no module mocking.
 *
 * Proven:
 *   - the DDL runs twice (boot runs it on every start);
 *   - debouncing: a second message moves the pending watch's due time (and
 *     its trigger) instead of adding a row, never past the ceiling counted
 *     from the first message; postponing keeps the trigger;
 *   - claims: two workers claiming at once never get the same watch, a
 *     container another worker holds is not handed out, only served surfaces
 *     are claimed, only the claim that holds a watch can finish it, a stuck
 *     claim is reaped, and claims take turns under one advisory lock so a
 *     claim always sees the claims committed before it;
 *   - the gate reservation is unique per (container, last seq, trigger kind);
 *   - the caps: cooldown from the last answer of any kind, automatic answers
 *     per chat hour and project day, gates per chat hour and org day;
 *   - feedback is one row per person and answer and counts "not helpful";
 *   - no table has a column that could hold text, and code columns refuse
 *     anything that is not a code;
 *   - pruning, erasing a person, and the project cascade.
 *
 * Run: cd server && node --test stores/projectAiParticipationStore.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pgliteDb } = require('../testUtils/pgliteDb');
const { makeProjectAiParticipationStore, DDL, CLAIM_LOCK } = require('./projectAiParticipationStore');

const { pg, db } = pgliteDb();
let n = 0;
const store = makeProjectAiParticipationStore(db, { newId: () => `id-${++n}` });

before(async () => {
    await pg.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL)');
    await pg.exec(DDL);
    await pg.exec(DDL);
    for (const id of ['p1', 'p2', 'p3']) await pg.query('INSERT INTO projects (id, name, owner_id) VALUES ($1, $1, $2)', [id, 'olga']);
});
after(async () => { await pg.close(); });

const watch = (over = {}) => ({
    projectId: 'p1', surface: 'chat', containerId: 'c1', messageId: 'm1', authorUserId: 'ann',
    orgId: 'org1', limitOrgId: 'org1', kind: 'quiet', delaySeconds: 45, maxDelaySeconds: 180, ...over,
});
const dueOf = async (id) => new Date((await pg.query('SELECT due_at FROM project_ai_watch WHERE id = $1', [id])).rows[0].due_at).getTime();

test('a second message pushes the pending watch back instead of adding one, up to the ceiling', async () => {
    const first = await store.upsertWatch(watch({ containerId: 'deb' }));
    const firstDue = await dueOf(first.id);
    const second = await store.upsertWatch(watch({ containerId: 'deb', messageId: 'm2', authorUserId: 'bob', delaySeconds: 90 }));
    assert.strictEqual(second.id, first.id, 'the same pending row');
    assert.strictEqual(second.messageId, 'm2', 'the newest message is the trigger');
    assert.strictEqual(second.authorUserId, 'bob');
    assert.ok(await dueOf(first.id) > firstDue, 'due_at moved');
    const rows = await pg.query(`SELECT COUNT(*)::int AS n FROM project_ai_watch WHERE container_id = 'deb'`);
    assert.strictEqual(rows.rows[0].n, 1);

    // The chat that never goes quiet: first seen long ago, so the ceiling wins.
    await pg.query(`UPDATE project_ai_watch SET first_seen_at = NOW() - INTERVAL '170 seconds' WHERE id = $1`, [first.id]);
    await store.upsertWatch(watch({ containerId: 'deb', messageId: 'm3', delaySeconds: 45 }));
    const capped = await dueOf(first.id);
    assert.ok(capped <= Date.now() + 15_000, 'never later than first_seen_at + maxDelaySeconds');

    // A message that did not pass the rules still postpones, but keeps the trigger.
    await pg.query(`UPDATE project_ai_watch SET first_seen_at = NOW(), due_at = NOW() WHERE id = $1`, [first.id]);
    assert.strictEqual(await store.postponeWatch({ surface: 'chat', containerId: 'deb', delaySeconds: 45, maxDelaySeconds: 180 }), true);
    const pending = await store.getPendingWatch('chat', 'deb', 'quiet');
    assert.strictEqual(pending.messageId, 'm3');
    assert.ok(await dueOf(first.id) > Date.now() + 30_000);
    assert.strictEqual(await store.postponeWatch({ surface: 'chat', containerId: 'none', delaySeconds: 45 }), false);
    assert.strictEqual(await store.cancelPending('chat', 'deb'), 1);
    assert.strictEqual(await store.getPendingWatch('chat', 'deb', 'quiet'), null);
});

test('two workers claiming at once never share a watch, and one container is one worker at a time', async () => {
    for (let i = 0; i < 6; i++) await store.upsertWatch(watch({ containerId: `race-${i}`, delaySeconds: 0 }));
    // Two kinds due for one container at once: only one of them is handed out.
    await store.upsertWatch(watch({ containerId: 'race-0', kind: 'unanswered', delaySeconds: 0 }));
    const [a, b] = await Promise.all([
        store.claimDue(4, { claimId: 'worker-a' }),
        store.claimDue(4, { claimId: 'worker-b' }),
    ]);
    const ids = [...a, ...b].map((w) => w.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'no watch claimed twice');
    const containers = [...a, ...b].map((w) => w.containerId);
    assert.strictEqual(new Set(containers).size, containers.length, 'no container claimed twice');
    assert.strictEqual(containers.filter((c) => c.startsWith('race-')).length, 6);

    // The unanswered watch of race-0 waits while race-0 is being handled.
    assert.deepStrictEqual((await store.claimDue(10, { claimId: 'worker-c' })).map((w) => w.containerId), []);
    const holder = [...a, ...b].find((w) => w.containerId === 'race-0');
    assert.strictEqual(await store.finishWatch(holder.id, 'somebody-else'), false, 'only the holding claim finishes it');
    assert.strictEqual(await store.finishWatch(holder.id, holder.claimId), true);
    const next = await store.claimDue(10, { claimId: 'worker-c' });
    assert.deepStrictEqual(next.map((w) => [w.containerId, w.kind]), [['race-0', 'unanswered']]);
    for (const w of [...a, ...b, ...next]) await store.finishWatch(w.id, w.claimId);
});

test('claims take turns across replicas: the claim runs in a transaction, after the one advisory lock', async () => {
    // Real replicas cannot race on PGlite (one connection), so this pins the
    // mechanism instead: without the lock, a claim statement cannot see a claim
    // another replica has not committed yet, and two watches of one container
    // (quiet + unanswered) could go to two workers.
    const seen = [];
    const recording = {
        query: (sql, params) => { seen.push({ inTx: false, sql }); return db.query(sql, params); },
        tx: (fn) => db.tx((q) => fn({ query: (sql, params) => { seen.push({ inTx: true, sql, params }); return q.query(sql, params); } })),
    };
    const turns = makeProjectAiParticipationStore(recording, { newId: () => `turn-${++n}` });
    await store.upsertWatch(watch({ containerId: 'turns', delaySeconds: 0 }));
    await store.upsertWatch(watch({ containerId: 'turns', kind: 'unanswered', delaySeconds: 0 }));

    const claimed = await turns.claimDue(5, { claimId: 'worker-t' });
    assert.deepStrictEqual(claimed.map((w) => w.containerId), ['turns'], 'one watch of the container');
    const lock = seen.findIndex((q) => q.inTx && /pg_advisory_xact_lock\(hashtext\(\$1\)\)/.test(q.sql));
    const claim = seen.findIndex((q) => /SET state = 'claimed'/.test(q.sql));
    assert.ok(lock >= 0 && seen[lock].params[0] === CLAIM_LOCK, 'the claim lock is taken');
    assert.ok(claim > lock && seen[claim].inTx, 'the claim statement runs after it, in the same transaction');
    assert.ok(seen.filter((q) => /state = 'pending', claim_id = NULL/.test(q.sql)).every((q) => q.inTx), 'a second kind goes back inside that turn');
    assert.ok(!seen.some((q) => !q.inTx && /project_ai_watch/.test(q.sql)), 'nothing of the claim outside the turn');
    await store.cancelPending('chat', 'turns');
    for (const w of claimed) await store.finishWatch(w.id, w.claimId);
});

test('only served surfaces are claimed, a future watch is not due, and a stuck claim is reaped', async () => {
    await store.upsertWatch(watch({ surface: 'comment', containerId: 'thread-1', delaySeconds: 0 }));
    await store.upsertWatch(watch({ containerId: 'later', delaySeconds: 600 }));
    assert.deepStrictEqual(await store.claimDue(10, { surfaces: ['chat'] }), []);
    const claimed = await store.claimDue(10, { surfaces: ['comment'], claimId: 'w' });
    assert.deepStrictEqual(claimed.map((w) => w.containerId), ['thread-1']);
    await pg.query(`UPDATE project_ai_watch SET claimed_at = NOW() - INTERVAL '10 minutes' WHERE id = $1`, [claimed[0].id]);
    assert.strictEqual(await store.reapStuck(5), 1);
    const state = (await pg.query('SELECT state FROM project_ai_watch WHERE id = $1', [claimed[0].id])).rows[0].state;
    assert.strictEqual(state, 'cancelled', 'a stuck claim is dropped, never retried on an old conversation');
    await store.cancelPending('chat', 'later');
});

test('one gate per (container, last seq, trigger kind)', async () => {
    const d = { projectId: 'p1', orgId: 'org1', surface: 'chat', containerId: 'gate-1', triggerMessageId: 'm9', triggerKind: 'quiet', lastSeq: 9 };
    const first = await store.reserveGate(d);
    assert.ok(first && first.decision === 'pending' && first.gateCalled);
    assert.strictEqual(await store.reserveGate(d), null, 'the same state is not gated twice');
    assert.ok(await store.reserveGate({ ...d, triggerKind: 'unanswered' }), 'another trigger kind is another question');
    assert.ok(await store.reserveGate({ ...d, lastSeq: 10 }), 'a newer conversation is another question');
    const done = await store.completeDecision(first.id, { decision: 'silent', reasonCode: 'social_chatter', confidence: 0.9, model: 'fast-1' });
    assert.strictEqual(done.decision, 'silent');
    assert.strictEqual(done.reasonCode, 'social_chatter');
    assert.ok(done.decidedAt);
    await assert.rejects(() => store.completeDecision(first.id, { decision: 'pending' }), /unknown decision/);
});

test('the caps come from the decision log', async () => {
    const base = { projectId: 'p2', orgId: 'org2', surface: 'chat', containerId: 'caps-1', triggerMessageId: 'm1' };
    let caps = await store.capsFor({ surface: 'chat', containerId: 'caps-1', projectId: 'p2', orgId: 'org2' });
    assert.deepStrictEqual(caps, { lastReplyAt: null, autoInChatHour: 0, autoInProjectDay: 0, gatesInChatHour: 0, gatesInOrgDay: 0 });

    const g1 = await store.reserveGate({ ...base, triggerKind: 'quiet', lastSeq: 1 });
    await store.completeDecision(g1.id, { decision: 'replied', replyMessageId: 'a1' });
    const g2 = await store.reserveGate({ ...base, triggerKind: 'quiet', lastSeq: 2 });
    await store.completeDecision(g2.id, { decision: 'silent' });
    await store.reserveGate({ ...base, containerId: 'caps-2', triggerKind: 'quiet', lastSeq: 1 }); // in flight
    await store.recordDecision({ ...base, triggerKind: 'explicit', decision: 'replied', replyMessageId: 'a2' });
    await store.recordDecision({ ...base, triggerKind: 'quiet', decision: 'skipped', skipReason: 'acknowledgement' });

    caps = await store.capsFor({ surface: 'chat', containerId: 'caps-1', projectId: 'p2', orgId: 'org2' });
    assert.ok(caps.lastReplyAt, 'the explicit answer counts for the cooldown');
    assert.strictEqual(caps.autoInChatHour, 1, 'only automatic answers count against the automatic cap');
    assert.strictEqual(caps.autoInProjectDay, 2, 'plus the gate still in flight in the other chat');
    assert.strictEqual(caps.gatesInChatHour, 2);
    assert.strictEqual(caps.gatesInOrgDay, 3);

    // Older than the windows: out of the counts.
    await pg.query(`UPDATE project_ai_decisions SET created_at = NOW() - INTERVAL '2 hours' WHERE container_id = 'caps-1'`);
    caps = await store.capsFor({ surface: 'chat', containerId: 'caps-1', projectId: 'p2', orgId: 'org2' });
    assert.strictEqual(caps.autoInChatHour, 0);
    assert.strictEqual(caps.gatesInChatHour, 0);
    assert.strictEqual(caps.autoInProjectDay, 2);
    assert.strictEqual(caps.gatesInOrgDay, 3);
    assert.strictEqual((await store.capsFor({ surface: 'chat', containerId: 'x', projectId: 'p2', orgId: null })).gatesInOrgDay, 0);
    const summary = await store.summarizeProject('p2');
    assert.ok(summary.some((r) => r.decision === 'replied' && r.triggerKind === 'explicit' && r.count === 1));
});

test('feedback: one row per person and answer, "not helpful" counted per container', async () => {
    const f = { projectId: 'p1', surface: 'chat', containerId: 'fb-1', helpful: false };
    assert.deepStrictEqual(await store.recordFeedback({ ...f, messageId: 'a1', userId: 'ann' }), { created: true, notHelpfulRecently: 1 });
    assert.deepStrictEqual(await store.recordFeedback({ ...f, messageId: 'a1', userId: 'ann' }), { created: false, notHelpfulRecently: 1 });
    assert.deepStrictEqual(await store.recordFeedback({ ...f, messageId: 'a2', userId: 'bob' }), { created: true, notHelpfulRecently: 2 });
    assert.strictEqual((await store.recordFeedback({ ...f, messageId: 'a3', userId: 'bob', helpful: true })).notHelpfulRecently, 2);
    const mine = await store.feedbackFor('bob', ['a1', 'a2', 'a3', 'zzz']);
    assert.deepStrictEqual([...mine.entries()].sort(), [['a2', false], ['a3', true]]);
    assert.strictEqual((await store.feedbackFor('bob', [])).size, 0);
    await pg.query(`UPDATE project_ai_feedback SET created_at = NOW() - INTERVAL '25 hours' WHERE container_id = 'fb-1'`);
    assert.strictEqual((await store.recordFeedback({ ...f, messageId: 'a4', userId: 'cy' })).notHelpfulRecently, 1, 'the window is 24 hours');
});

test('no column can hold text, and code columns only take codes', async () => {
    const cols = await pg.query(`SELECT table_name, column_name FROM information_schema.columns
                                  WHERE table_name IN ('project_ai_watch', 'project_ai_decisions', 'project_ai_feedback')`);
    const names = cols.rows.map((r) => r.column_name);
    for (const forbidden of ['content', 'text', 'reason', 'title', 'body', 'excerpt']) {
        assert.ok(!names.includes(forbidden), `no ${forbidden} column`);
    }
    const row = await store.recordDecision({
        projectId: 'p1', surface: 'chat', containerId: 'codes', triggerKind: 'quiet', decision: 'skipped',
        skipReason: 'Call me on 0612345678', reasonCode: 'direct_request',
    });
    assert.strictEqual(row.skipReason, null, 'free text is not a code and is not stored');
    assert.strictEqual(row.reasonCode, 'direct_request');
    await assert.rejects(() => store.recordDecision({ projectId: 'p1', surface: 'chat', containerId: 'x', triggerKind: 'whenever', decision: 'replied' }));
});

test('prune, erase a person, and the project cascade', async () => {
    await store.upsertWatch(watch({ projectId: 'p3', containerId: 'gone', authorUserId: 'zed' }));
    await store.recordFeedback({ messageId: 'z1', userId: 'zed', projectId: 'p3', surface: 'chat', containerId: 'gone', helpful: false });
    assert.deepStrictEqual(await store.eraseUser('zed'), { feedback: 1, watches: 1 });

    const old = await store.recordDecision({ projectId: 'p3', surface: 'chat', containerId: 'gone', triggerKind: 'quiet', decision: 'silent' });
    await pg.query(`UPDATE project_ai_decisions SET created_at = NOW() - INTERVAL '91 days' WHERE id = $1`, [old.id]);
    const pruned = await store.prune();
    assert.ok(pruned.decisions >= 1);
    assert.strictEqual((await pg.query('SELECT 1 FROM project_ai_decisions WHERE id = $1', [old.id])).rows.length, 0);

    await store.recordDecision({ projectId: 'p3', surface: 'chat', containerId: 'gone', triggerKind: 'quiet', decision: 'silent' });
    await store.upsertWatch(watch({ projectId: 'p3', containerId: 'gone' }));
    await pg.query(`DELETE FROM projects WHERE id = 'p3'`);
    for (const table of ['project_ai_watch', 'project_ai_decisions', 'project_ai_feedback']) {
        const left = await pg.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE project_id = 'p3'`);
        assert.strictEqual(left.rows[0].n, 0, `${table} follows its project`);
    }
});
