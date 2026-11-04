/**
 * A meeting that finishes WHILE its meeting_tag source is refreshing must
 * still reach the knowledge base soon, not at the next daily pass.
 *
 * The running pass enumerated the tagged meetings before this one was saved,
 * so it cannot include it. armMeetingSources therefore arms a refreshing row
 * too, and finish() keeps that earlier due time instead of writing the next
 * scheduled one (now + 24h for an after_meeting source without a cron).
 * Real store SQL on PGlite, through the real db.js.
 *
 * Run: cd server && node --test stores/kbSources.meetingArm.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { usePglitePool } = require('../testUtils/pglitePool');
const { close } = usePglitePool();

process.env.NODE_ENV = 'test';

const kbStore = require('./knowledgeBases');
const sourcesStore = require('./kbSources');

const DAY_MS = 24 * 60 * 60 * 1000;

before(async () => {
    await kbStore.whenReady();
    await sourcesStore.initDB();
});
after(close);

async function meetingSource(tag) {
    const tenant = `tu_${crypto.randomBytes(4).toString('hex')}`;
    const kb = await kbStore.createKB(tenant, `meetings-${tenant}`, 'meeting arm test');
    return sourcesStore.create({ knowledgeBaseId: kb.id, kind: 'meeting_tag', config: { tag }, refreshMode: 'after_meeting' });
}

async function claim(id) {
    const claimed = await sourcesStore.claimDue(500);
    return claimed.find(r => r.id === id) || null;
}

test('a meeting processed during a running pass keeps the source due after that pass', async () => {
    const tag = `sales-${crypto.randomBytes(3).toString('hex')}`;
    const src = await meetingSource(tag);

    assert.equal(await sourcesStore.armMeetingSources([tag]), 1, 'meeting 1 arms the idle source');
    assert.ok(await claim(src.id), 'the tick claims it');

    // Meeting 2 finishes while the pass is embedding: its enumerate already ran.
    assert.equal(await sourcesStore.armMeetingSources([tag]), 1, 'a refreshing source is armed too');
    assert.equal(await claim(src.id), null, 'the arm never claims the running pass a second time');

    const done = await sourcesStore.finish(src.id, { ok: true, nextRefreshAt: new Date(Date.now() + DAY_MS) });
    assert.equal(done.status, 'idle');
    assert.ok(new Date(done.nextRefreshAt).getTime() <= Date.now(), 'the pass does not push the arm out to tomorrow');
    assert.ok(await claim(src.id), 'the next tick runs a pass that sees meeting 2');
});

test('a pass with no arm during it is scheduled as usual', async () => {
    const tag = `ops-${crypto.randomBytes(3).toString('hex')}`;
    const src = await meetingSource(tag);
    await sourcesStore.armMeetingSources([tag]);
    assert.ok(await claim(src.id));

    const next = new Date(Date.now() + DAY_MS);
    const done = await sourcesStore.finish(src.id, { ok: true, nextRefreshAt: next });
    assert.equal(new Date(done.nextRefreshAt).getTime(), next.getTime(), 'an arm before the claim was served by this pass');
});

test('a failed pass keeps its backoff even when a meeting arrived during it', async () => {
    const tag = `hr-${crypto.randomBytes(3).toString('hex')}`;
    const src = await meetingSource(tag);
    await sourcesStore.armMeetingSources([tag]);
    assert.ok(await claim(src.id));
    await sourcesStore.armMeetingSources([tag]);

    const backoff = new Date(Date.now() + 30 * 60 * 1000);
    const failed = await sourcesStore.finish(src.id, { ok: false, error: 'host down', nextRefreshAt: backoff });
    assert.equal(failed.status, 'error');
    assert.equal(new Date(failed.nextRefreshAt).getTime(), backoff.getTime());
});

test('a removal arms a meeting_tag source in every refresh mode; a new meeting only after_meeting', async () => {
    const tag = `legal-${crypto.randomBytes(3).toString('hex')}`;
    const tenant = `tu_${crypto.randomBytes(4).toString('hex')}`;
    const kb = await kbStore.createKB(tenant, `meetings-${tenant}`, 'meeting removal arm test');
    const manual = await sourcesStore.create({ knowledgeBaseId: kb.id, kind: 'meeting_tag', config: { tag }, refreshMode: 'manual' });
    const auto = await sourcesStore.create({ knowledgeBaseId: kb.id, kind: 'meeting_tag', config: { tag }, refreshMode: 'after_meeting' });
    assert.ok(manual && auto);

    assert.equal(await sourcesStore.armMeetingSources([tag]), 1, 'a new meeting respects manual');
    assert.equal(await sourcesStore.armMeetingSourcesForRemoval([tag]), 2, 'a removal reaches the manual source too');
    assert.equal(await sourcesStore.armMeetingSourcesForRemoval(['', '  ']), 0);
    assert.equal(await sourcesStore.armMeetingSourcesForRemoval(null), 0);
});
