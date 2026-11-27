/**
 * GET /api/studio/search (routes/studio/search.js): the meeting-notes kind on a real Postgres (its visibility predicate). The module half of
 * search.test.js, owned by module meetingNotes (scripts/module-map.json); the set-up is shared
 * through search.testkit.js.
 *
 * Run: node --test routes/studio/search.meetingNotes.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { createSearchRouter } = require('./search');
const { studioApp, studioServer } = require('./studioServer.testkit');
const { sqlFixture } = require('./search.testkit');

const mount = (nextDeps) => studioApp(createSearchRouter(nextDeps), { errors: true });
const srv = studioServer(test);
const listen = srv.listen;
const get = (q = 'invoice', user = 'u1') => fetch(
    `${srv.baseUrl}/api/studio/search?q=${encodeURIComponent(q)}`,
    { headers: user ? { 'x-test-user': user } : {} },
);
const { realDeps, resetTables, transcription, ids } = sqlFixture(test, ['transcriptions']);

test('the transcriptions visibility predicate is bracketed before the name filter is ANDed on', async () => {
    // The visibility clauses are ORed INSIDE brackets. Without them the
    // trailing AND binds to the last branch only and the first branches return
    // every row the caller may see, whatever its name.
    await resetTables();
    const own = await transcription('Invoice call', { user_id: 'u1' });
    await transcription('Weekly sync', { user_id: 'u1' });
    const shared = await transcription('Invoice review', { shared_with: ['u1'] });
    await transcription('Other review', { shared_with: ['u1'] });
    const org = await transcription('Invoice org', { is_published: true, organization_id: 'orgA', shared_groups: ['g1'] });
    await transcription('Invoice other group', { is_published: true, organization_id: 'orgA', shared_groups: ['g2'] });
    await transcription('Invoice other org', { is_published: true, organization_id: 'orgB' });
    const byFile = await transcription('', { user_id: 'u1', file_name: 'invoice-call.m4a' });
    await listen(mount(realDeps()));
    const body = await (await get('invoice')).json();
    assert.deepStrictEqual(ids(body.results.meetingNotes), ids([own, shared, org, byFile]));
});

test('a super admin searches every transcription by name', async () => {
    await resetTables();
    const a = await transcription('Invoice A', { organization_id: 'orgA' });
    const b = await transcription('Invoice B', { organization_id: 'orgZ' });
    await transcription('Unrelated');
    await listen(mount(realDeps({
        transcriptionsShared: { resolveAccessContext: async () => ({ orgIds: [], userGroupIds: [], isSuperAdmin: true }) },
    })));
    const body = await (await get('invoice')).json();
    assert.deepStrictEqual(ids(body.results.meetingNotes), ids([a, b]));
});
