// @typecheck
'use strict';
/**
 * The rows of a paused form journey, against a real Postgres (PGlite): the
 * journey's sessions are found from ANY leg, a session is extended but never
 * shortened and never revived, and the "next page is ready" notice is claimed
 * once per leg, with what it delivered settled on the ledger.
 * Run: cd server && node --test stores/automationStore/formJourneyStore.pg.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { pgliteDb } = require('../../testUtils/pgliteDb');
const { makeFormJourneyStore, FORM_PAGE_DUE_EVENT } = require('./formJourneyStore.mts');

const { pg, db } = pgliteDb();
let seq = 0;
const store = makeFormJourneyStore(db, { newId: () => `ane_${++seq}` });

before(async () => {
    await pg.exec(`
        CREATE TABLE automation_runs (id TEXT PRIMARY KEY, root_run_id TEXT);
        CREATE TABLE automation_form_sessions (
            id TEXT PRIMARY KEY, form_page_id TEXT, run_id TEXT, is_test BOOLEAN, expires_at TIMESTAMPTZ
        );
        CREATE TABLE automation_notification_events (
            id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, run_id TEXT, event TEXT NOT NULL,
            recipient_user_id TEXT NOT NULL, channel TEXT NOT NULL, urgency TEXT NOT NULL DEFAULT 'normal',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), delivered_at TIMESTAMPTZ NULL,
            bundled BOOLEAN NOT NULL DEFAULT FALSE, digest_sent_at TIMESTAMPTZ NULL
        );
    `);
});
after(async () => { await pg.close(); });
beforeEach(async () => {
    await pg.exec(`DELETE FROM automation_runs; DELETE FROM automation_form_sessions; DELETE FROM automation_notification_events;`);
    await pg.exec(`
        INSERT INTO automation_runs (id, root_run_id) VALUES ('root', 'root'), ('leg2', 'root'), ('other', 'other');
        INSERT INTO automation_form_sessions (id, form_page_id, run_id, is_test, expires_at) VALUES
            ('s1', 'tok1', 'root', FALSE, NOW() + INTERVAL '8 hours'),
            ('s2', 'tok2', 'other', TRUE, NOW() + INTERVAL '8 hours'),
            ('gone', 'tok1', 'leg2', FALSE, NOW() - INTERVAL '1 minute');
    `);
});

async function expiresAt(id) {
    const { rows } = await pg.query('SELECT expires_at FROM automation_form_sessions WHERE id = $1', [id]);
    return new Date(/** @type {any} */ (rows[0]).expires_at).getTime();
}

test('the sessions of a journey, from any of its legs, and no other journey\'s', async () => {
    const fromChild = await store.formSessionsOfJourney('leg2');
    assert.deepStrictEqual(fromChild.map((s) => s.id).sort(), ['gone', 's1']);
    const s1 = fromChild.find((s) => s.id === 's1');
    assert.strictEqual(s1?.formPageId, 'tok1');
    assert.strictEqual(s1?.isTest, false);
    assert.deepStrictEqual((await store.formSessionsOfJourney('other')).map((s) => [s.id, s.isTest]), [['s2', true]]);
    assert.deepStrictEqual(await store.formSessionsOfJourney(''), []);
});

test('extend: later wins, earlier never shortens, an expired session stays expired', async () => {
    const week = new Date(Date.now() + 7 * 24 * 3600_000);
    assert.strictEqual(await store.extendFormSessionUntil('s1', week), 1);
    assert.ok(Math.abs((await expiresAt('s1')) - week.getTime()) < 1000);
    await store.extendFormSessionUntil('s1', new Date(Date.now() + 3600_000));
    assert.ok(Math.abs((await expiresAt('s1')) - week.getTime()) < 1000, 'not shortened');
    assert.strictEqual(await store.extendFormSessionUntil('gone', week), 0);
    assert.ok((await expiresAt('gone')) < Date.now(), 'not revived');
});

test('the notice is claimed once per leg, and settles what it delivered', async () => {
    const claim = await store.claimFormPageNotice({ automationId: 'auto1', runId: 'leg2', recipient: 'visitor1' });
    assert.ok(claim);
    assert.strictEqual(await store.claimFormPageNotice({ automationId: 'auto1', runId: 'leg2', recipient: 'visitor1' }), null);
    await store.settleFormPageNotice(String(claim), { bell: true, email: false });
    const { rows } = await pg.query(`SELECT event, channel, recipient_user_id, delivered_at IS NOT NULL AS delivered FROM automation_notification_events ORDER BY channel`);
    assert.deepStrictEqual(rows.map((r) => ({ ...r })), [
        { event: FORM_PAGE_DUE_EVENT, channel: 'bell', recipient_user_id: 'visitor1', delivered: true },
        { event: FORM_PAGE_DUE_EVENT, channel: 'email', recipient_user_id: 'visitor1', delivered: false },
    ]);
    // Another leg is another notice.
    assert.ok(await store.claimFormPageNotice({ automationId: 'auto1', runId: 'leg3', recipient: 'visitor1' }));
});

test('no e-mail tried: no e-mail row', async () => {
    const claim = await store.claimFormPageNotice({ automationId: 'auto1', runId: 'leg2', recipient: 'visitor1' });
    await store.settleFormPageNotice(String(claim), { bell: false, email: null });
    const { rows } = await pg.query(`SELECT channel, delivered_at FROM automation_notification_events`);
    assert.deepStrictEqual(rows.map((r) => ({ ...r })), [{ channel: 'bell', delivered_at: null }]);
});
