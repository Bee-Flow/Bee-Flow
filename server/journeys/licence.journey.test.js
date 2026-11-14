'use strict';

/**
 * Journey: a licence unlocks an Enterprise feature, and only a valid one does.
 *
 * Projects are an Enterprise feature (license/tiers.js). Without a licence the
 * organisation admin is refused with `feature_locked`; an expired licence and a
 * licence signed by a key the installation does not trust are refused at
 * activation and change nothing; a member who is not an admin cannot activate
 * one; the admin activates a valid Enterprise licence and the same request now
 * creates the project, for the admin and for the member alike.
 *
 * The licence is a real RS256 JWT, verified by license/verify.js against the
 * world's trusted key (journeyWorld.testkit.js activateLicence).
 *
 * Run: cd server && npm run test:journeys
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openWorld, ALL_FEATURES } = require('./journeyWorld.testkit');
const licenceJwt = require('../license/licenseJwt.testkit');

const ORG = 'org-licence';
const PW = 'Harbour-violet-1188!';

/** @type {Awaited<ReturnType<typeof openWorld>>} */
let world;

before(async () => {
    world = await openWorld({ mounts: ['auth', 'license', 'projects'] });
    // A Free plan that does not itself grant Projects (a plan's tier and its
    // allowed_features both extend the licence, license/middleware.js featureAllowedForRequest).
    await world.seedOrg({ id: ORG, name: 'Licence org', tier: null, features: ALL_FEATURES.filter((f) => f !== 'projects') });
    await world.seedUser({ id: 'lic-admin', password: PW, organizationId: ORG, orgRole: 'org_admin' });
    await world.seedUser({ id: 'lic-member', password: PW, organizationId: ORG, orgRole: 'member' });
}, { timeout: 120_000 });

after(() => world?.close());

test('no licence → locked; expired or foreign-signed licence → refused, still locked; valid licence → unlocked', { timeout: 60_000 }, async () => {
    const admin = await world.login('lic-admin', PW);
    const member = await world.login('lic-member', PW);
    const createProject = (/** @type {import('./journeyWorld.testkit').Actor} */ who, /** @type {string} */ name) => who.call('POST', '/api/projects', { body: { name } });

    const locked = await createProject(admin, 'Before the licence');
    assert.equal(locked.status, 403, locked.text);
    assert.match(locked.text, /feature_locked|locked/i);

    const expired = await world.activateLicence(admin, { orgId: ORG, expiresIn: -60 });
    assert.equal(expired.status, 400, expired.text);
    assert.ok(expired.body.code, `an expired licence is refused with a code: ${expired.text}`);
    assert.equal((await createProject(admin, 'With an expired licence')).status, 403);

    const now = Math.floor(Date.now() / 1000);
    const foreign = await admin.call('POST', '/api/license/activate', {
        body: { scope: 'organization', token: licenceJwt.signWithOtherKey(licenceJwt.claims({ sub: ORG, iat: now - 10, exp: now + 3600 })) },
    });
    assert.equal(foreign.status, 400, foreign.text);
    assert.equal((await createProject(admin, 'With a foreign licence')).status, 403);

    const byMember = await world.activateLicence(member, { orgId: ORG });
    assert.equal(byMember.status, 403, `a member activating an organisation licence: ${byMember.text}`);

    const valid = await world.activateLicence(admin, { orgId: ORG });
    assert.equal(valid.status, 200, valid.text);

    const status = await member.call('GET', '/api/license/status');
    assert.equal(status.status, 200, status.text);
    assert.equal(status.body.tier, 'enterprise', status.text);

    // A session keeps the tier it resolved for 30 s (license/middleware.js
    // RESOLUTION_CACHE_TTL_MS), and the admin's own refusals above put
    // "community" there; a fresh sign-in reads the licence at once, as the
    // member's session (never refused by the gate) does.
    const adminAgain = await world.login('lic-admin', PW);
    for (const [who, name] of [[adminAgain, 'Unlocked by the admin'], [member, 'Unlocked for the member']]) {
        const res = await createProject(/** @type {import('./journeyWorld.testkit').Actor} */ (who), /** @type {string} */ (name));
        assert.ok(res.status === 200 || res.status === 201, `${name}: ${res.status} ${res.text}`);
    }
});
