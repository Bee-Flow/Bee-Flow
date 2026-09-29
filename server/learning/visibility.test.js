/**
 * Unit tests — server-side lesson visibility resolution.
 *
 * visibility.js is the impure edge of the completion pipeline: it asks the
 * permission system + entitlements resolver for the session user and hands a
 * pure { [courseId]: lessonIds[] } map to completion.js. We stub
 * ../auth/permissions and ../core/entitlements via Module._load (same
 * technique as core/betaFeatures.test.js) and pin the gate semantics
 * ('all' wildcard, ANY-of permission arrays, permission AND feature) plus the
 * fail-closed degraded paths (visibleByCourse: undefined → completion.js
 * requires ALL lessons; an outage can never mint certificates).
 *
 * Run: node --test server/learning/visibility.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

// ── Mock injection ──────────────────────────────────────────────────────
// visibility.js requires '../auth/permissions' and '../core/entitlements/entitlements';
// resolve those relative to learning/ (this dir) and swap them BEFORE the
// module under test is required. courseCatalog runs for real.
const permissionsPath = path.resolve(__dirname, '..', 'auth', 'permissions');
const entitlementsPath = path.resolve(__dirname, '..', 'core', 'entitlements', 'entitlements');

let mockPerms = [];
let mockPermsThrow = false;
let mockPermDegraded = false;
let mockCapDegraded = false;
let mockFeatures = new Set();

const permissionsStub = {
    async getUserPermissions(_userId, _session) {
        if (mockPermsThrow) throw new Error('simulated permission lookup failure');
        return mockPerms;
    },
    isPermissionLookupDegraded() { return mockPermDegraded; },
};
const entitlementsStub = {
    async resolveCapabilitySet(_ctx) {
        return { degraded: mockCapDegraded, has: (capId) => mockFeatures.has(capId) };
    },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    try {
        const resolved = Module._resolveFilename(request, parent, isMain);
        if (resolved === permissionsPath + '.js' || resolved === permissionsPath + '/index.js') return permissionsStub;
        if (resolved === entitlementsPath + '.js' || resolved === entitlementsPath + '/index.js') return entitlementsStub;
    } catch (_) { /* ignore resolution errors, fall through */ }
    return originalLoad(request, parent, isMain);
};

const { resolveVisibleByCourse } = require('./visibility');
const { COURSES, LESSON_GATES } = require('./courseCatalog');

function resetMocks() {
    mockPerms = [];
    mockPermsThrow = false;
    mockPermDegraded = false;
    mockCapDegraded = false;
    mockFeatures = new Set();
}

const resolve = () => resolveVisibleByCourse({ userId: 'u1', orgId: 'org1' });

// ── Happy paths ─────────────────────────────────────────────────────────

test("perms ['all'] + every feature → every course fully visible", async () => {
    resetMocks();
    mockPerms = ['all'];
    // Every feature any gate names — derived, so a new gate can never make this
    // "unrestricted user" quietly restricted again.
    mockFeatures = new Set(Object.values(LESSON_GATES).flatMap((g) => (Array.isArray(g.feature) ? g.feature : [g.feature])).filter(Boolean));
    const { visibleByCourse, degraded } = await resolve();
    assert.equal(degraded, false);
    for (const course of COURSES) {
        assert.deepEqual(visibleByCourse[course.id], course.lessonIds,
            `${course.id} must list its full lesson set for an unrestricted user`);
    }
});

test('perms [] + no features → ungated courses visible, fully-gated course empty', async () => {
    resetMocks();
    const { visibleByCourse, degraded } = await resolve();
    assert.equal(degraded, false);
    // A course whose lessons carry no gate at all stays fully visible…
    const ungated = COURSES.find((c) => c.lessonIds.every((id) => !LESSON_GATES[id]));
    assert.ok(ungated, 'expected at least one fully ungated course');
    assert.deepEqual(visibleByCourse[ungated.id], ungated.lessonIds);
    // …and a course whose every lesson is gated is empty for this user.
    const fullyGated = COURSES.find((c) => c.lessonIds.length && c.lessonIds.every((id) => LESSON_GATES[id]));
    assert.ok(fullyGated, 'expected at least one fully gated course');
    assert.deepEqual(visibleByCourse[fullyGated.id], [],
        `every lesson in ${fullyGated.id} is gated away from a no-perm/no-feature user`);
});

test('an array permission gate is ANY-of', async () => {
    // Find a lesson actually gated on a permission ARRAY (knowledge-bases today)
    // and its owning course, rather than pinning either.
    const entry = Object.entries(LESSON_GATES).find(([, g]) => Array.isArray(g.permission) && !g.feature);
    assert.ok(entry, 'expected a lesson gated on a permission array');
    const [lessonId, gate] = entry;
    const course = COURSES.find((c) => c.lessonIds.includes(lessonId));

    resetMocks();
    mockPerms = [gate.permission[0]];           // just ONE of the listed permissions
    let { visibleByCourse } = await resolve();
    assert.ok(visibleByCourse[course.id].includes(lessonId),
        'one of the listed permissions suffices');

    resetMocks();
    mockPerms = ['something_else'];
    ({ visibleByCourse } = await resolve());
    assert.ok(!visibleByCourse[course.id].includes(lessonId),
        'an unrelated permission does not pass the ANY-of gate');
});

test('creating-skills requires BOTH the manage_skills permission AND the skills feature', async () => {
    const course = COURSES.find((c) => c.lessonIds.includes('creating-skills'));
    resetMocks();
    mockPerms = ['manage_skills']; // permission without the feature
    let { visibleByCourse } = await resolve();
    assert.ok(!visibleByCourse[course.id].includes('creating-skills'),
        'permission alone is not enough');

    resetMocks();
    mockPerms = ['manage_skills'];
    mockFeatures = new Set(['skills']);
    ({ visibleByCourse } = await resolve());
    assert.ok(visibleByCourse['course-skills-automation'].includes('creating-skills'),
        'permission + feature together pass');
});

// ── Fail-closed degraded paths ──────────────────────────────────────────

test('capSet.degraded → { visibleByCourse: undefined, degraded: true }', async () => {
    resetMocks();
    mockPerms = ['all'];
    mockCapDegraded = true;
    assert.deepEqual(await resolve(), { visibleByCourse: undefined, degraded: true });
});

test('isPermissionLookupDegraded() → { visibleByCourse: undefined, degraded: true }', async () => {
    resetMocks();
    mockPerms = ['all'];
    // Every feature any gate names — derived, so a new gate can never make this
    // "unrestricted user" quietly restricted again.
    mockFeatures = new Set(Object.values(LESSON_GATES).flatMap((g) => (Array.isArray(g.feature) ? g.feature : [g.feature])).filter(Boolean));
    mockPermDegraded = true;
    assert.deepEqual(await resolve(), { visibleByCourse: undefined, degraded: true });
});

test('getUserPermissions throwing → { visibleByCourse: undefined, degraded: true }', async () => {
    resetMocks();
    mockPermsThrow = true;
    assert.deepEqual(await resolve(), { visibleByCourse: undefined, degraded: true });
});

// ── ALL-of gates ────────────────────────────────────────────────────────
//
// The two halves of a gate answer different questions and so combine
// differently. `permission` asks "can you reach this screen at all", and a
// screen usually has more than one role that opens it, so it is ANY-of (pinned
// above). `feature` and `permissionsAll` ask "does this learner hold every
// power the lesson makes them USE", so they are ALL-of: a Playbooks lesson
// walks through Automations AND App Studio, and showing it to an org that
// licenses one of the two teaches a screen they cannot open — and leaves an
// action check they can never satisfy blocking the course badge behind it.

test('a feature LIST is ALL-of — one missing capability hides the lesson', async () => {
    // playbooks-run-a-recipe: { permission: 'manage_apps', feature: ['automations', 'app_studio'] }
    const gate = LESSON_GATES['playbooks-run-a-recipe'];
    assert.deepEqual(gate.feature, ['automations', 'app_studio'], 'fixture drifted');

    resetMocks();
    mockPerms = ['manage_apps'];
    mockFeatures = new Set(['app_studio']);            // half the list
    let vis = await resolve();
    assert.ok(!Object.values(vis.visibleByCourse).flat().includes('playbooks-run-a-recipe'),
        'half a feature list must not make the lesson visible');

    resetMocks();
    mockPerms = ['manage_apps'];
    mockFeatures = new Set(['app_studio', 'automations']);
    vis = await resolve();
    assert.ok(Object.values(vis.visibleByCourse).flat().includes('playbooks-run-a-recipe'),
        'the whole feature list must make it visible');
});

test('permissionsAll is ALL-of, unlike permission', async () => {
    // skills-attach-and-apply: attaching a skill to an agent is two powers.
    const gate = LESSON_GATES['skills-attach-and-apply'];
    assert.deepEqual(gate.permissionsAll, ['manage_skills', 'manage_agents'], 'fixture drifted');

    const sees = async (perms) => {
        resetMocks();
        mockPerms = perms;
        mockFeatures = new Set(['skills']);
        const vis = await resolve();
        return Object.values(vis.visibleByCourse).flat().includes('skills-attach-and-apply');
    };
    assert.equal(await sees(['manage_skills']), false, 'one of two must not pass');
    assert.equal(await sees(['manage_agents']), false, 'the other one alone must not pass');
    assert.equal(await sees(['manage_skills', 'manage_agents']), true, 'both must pass');
    assert.equal(await sees(['all']), true, "the 'all' wildcard still wins");
});
