'use strict';

/**
 * A platform super admin who is a member of an organisation is in that organisation's audience,
 * like any member: an app or page published to the whole organisation by someone else is in
 * their gallery AND opens by id, and the two agree. What is published to another organisation,
 * or still a draft, stays out of both (auth/audience resolveAudienceContext memberOrgIds: membership, never a bypass).
 *
 * The gallery used to collapse resolveUserOrgIds' `null` (super admin) to `[]`, so the list
 * matched no organisation at all and showed a super admin only what they own.
 *
 * Real routers (testUtils/routeHarness.js) over the real stores on PGlite; only the session
 * comes from outside.
 * Run: cd server && node --test routes/studioApps/superAdminAudience.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'superadmin-audience-secret-0123456789abcdef';
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'superadmin-audience-master-key-0123456789abcdef01';

const { usePglitePool } = require('../../testUtils/pglitePool');
const { close: closePg } = usePglitePool();

const h = require('../../testUtils/routeHarness');

const ORG_A = 'org-sa-a';
const ORG_B = 'org-sa-b';
const AUTHOR_A = { id: 'u-sa-author-a', username: 'sa-author-a', email: 'author-a@sa.test', organizationId: ORG_A, role: 'user', orgRole: 'member', groups: [] };
const AUTHOR_B = { id: 'u-sa-author-b', username: 'sa-author-b', email: 'author-b@sa.test', organizationId: ORG_B, role: 'user', orgRole: 'member', groups: [] };
/** Platform super admin AND a plain member of org A. */
const SUPER = { id: 'u-sa-super', username: 'sa-super', email: 'super@sa.test', organizationId: ORG_A, role: 'admin', orgRole: 'member', groups: [] };

/** @type {{ orgWideA: string, orgWideB: string, draftA: string, pageA: string, pageB: string }} */
const ids = { orgWideA: '', orgWideB: '', draftA: '', pageA: '', pageB: '' };
/** @type {ReturnType<typeof h.serve>} */
let apps;
/** @type {ReturnType<typeof h.serve>} */
let pages;

before(async () => {
    const userStore = require('../../stores/userStore');
    await userStore.initDB();
    for (const [id, name] of [[ORG_A, 'Org A'], [ORG_B, 'Org B']]) {
        await userStore.createOrganization({ id, name }, { autoGrantTrial: false });
    }
    for (const u of [AUTHOR_A, AUTHOR_B, SUPER]) await userStore.createUser({ ...u, passwordHash: 'x' });

    const studioAppStore = require('../../stores/studioAppStore');
    const appIn = async (/** @type {typeof AUTHOR_A} */ author, /** @type {string} */ name, publish = true) => {
        const app = await studioAppStore.createStudioApp({ userId: author.id, organizationId: author.organizationId, name });
        if (publish) assert.ok(await studioAppStore.setStudioAppPublished(app.id, true, author.id, [], author.organizationId));
        return app.id;
    };
    ids.orgWideA = await appIn(AUTHOR_A, 'Org-wide app of A');
    ids.orgWideB = await appIn(AUTHOR_B, 'Org-wide app of B');
    ids.draftA = await appIn(AUTHOR_A, 'Draft of A', false);

    const webpageStore = require('../../stores/webpageStore');
    const pageIn = async (/** @type {typeof AUTHOR_A} */ author, /** @type {string} */ name) => {
        const wp = await webpageStore.createWebpage({ userId: author.id, name, description: '' });
        await webpageStore.setWebpagePublished(wp.id, true, author.id, [], author.organizationId);
        return wp.id;
    };
    ids.pageA = await pageIn(AUTHOR_A, 'Org-wide page of A');
    ids.pageB = await pageIn(AUTHOR_B, 'Org-wide page of B');

    apps = h.serve('/api/studio-apps', require('../studioApps'), { user: SUPER });
    pages = h.serve('/api/webpages', require('../webpages'), { user: SUPER });
});

after(async () => {
    await apps?.close();
    await pages?.close();
    await closePg();
});

test('the gallery shows a super admin what is published to their organisation, nothing of another', async () => {
    const res = await apps.call('GET', '/api/studio-apps');
    assert.equal(res.status, 200, res.text);
    const listed = res.body.apps.map((/** @type {{ id: string }} */ a) => a.id);
    assert.ok(listed.includes(ids.orgWideA), 'the org-wide app of their own organisation is listed');
    assert.ok(!listed.includes(ids.orgWideB), 'an app of another organisation is not');
    assert.ok(!listed.includes(ids.draftA), 'a draft of someone else is not');
});

test('the single read agrees with the gallery', async () => {
    const own = await apps.call('GET', `/api/studio-apps/${ids.orgWideA}`);
    assert.equal(own.status, 200, own.text);
    assert.equal(own.body.readOnly, true);
    assert.equal((await apps.call('GET', `/api/studio-apps/${ids.orgWideB}`)).status, 404);
    assert.equal((await apps.call('GET', `/api/studio-apps/${ids.draftA}`)).status, 404);
});

test('a plain member of the same organisation sees the same app (the rule is membership)', async () => {
    const res = await apps.call('GET', '/api/studio-apps', { user: AUTHOR_B });
    assert.equal(res.status, 200, res.text);
    const listed = res.body.apps.map((/** @type {{ id: string }} */ a) => a.id);
    assert.ok(listed.includes(ids.orgWideB) && !listed.includes(ids.orgWideA));
});

test('webpages: the same rule for the page list', async () => {
    const res = await pages.call('GET', '/api/webpages');
    assert.equal(res.status, 200, res.text);
    const list = Array.isArray(res.body) ? res.body : (res.body.webpages || res.body.items || []);
    const listed = list.map((/** @type {{ id: string }} */ p) => p.id);
    assert.ok(listed.includes(ids.pageA), 'the org-wide page of their own organisation is listed');
    assert.ok(!listed.includes(ids.pageB), 'a page of another organisation is not');
});
