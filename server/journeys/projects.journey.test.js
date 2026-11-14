'use strict';

/**
 * Journey: a project is shared inside the organisation and nowhere else.
 *
 * Both organisations' plans grant Projects (journeys/licence.journey.test.js
 * is the journey of an organisation whose plan does not).
 * The owner creates a project; a colleague cannot open it until it is shared
 * with them; the owner shares it as viewer; the colleague reads it and lists
 * its members, but cannot rename it; sharing it with somebody of another
 * organisation is refused, and that person still gets a 403/404.
 *
 * Run: cd server && npm run test:journeys
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openWorld } = require('./journeyWorld.testkit');

const PW = 'Willow-ferry-6612!';

/** @type {Awaited<ReturnType<typeof openWorld>>} */
let world;

before(async () => {
    world = await openWorld({ mounts: ['auth', 'projects'] });
    await world.seedOrg({ id: 'org-proj-a', name: 'Projects org A' });
    await world.seedOrg({ id: 'org-proj-b', name: 'Projects org B' });
    await world.seedUser({ id: 'proj-owner', password: PW, organizationId: 'org-proj-a', orgRole: 'member' });
    await world.seedUser({ id: 'proj-colleague', password: PW, organizationId: 'org-proj-a', orgRole: 'member' });
    await world.seedUser({ id: 'proj-outsider', password: PW, organizationId: 'org-proj-b', orgRole: 'member' });
}, { timeout: 120_000 });

after(() => world?.close());

test('create → share with a colleague → the colleague reads, cannot edit; an outsider is refused throughout', { timeout: 60_000 }, async () => {
    const owner = await world.login('proj-owner', PW);
    const colleague = await world.login('proj-colleague', PW);
    const outsider = await world.login('proj-outsider', PW);

    const created = await owner.call('POST', '/api/projects', { body: { name: 'Launch plan', description: 'What ships when' } });
    assert.ok(created.status === 200 || created.status === 201, created.text);
    const id = created.body.id || created.body.project?.id;
    assert.ok(id, created.text);

    const before = await colleague.call('GET', `/api/projects/${id}`);
    assert.ok(before.status === 403 || before.status === 404, `not shared yet: ${before.status} ${before.text.slice(0, 200)}`);

    const foreign = await owner.call('POST', `/api/projects/${id}/share`, { body: { sharedWithType: 'user', sharedWithId: 'proj-outsider', permission: 'viewer' } });
    assert.equal(foreign.status, 400, `sharing across organisations: ${foreign.text}`);

    const shared = await owner.call('POST', `/api/projects/${id}/share`, { body: { sharedWithType: 'user', sharedWithId: 'proj-colleague', permission: 'viewer' } });
    assert.equal(shared.status, 200, shared.text);

    const read = await colleague.call('GET', `/api/projects/${id}`);
    assert.equal(read.status, 200, read.text);
    assert.equal((read.body.project || read.body).name, 'Launch plan');

    const members = await colleague.call('GET', `/api/projects/${id}/members`);
    assert.equal(members.status, 200, members.text);
    assert.ok(JSON.stringify(members.body).includes('proj-colleague'), members.text);

    const listed = await colleague.call('GET', '/api/projects');
    assert.equal(listed.status, 200, listed.text);
    assert.ok(JSON.stringify(listed.body).includes(id), 'the shared project is in the colleague\'s list');

    const rename = await colleague.call('PUT', `/api/projects/${id}`, { body: { name: 'Renamed by a viewer' } });
    assert.equal(rename.status, 403, `a viewer renaming: ${rename.text}`);

    for (const url of [`/api/projects/${id}`, `/api/projects/${id}/members`]) {
        const res = await outsider.call('GET', url);
        assert.ok(res.status === 403 || res.status === 404, `${url} as another organisation: ${res.status} ${res.text.slice(0, 200)}`);
    }
    // Org B holds no licence, so its list may be locked; open or locked, it never names A's project.
    const outsiderList = await outsider.call('GET', '/api/projects');
    assert.ok(outsiderList.status === 200 || outsiderList.status === 403, outsiderList.text);
    assert.ok(!outsiderList.text.includes(id), 'the project is not in another organisation\'s list');
});
