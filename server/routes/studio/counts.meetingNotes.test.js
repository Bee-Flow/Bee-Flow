/**
 * GET /api/studio/counts (routes/studio/counts.js): the meeting-notes COUNT on a real Postgres
 * (the store's visibility predicate). The module half of counts.test.js, owned by module
 * meetingNotes (scripts/module-map.json); the set-up is shared through counts.testkit.js.
 *
 * Run: node --test routes/studio/counts.meetingNotes.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { createCountsRouter } = require('./counts');
const { studioApp, studioServer } = require('./studioServer.testkit');
const { makeDeps, countFixture } = require('./counts.testkit');

const mount = (nextDeps) => studioApp(createCountsRouter(nextDeps));
const srv = studioServer(test);
const listen = srv.listen;
const get = (user = 'u1') => fetch(`${srv.baseUrl}/api/studio/counts`, { headers: user ? { 'x-test-user': user } : {} });
const { realDb, resetCountTables, transcription } = countFixture(test, ['transcriptions']);

test('the transcriptions COUNT uses the store\'s predicate', async () => {
    await resetCountTables();
    await transcription({ user_id: 'u1' });                                                     // own
    await transcription({ shared_with: ['u1'] });                                               // shared with me
    await transcription({ is_published: true, organization_id: 'orgA' });                     // published to my org, no groups
    await transcription({ is_published: true, organization_id: 'orgA', shared_groups: ['g1'] }); // my group
    await transcription({ is_published: true, organization_id: 'orgA', shared_groups: ['g2'] }); // another group
    await transcription({ is_published: false, organization_id: 'orgA' });                    // not published
    await transcription({ is_published: true, organization_id: 'orgB' });                     // another org
    await transcription({ shared_with: ['u2'] });                                               // shared with someone else
    const d = makeDeps({ db: realDb });
    await listen(mount(d));
    const body = await (await get()).json();
    assert.strictEqual(body.counts.meetingNotes, 4);
});

test('a super admin counts every transcription', async () => {
    await resetCountTables();
    for (const org of ['orgA', 'orgB', null]) await transcription({ organization_id: org });
    const d = makeDeps({
        transcriptionsShared: { resolveAccessContext: async () => ({ orgIds: [], userGroupIds: [], isSuperAdmin: true }) },
        db: realDb,
    });
    await listen(mount(d));
    const body = await (await get()).json();
    assert.strictEqual(body.counts.meetingNotes, 3);
});
