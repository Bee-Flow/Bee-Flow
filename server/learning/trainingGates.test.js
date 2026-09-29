/**
 * Unit tests — required training (trainingGates.js + requireTraining.js).
 *
 * Three things are worth pinning, and they are the three that would hurt:
 *
 *   1. The allow-list of authoring paths. /agents/:id/chat sits beside
 *      POST /agents; if the gate ever widens to "all writes", an organisation
 *      that required a course would find its people unable to TALK to an agent.
 *      So the operate paths of the real routers are asserted reachable.
 *   2. Fail-open. Four separate conditions must let the write through rather
 *      than block it — see the module header for why the asymmetry with
 *      visibility.js is deliberate.
 *   3. Completion over VISIBLE lessons, so a course carrying one lesson the
 *      learner's plan hides can still be finished.
 *
 * Run: node --test server/learning/trainingGates.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    TRAINING_AREAS, normalizeSettings, courseSatisfied, evaluateAreas,
} = require('./trainingGates');
const { pathIsGated, SAFE_METHODS } = require('./requireTraining');
const { COURSES } = require('./courseCatalog');

// ── The area catalog ─────────────────────────────────────────────────────

test('every area points at a course that exists', () => {
    const ids = new Set(COURSES.map((c) => c.id));
    for (const area of TRAINING_AREAS) {
        assert.ok(ids.has(area.defaultCourseId),
            `area '${area.id}' defaults to '${area.defaultCourseId}', which is not in the catalog`);
    }
});

test('every area has a course with lessons to finish', () => {
    for (const area of TRAINING_AREAS) {
        const course = COURSES.find((c) => c.id === area.defaultCourseId);
        assert.ok((course.lessonIds || []).length > 0,
            `area '${area.id}' gates on an empty course — it could never be lifted`);
    }
});

// ── Which writes are locked ──────────────────────────────────────────────

test('using an agent is never gated, only authoring one', () => {
    // The whole reason the area carries a path allow-list.
    for (const p of ['/a1/chat', '/a1/chat/stream', '/a1/conversations', '/a1/conversations/c1',
        '/a1/favorite', '/favorites/bulk', '/thread/title', '/a1/history']) {
        assert.equal(pathIsGated('agents', p), false, `agents: ${p} must stay reachable`);
    }
    for (const p of ['/', '/wizard/draft', '/wizard/commit', '/a1', '/a1/publish', '/a1/tests', '/categories']) {
        assert.equal(pathIsGated('agents', p), true, `agents: ${p} must be gated`);
    }
});

test('running a routine is never gated, only authoring one', () => {
    for (const p of ['/a1/run', '/a1/dry-run', '/a1/activate', '/a1/deactivate', '/a1/agent-invoke',
        '/runs/r1/approve', '/runs/r1/cancel', '/approvals/ap1/decide', '/webhook/slug',
        '/form/tok', '/form/tok/upload', '/events/gmail', '/_schedule/preview',
        '/a1/steps/s1/run', '/a1/runs/r1/retry']) {
        assert.equal(pathIsGated('automations', p), false, `automations: ${p} must stay reachable`);
    }
    for (const p of ['/', '/import', '/a1', '/folders', '/a1/versions/v1/restore', '/a1/form']) {
        assert.equal(pathIsGated('automations', p), true, `automations: ${p} must be gated`);
    }
});

test('using an app or filling a table is never gated', () => {
    for (const p of ['/a1/run', '/a1/data', '/a1/data/batch', '/a1/files/f1']) {
        assert.equal(pathIsGated('apps', p), false, `apps: ${p} must stay reachable`);
    }
    assert.equal(pathIsGated('datatables', '/t1/rows'), false, 'filling a table in is ordinary work');
    assert.equal(pathIsGated('datatables', '/t1/columns'), true, 'reshaping one is authoring');
});

test('uploading your genome file into an app is using it; saving a BI dataset is building it', () => {
    // Two routers share the word. /:id/datasets is routes/studioAppData.js: the
    // saved aggregates an author defines in the builder. /:id/large-datasets is
    // routes/studioAppDatasets.js: the file a person uploads from a RUNNING app
    // (the input_dataset field is only live in run mode). Until 2026-09-23 the
    // uploads sat on /:id/datasets too, and so this gate locked them as
    // authoring; the move to their own path is what opened them, and this pins
    // that it was meant.
    const ds = '0b9f6c1e-7d2a-4c3b-9e8f-1a2b3c4d5e6f';
    for (const p of ['/a1/large-datasets', `/a1/large-datasets/${ds}/parts/0`,
        `/a1/large-datasets/${ds}/complete`, `/a1/large-datasets/${ds}`]) {
        assert.equal(pathIsGated('apps', p), false, `apps: ${p} must stay reachable`);
    }
    for (const p of ['/a1/datasets', '/a1/datasets/ds_1']) {
        assert.equal(pathIsGated('apps', p), true, `apps: ${p} must be gated`);
    }
});

test('reads are never gated at all', () => {
    for (const m of ['GET', 'HEAD', 'OPTIONS']) assert.ok(SAFE_METHODS.has(m));
    assert.ok(!SAFE_METHODS.has('POST'));
});

// ── Stored settings ──────────────────────────────────────────────────────

test('normalizeSettings drops unknown areas and empty course ids', () => {
    const { areas } = normalizeSettings({
        areas: { agents: 'course-build-agent', retired_area: 'course-x', apps: '', skills: 7 },
    });
    assert.deepEqual(areas, { agents: 'course-build-agent' });
});

test('normalizeSettings survives junk', () => {
    for (const junk of [null, undefined, 'nope', 42, [], { areas: null }, { areas: [] }]) {
        assert.deepEqual(normalizeSettings(junk).areas, {});
    }
});

// ── Completion ───────────────────────────────────────────────────────────

const progressOf = (...ids) => Object.fromEntries(ids.map((id) => [id, { completedAt: '2026-09-01T00:00:00Z' }]));

test('a course counts as finished over the VISIBLE lessons only', () => {
    const course = { id: 'c', lessonIds: ['l1', 'l2', 'l3'] };
    const extra = [course];
    // All three required: two done is not enough.
    assert.deepEqual(courseSatisfied('c', progressOf('l1', 'l2'), { c: ['l1', 'l2', 'l3'] }, extra),
        { satisfied: false, done: 2, total: 3 });
    // l3 is hidden by this learner's plan, so the same progress finishes it.
    assert.deepEqual(courseSatisfied('c', progressOf('l1', 'l2'), { c: ['l1', 'l2'] }, extra),
        { satisfied: true, done: 2, total: 2 });
});

test('unknown course, degraded visibility and nothing-visible all answer null', () => {
    const extra = [{ id: 'c', lessonIds: ['l1'] }];
    assert.equal(courseSatisfied('gone', {}, { c: ['l1'] }, extra), null, 'course deleted');
    assert.equal(courseSatisfied('c', {}, undefined, extra), null, 'degraded lookup');
    assert.equal(courseSatisfied('c', {}, { c: [] }, extra), null, 'no visible lessons');
});

// ── The rule as a whole ──────────────────────────────────────────────────

const extraCourses = [{ id: 'course-x', title: 'Course X', lessonIds: ['l1', 'l2'] }];
const base = {
    settings: { areas: { agents: 'course-x' } },
    progressMap: progressOf('l1'),
    visibleByCourse: { 'course-x': ['l1', 'l2'] },
    extraCourses,
};

test('an unfinished course enforces the area, and reports how far along', () => {
    const areas = evaluateAreas(base);
    assert.deepEqual(areas.agents, {
        enforced: true, satisfied: false, courseId: 'course-x',
        courseTitle: 'Course X', lessonsDone: 1, lessonsTotal: 2,
    });
});

test('finishing the course lifts the area', () => {
    const areas = evaluateAreas({ ...base, progressMap: progressOf('l1', 'l2') });
    assert.equal(areas.agents.satisfied, true);
});

test('an area with no rule is never enforced', () => {
    const areas = evaluateAreas({ ...base, settings: { areas: {} } });
    for (const area of TRAINING_AREAS) {
        assert.deepEqual(areas[area.id], { enforced: false, satisfied: true },
            `'${area.id}' has no rule and must not be enforced`);
    }
});

test('org admins are exempt — they set the rule and must not lock themselves out', () => {
    const areas = evaluateAreas({ ...base, isOrgAdmin: true });
    assert.equal(areas.agents.enforced, false);
    assert.equal(areas.agents.exempt, true);
});

test('no Learning Center, no gate — the course would be unreachable', () => {
    const areas = evaluateAreas({ ...base, learningAvailable: false });
    assert.equal(areas.agents.enforced, false);
    assert.equal(areas.agents.exempt, true);
});

test('a degraded visibility lookup fails OPEN, unlike visibility.js', () => {
    // Deliberately the opposite asymmetry: failing closed here would stop an
    // organisation from working during an outage, where in visibility.js it
    // only withholds a certificate that can be collected a minute later.
    const areas = evaluateAreas({ ...base, visibleByCourse: undefined });
    assert.equal(areas.agents.enforced, false);
});

test('a rule pointing at a course that no longer exists fails open', () => {
    const areas = evaluateAreas({ ...base, settings: { areas: { agents: 'course-deleted' } } });
    assert.equal(areas.agents.enforced, false);
});
