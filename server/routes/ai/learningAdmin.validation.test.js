/**
 * What the Academy authoring routes accept, and what they say when they
 * refuse (routes/ai/learningAdmin.js).
 *
 * The store's normaliser turns anything into SOME lesson, and it was the only
 * gate. A pass score the admin cleared in the editor arrived as '' and was
 * saved as 1 — every answer that scored anything passed. `correct: "false"`
 * marked a wrong quiz answer correct. A slide over 8,000 characters lost its
 * tail. A PUT without lessonIds detached every lesson from the course. Each
 * one answered 200.
 *
 * The real store runs underneath (its configStore is an in-memory map), so
 * what is pinned is the whole save: the 400 names the field and the step, the
 * sentence is one the editor can show, and a refusal writes nothing.
 *
 * Run: cd server && node --test routes/ai/learningAdmin.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every configStore write lands in `writes`. A refused request must leave it empty.
const writes = [];
const config = new Map();
const pass = (req, res, next) => next();

const MOCKS = {
    '../../auth/permissions': {
        requireAuth: pass,
        requirePrimaryOrgAdmin: () => (req, res, next) => { req.primaryOrgId = 'orgA'; next(); },
    },
    // The store is REAL; only its persistence is in memory.
    './configStore': {
        getConfig: async (key) => config.get(key) ?? null,
        setConfig: async (key, value) => { writes.push(key); config.set(key, value); },
        deleteConfig: async (key) => { writes.push(`-${key}`); config.delete(key); },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:learning-admin-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /(routes[\\/]ai[\\/]learningAdmin|stores[\\/]learningContentStore)\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./learningAdmin');
test.after(() => { Module._resolveFilename = originalResolve; });

const { dispatcher } = require('../../core/http/routeHarness');

const dispatch = dispatcher(router, { session: () => ({ user: { id: 'admin1' } }) });

test.beforeEach(() => { writes.length = 0; config.clear(); });

// Exactly what AcademyContentEditor sends: the whole lesson, flat step fields.
const exercise = (over = {}) => ({
    type: 'exercise', id: 's-1', icon: '✍️', title: 'Try it', instruction: 'Write a prompt',
    placeholder: '', task: 'Write a prompt that asks for a summary', criteria: ['Mentions length', ''],
    passScore: 70, guidance: '', maxAttempts: 3, ...over,
});
const quiz = (choices) => ({
    type: 'quiz', id: 's-2', icon: '❓', title: 'Check', question: 'Which is PII?', multi: false,
    choices, explanation: '',
});
const lesson = (steps) => ({ title: 'Prompting 101', desc: '', icon: '📘', estMinutes: 5, steps });
const course = (over = {}) => ({
    title: 'AI basics', desc: '', icon: '📘', level: 'beginner', lessonIds: [],
    badgeTitle: '', badgeIcon: '🏵️', ...over,
});

// ═══ Lessons ═════════════════════════════════════════════════════════

test('a cleared pass score is refused — it used to save as 1, and every answer passed', async () => {
    const res = await dispatch({ method: 'PUT', url: '/lessons/new', body: lesson([exercise({ passScore: '' })]) });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Step 1: the pass score is a number from 1 to 100.', 'the editor shows this sentence');
    assert.ok(res.body.details.some((d) => d.path === 'body.steps.0.passScore'));
    assert.deepStrictEqual(writes, [], 'a refused save writes nothing');
});

test('a cleared attempt limit is refused rather than becoming one attempt', async () => {
    const res = await dispatch({ method: 'PUT', url: '/lessons/new', body: lesson([exercise(), exercise({ id: 's-9', maxAttempts: '' })]) });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Step 2: the number of attempts is a number from 1 to 10.');
    assert.deepStrictEqual(writes, []);
});

test('correct: "false" is refused instead of marking a wrong answer correct', async () => {
    const res = await dispatch({
        method: 'PUT', url: '/lessons/new',
        body: lesson([quiz([{ id: 'c1', label: 'An email address', correct: true }, { id: 'c2', label: 'A colour', correct: 'false' }])]),
    });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.steps.0.choices.1.correct'));
    assert.deepStrictEqual(writes, []);
});

test('a slide over the store limit is refused, not cut off at 8,000 characters', async () => {
    const res = await dispatch({
        method: 'PUT', url: '/lessons/new',
        body: lesson([{ type: 'slide', id: 's-1', icon: '📘', title: 'Long read', bodyMd: 'x'.repeat(8001) }]),
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Step 1: the slide text is at most 8000 characters.');
    assert.deepStrictEqual(writes, []);
});

test('an unknown step type is refused with the step it is in', async () => {
    const res = await dispatch({ method: 'PUT', url: '/lessons/new', body: lesson([exercise(), { type: 'video', url: 'x' }]) });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Step 2: a step is a slide, a quiz or an exercise.');
    assert.deepStrictEqual(writes, []);
});

test('a lesson with no steps keeps the store\'s own sentence', async () => {
    const res = await dispatch({ method: 'PUT', url: '/lessons/new', body: lesson([]) });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'A lesson needs at least one step');
});

test('a partial lesson is refused: a save replaces the draft', async () => {
    const res = await dispatch({ method: 'PUT', url: '/lessons/orgl-abc', body: { title: 'Renamed', steps: [exercise()] } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'A save sends the whole lesson; desc is missing.');
    assert.deepStrictEqual(writes, []);
});

test('the editor\'s own lesson saves, with the rubric where the coach reads it', async () => {
    const res = await dispatch({ method: 'PUT', url: '/lessons/new', body: lesson([exercise()]) });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const step = res.body.lesson.steps[0];
    assert.strictEqual(step.rubric.passScore, 70);
    assert.strictEqual(step.maxAttempts, 3);
    assert.deepStrictEqual(step.rubric.criteria, ['Mentions length'], 'the editor\'s blank row is still dropped');
    assert.match(res.body.lesson.id, /^orgl-/);
});

// ═══ Courses ═════════════════════════════════════════════════════════

test('a course PUT without lessonIds is refused — it used to detach every lesson', async () => {
    const { lessonIds: _omit, ...rest } = course();
    const res = await dispatch({ method: 'PUT', url: '/courses/orgc-abc', body: rest });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'A save sends the whole course; lessonIds is missing.');
    assert.deepStrictEqual(writes, []);
});

test('one lesson id sent as text, not a list, is refused — it used to detach every lesson', async () => {
    const res = await dispatch({ method: 'PUT', url: '/courses/orgc-abc', body: course({ lessonIds: 'orgl-abc123' }) });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.lessonIds'));
    assert.deepStrictEqual(writes, [], 'the course keeps its lessons');
});

test('a misspelled field is refused, not dropped while the field it meant is saved empty', async () => {
    const { desc: _desc, ...rest } = course();
    let res = await dispatch({ method: 'PUT', url: '/courses/orgc-abc', body: { ...rest, desc: '', description: 'About prompts' } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(/description/.test(JSON.stringify(res.body.details)), JSON.stringify(res.body.details));

    const { explanation: _e, ...step } = quiz([{ id: 'c1', label: 'An email address', correct: true }]);
    res = await dispatch({ method: 'PUT', url: '/lessons/orgl-abc', body: lesson([{ ...step, explanaton: 'Addresses identify a person.' }]) });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, "Step 1: a quiz step has no field 'explanaton'.");
    assert.deepStrictEqual(writes, [], 'the stored description and explanation keep their text');
});

test('an unknown level is refused instead of saved as beginner', async () => {
    const res = await dispatch({ method: 'PUT', url: '/courses/orgc-abc', body: course({ level: 'expert' }) });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'A course level is beginner, intermediate or advanced.');
    assert.deepStrictEqual(writes, []);
});

test('a lesson id that is not this organisation\'s is refused instead of dropped', async () => {
    const res = await dispatch({ method: 'PUT', url: '/courses/orgc-abc', body: course({ lessonIds: ['orgl-1', 'lesson-intro'] }) });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.lessonIds.1'));
    assert.deepStrictEqual(writes, []);
});

test('the editor\'s own course body saves, lessons in order', async () => {
    const res = await dispatch({ method: 'PUT', url: '/courses/orgc-abc', body: course({ level: 'advanced', lessonIds: ['orgl-2', 'orgl-1'] }) });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.course.id, 'orgc-abc');
    assert.strictEqual(res.body.course.level, 'advanced');
    assert.deepStrictEqual(res.body.course.lessonIds, ['orgl-2', 'orgl-1']);
});

test('a create may lean on the defaults a new course starts with', async () => {
    const res = await dispatch({ method: 'POST', url: '/courses', body: { title: 'Onboarding' } });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.match(res.body.course.id, /^orgc-/);
    assert.strictEqual(res.body.course.level, 'beginner');
});

test('a create cannot choose its own id', async () => {
    const res = await dispatch({ method: 'POST', url: '/courses', body: { title: 'Mine', id: 'orgc-mine' } });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(writes, []);
});

test('an empty create is refused in words, not with "Required"', async () => {
    const res = await dispatch({ method: 'POST', url: '/courses', body: undefined });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Course title is required');
    assert.deepStrictEqual(writes, []);
});
