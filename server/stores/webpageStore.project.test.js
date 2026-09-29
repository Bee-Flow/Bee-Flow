/**
 * Webpages inside a Solution.
 *
 * A webpage joins a project the same way an app does — a nullable, soft
 * `project_id` — and the read predicate widens to match. The rules under test:
 *
 *   1. PROJECT ACCESS IS ADDITIVE, NEVER A DOWNGRADE. A standalone page
 *      (project_id NULL) stays exactly as private as it was.
 *   2. IT IS A READ WIDENING ONLY. Filing a page into a project does not make
 *      project members its authors, which is why the write paths never call
 *      this and canWriteWebpage is untouched.
 *   3. THE SYNC PREDICATE IS UNCHANGED. canReadWebpageAsync consults the
 *      project only AFTER canReadWebpage has already said no, so every
 *      existing caller keeps its behaviour to the letter.
 *
 * Run: cd server && node --test stores/webpageStore.project.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

// Stub the project role lookup before the store can reach the real one. The
// require inside canReadWebpageAsync is lazy, so seeding the cache is enough.
const projectAccessPath = require.resolve('../auth/projectAccess');
const roles = {};                       // `${userId}:${projectId}` -> role
require.cache[projectAccessPath] = {
    id: projectAccessPath, filename: projectAccessPath, loaded: true,
    exports: { getProjectRole: async (userId, projectId) => roles[`${userId}:${projectId}`] || null },
};

const { canReadWebpage, canReadWebpageAsync } = require('./webpageStore');

const OWNED = { id: 'wp1', userId: 'alice', isPublished: false, organizationId: null, sharedGroups: [], projectId: null };
const IN_PROJECT = { ...OWNED, projectId: 'p1' };
const PUBLISHED = { ...OWNED, isPublished: true, organizationId: 'org1' };

test('the owner reads their own page, project or not', async () => {
    assert.strictEqual(await canReadWebpageAsync(OWNED, 'alice'), true);
    assert.strictEqual(await canReadWebpageAsync(IN_PROJECT, 'alice'), true);
});

test('a standalone page stays strictly private to its owner', async () => {
    // The additive rule's floor: no project, no widening, whoever is asking.
    roles['bob:p1'] = 'editor';
    assert.strictEqual(await canReadWebpageAsync(OWNED, 'bob'), false);
    delete roles['bob:p1'];
});

test('a project member reads a page filed into that project', async () => {
    roles['bob:p1'] = 'viewer';
    assert.strictEqual(canReadWebpage(IN_PROJECT, 'bob'), false, 'the sync predicate still says no');
    assert.strictEqual(await canReadWebpageAsync(IN_PROJECT, 'bob'), true, 'the project is what widens it');
    delete roles['bob:p1'];
});

test('a non-member reads nothing, even though the page is in a project', async () => {
    assert.strictEqual(await canReadWebpageAsync(IN_PROJECT, 'mallory'), false);
});

test('an anonymous caller is never widened by a project', async () => {
    assert.strictEqual(await canReadWebpageAsync(IN_PROJECT, null), false);
    assert.strictEqual(await canReadWebpageAsync(IN_PROJECT, undefined), false);
});

test('org publishing keeps working untouched', async () => {
    assert.strictEqual(await canReadWebpageAsync(PUBLISHED, 'bob', [], ['org1']), true);
    assert.strictEqual(await canReadWebpageAsync(PUBLISHED, 'bob', [], ['org2']), false);
});

test('the async predicate agrees with the sync one wherever the sync one says yes', async () => {
    const cases = [
        [OWNED, 'alice', [], []],
        [PUBLISHED, 'bob', [], ['org1']],
        [PUBLISHED, 'bob', [], ['org2']],
        [{ ...PUBLISHED, sharedGroups: ['g1'] }, 'bob', ['g1'], ['org1']],
        [{ ...PUBLISHED, sharedGroups: ['g1'] }, 'bob', ['g2'], ['org1']],
    ];
    for (const [wp, uid, groups, orgs] of cases) {
        if (canReadWebpage(wp, uid, groups, orgs)) {
            assert.strictEqual(await canReadWebpageAsync(wp, uid, groups, orgs), true,
                'the widening never turns an existing yes into a no');
        }
    }
});

test('a missing webpage is unreadable by anyone', async () => {
    assert.strictEqual(await canReadWebpageAsync(null, 'alice'), false);
    assert.strictEqual(await canReadWebpageAsync(undefined, 'alice'), false);
});
