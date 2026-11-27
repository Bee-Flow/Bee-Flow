'use strict';

/**
 * The organisation an admin page works on, for the Learning Center routers of
 * the module "learning": requirePrimaryOrgAdmin (auth/permissionsOrgGates.js)
 * on /ai/learning/training-rules and /ai/learning/admin. The world and the
 * three callers are auth/permissionsOrgGates.orgChoice.testkit.js; the core
 * routers are in auth/permissionsOrgGates.orgChoice.test.js.
 *
 * Run: cd server && node --test auth/permissionsOrgGates.orgChoice.learning.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { h, ORG_B, PLATFORM, ADMIN_A, ADMIN_B, seedOrganisations, closeAll, threeCallers } = require('./permissionsOrgGates.orgChoice.testkit');

/** @type {Record<string, ReturnType<typeof h.serve>>} */
const api = {};

before(async () => {
    await seedOrganisations();
    api.learning = h.serve('/ai/learning', require('../routes/ai/learning'));
    api.learningAdmin = h.serve('/ai/learning/admin', require('../routes/ai/learningAdmin'));
}, { timeout: 120_000 });

after(() => closeAll(api));

test('required training: a platform admin sets org B\'s rules', async () => {
    const body = { areas: { agents: 'course-build-agent' } };
    const { platform, own } = await threeCallers(api.learning, 'PUT', '/ai/learning/training-rules', { areas: {} });
    assert.equal(platform.status, 200, platform.text);
    assert.equal(own.status, 200, own.text);
    assert.equal((await api.learning.call('PUT', `/ai/learning/training-rules?orgId=${ORG_B}`, { user: PLATFORM, body })).status, 200);
    const seenByB = await api.learning.call('GET', '/ai/learning/training-rules', { user: ADMIN_B });
    assert.equal(seenByB.body.areas.agents, 'course-build-agent');
    const seenByA = await api.learning.call('GET', '/ai/learning/training-rules', { user: ADMIN_A });
    assert.equal(seenByA.body.areas.agents, undefined);
    assert.equal((await threeCallers(api.learning, 'GET', '/ai/learning/org-overview')).platform.status, 200);
});

test('Academy courses: a platform admin lists the drafts of org B', async () => {
    const store = require('../stores/learningContentStore');
    const { doc } = store.validateCourseDoc({ title: 'Course of org B' });
    await store.saveCourse(ORG_B, doc);
    const { platform, own } = await threeCallers(api.learningAdmin, 'GET', '/ai/learning/admin/courses');
    assert.equal(platform.status, 200, platform.text);
    assert.deepEqual(platform.body.courses.map((c) => c.title), ['Course of org B']);
    assert.deepEqual(own.body.courses, []);
});
