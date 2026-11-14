'use strict';

/**
 * Journey: a knowledge base is filled, searched and published to its
 * organisation, and stays closed to every other one.
 *
 * The organisation admin creates a base in the organisation, ingests a text
 * (chunked and stored by the real local KB pipeline on PGlite; the embedder is
 * the world's deterministic stub), and a search finds the passage; a colleague
 * cannot read or search the base until it is published, then can; a member of
 * another organisation is refused by id and by search, before and after, and
 * a search over "everything I can reach" never returns the passage to them.
 *
 * Run: cd server && npm run test:journeys
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openWorld } = require('./journeyWorld.testkit');

const PW = 'Saffron-kettle-5562!';
const TEXT = 'The warehouse in Rotterdam opens at seven in the morning. Deliveries arrive at the north dock and are signed for by the shift lead.';

/** @type {Awaited<ReturnType<typeof openWorld>>} */
let world;

before(async () => {
    world = await openWorld({ mounts: ['auth', 'kb'] });
    await world.seedOrg({ id: 'org-kb-a', name: 'Knowledge org A' });
    await world.seedOrg({ id: 'org-kb-b', name: 'Knowledge org B' });
    await world.seedUser({ id: 'kb-admin', password: PW, organizationId: 'org-kb-a', orgRole: 'org_admin' });
    await world.seedUser({ id: 'kb-colleague', password: PW, organizationId: 'org-kb-a', orgRole: 'member' });
    await world.seedUser({ id: 'kb-outsider', password: PW, organizationId: 'org-kb-b', orgRole: 'org_admin' });
}, { timeout: 120_000 });

after(() => world?.close());

/** @param {{ body: any }} res */
const passages = (res) => JSON.stringify(res.body?.chunks || res.body?.results || []);

test('create → ingest text → search finds it → publish → colleague reads; another organisation never does', { timeout: 60_000 }, async () => {
    const admin = await world.login('kb-admin', PW);
    const colleague = await world.login('kb-colleague', PW);
    const outsider = await world.login('kb-outsider', PW);

    const created = await admin.call('POST', '/api/kb', { body: { name: 'Operations handbook', organizationId: 'org-kb-a' } });
    assert.equal(created.status, 201, created.text);
    const id = created.body.id;

    const ingested = await admin.call('POST', `/api/kb/${id}/ingest/text`, { body: { content: TEXT, title: 'Warehouse hours' } });
    assert.equal(ingested.status, 201, ingested.text);
    assert.ok(ingested.body.chunks >= 1 || (Array.isArray(ingested.body.chunks) && ingested.body.chunks.length >= 1), ingested.text);

    const found = await admin.call('POST', '/api/kb/search', { body: { query: 'north dock deliveries', kb_ids: [id] } });
    assert.equal(found.status, 200, found.text);
    assert.match(passages(found), /north dock/, `the passage is found: ${found.text.slice(0, 400)}`);

    for (const [who, label] of [[colleague, 'a colleague before publishing'], [outsider, 'another organisation']]) {
        const a = /** @type {import('./journeyWorld.testkit').Actor} */ (who);
        const read = await a.call('GET', `/api/kb/${id}`);
        assert.ok(read.status === 403 || read.status === 404, `${label} reads the base: ${read.status} ${read.text.slice(0, 200)}`);
        const search = await a.call('POST', '/api/kb/search', { body: { query: 'north dock deliveries', kb_ids: [id] } });
        assert.equal(search.status, 403, `${label} searches the base: ${search.text.slice(0, 200)}`);
    }

    const published = await admin.call('PATCH', `/api/kb/${id}/publish`, { body: { isPublished: true } });
    assert.equal(published.status, 200, published.text);

    const read = await colleague.call('GET', `/api/kb/${id}`);
    assert.equal(read.status, 200, read.text);
    const search = await colleague.call('POST', '/api/kb/search', { body: { query: 'north dock deliveries', kb_ids: [id] } });
    assert.equal(search.status, 200, search.text);
    assert.match(passages(search), /north dock/);

    const foreignRead = await outsider.call('GET', `/api/kb/${id}`);
    assert.ok(foreignRead.status === 403 || foreignRead.status === 404, `another organisation after publishing: ${foreignRead.status}`);
    const everything = await outsider.call('POST', '/api/kb/search', { body: { query: 'north dock deliveries' } });
    assert.equal(everything.status, 200, everything.text);
    assert.doesNotMatch(passages(everything), /north dock/, 'a search over every base another organisation can reach does not return the passage');
});
