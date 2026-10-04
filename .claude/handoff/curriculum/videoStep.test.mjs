// Run: node --test .claude/handoff/curriculum/videoStep.test.mjs
//
// The `video` field of a curriculum.json lesson entry: unit tests of the
// insertion rules, and one end-to-end run of generate.mjs against a scratch
// repo built from a fixture curriculum (the real curriculum.json stays
// untouched).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { insertVideoStep, videoStepId, videoStepToJs } from './videoStep.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const STEPS = [
    { type: 'quiz', id: 'predict' },
    { type: 'slide', id: 'intro' },
    { type: 'slide', id: 'more' },
    { type: 'quiz', id: 'check' },
];

test('no video field leaves the steps alone', () => {
    const r = insertVideoStep('l1', STEPS, undefined);
    assert.equal(r.steps, STEPS);
    assert.deepEqual(r.problems, []);
});

test('default placement is right after the first slide', () => {
    const r = insertVideoStep('l1', STEPS, { id: 'agents-intro', titleFallback: 'Agents in 70 seconds' });
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.steps.map((s) => s.id), ['predict', 'intro', 'video-agents-intro', 'more', 'check']);
    assert.deepEqual(r.steps[2], { type: 'video', id: 'video-agents-intro', videoId: 'agents-intro', title: 'Agents in 70 seconds' });
    assert.equal(STEPS.length, 4, 'input not mutated');
});

test('a lesson without a slide gets the video first; a numeric after inserts after that index', () => {
    const noSlide = [{ type: 'quiz', id: 'a' }, { type: 'quiz', id: 'b' }];
    assert.deepEqual(insertVideoStep('l1', noSlide, { id: 'x' }).steps.map((s) => s.id), ['video-x', 'a', 'b']);
    assert.deepEqual(insertVideoStep('l1', STEPS, { id: 'x', after: 3 }).steps.map((s) => s.id), ['predict', 'intro', 'more', 'check', 'video-x']);
    assert.deepEqual(insertVideoStep('l1', STEPS, { id: 'x', after: 0 }).steps.map((s) => s.id), ['predict', 'video-x', 'intro', 'more', 'check']);
});

test('bad fields are problems, never a silently wrong lesson', () => {
    const bad = [
        [{ id: 'Bad Id' }, /id must match/],
        [{ id: 'x'.repeat(49) }, /id must match/],
        [{ id: 'x', after: 4 }, /after must be/],
        [{ id: 'x', after: 'last' }, /after must be/],
        [{ id: 'x', titleFallback: '' }, /titleFallback/],
        [{ id: 'x', poster: 'p.jpg' }, /poster is not a known field/],
        ['x', /must be an object/],
    ];
    for (const [video, rx] of bad) {
        const r = insertVideoStep('l1', STEPS, video);
        assert.equal(r.steps, STEPS);
        assert.ok(r.problems.some((p) => rx.test(p)), `${JSON.stringify(video)} → ${r.problems.join('; ')}`);
    }
    const clash = insertVideoStep('l1', [{ type: 'slide', id: 'video-x' }], { id: 'x' });
    assert.match(clash.problems.join(), /already exists/);
});

test('step ids stay within the progress store cap', () => {
    assert.ok(videoStepId('x'.repeat(48)).length <= 64);
});

test('videoStepToJs keys the caption and omits it when absent', () => {
    const dict = new Map();
    const K = (f) => `learn.l1.video-x.${f}`;
    const put = (k, v) => dict.set(k, v);
    assert.equal(
        videoStepToJs({ type: 'video', id: 'video-x', videoId: 'x', title: 'Caption' }, K, put, JSON.stringify),
        '{ type: STEP_TYPES.VIDEO, id: "video-x", videoId: "x", titleKey: "learn.l1.video-x.title", titleFallback: "Caption" }',
    );
    assert.deepEqual([...dict], [['learn.l1.video-x.title', 'Caption']]);
    assert.equal(videoStepToJs({ type: 'video', id: 'video-x', videoId: 'x' }, K, put, JSON.stringify), '{ type: STEP_TYPES.VIDEO, id: "video-x", videoId: "x" }');
});

test('generate.mjs writes the video step, its key, and leaves the server catalog alone', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curriculum-video-'));
    try {
        // A one-course curriculum around a real, valid lesson.
        const cur = path.join(tmp, 'curriculum');
        fs.mkdirSync(path.join(cur, 'lessons'), { recursive: true });
        for (const f of ['generate.mjs', 'validate-lesson.mjs', 'videoStep.mjs']) fs.copyFileSync(path.join(HERE, f), path.join(cur, f));
        const LESSON = 'admin-access-control';
        fs.copyFileSync(path.join(HERE, 'lessons', `${LESSON}.json`), path.join(cur, 'lessons', `${LESSON}.json`));
        const course = (video) => ({
            courses: [{
                id: 'course-hive-master', pathId: 'admin', title: 'Fixture', desc: 'Fixture course', icon: '🐝', level: 'beginner', track: 'admin',
                badge: { id: 'badge-fixture', icon: '🏅', title: 'Fixture', desc: 'Fixture' },
                lessons: [{ id: LESSON, ...(video ? { video } : {}) }],
            }],
        });

        // A scratch repo: just the files the generator writes, plus a no-op
        // frontend dictionary generator.
        const repo = path.join(tmp, 'repo');
        fs.mkdirSync(path.join(repo, 'server/i18n/defaults/en'), { recursive: true });
        fs.mkdirSync(path.join(repo, 'server/learning'), { recursive: true });
        fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
        fs.writeFileSync(path.join(repo, 'server/i18n/defaults/en/learn.js'), "'use strict';\nmodule.exports = {\n    'learn.kind.video': 'video',\n};\n");
        fs.writeFileSync(path.join(repo, 'scripts/gen-i18n-defaults.mjs'), '');
        const run = (video) => {
            fs.writeFileSync(path.join(cur, 'curriculum.json'), JSON.stringify(course(video)));
            execFileSync(process.execPath, [path.join(cur, 'generate.mjs')], { env: { ...process.env, BEEFLOW_REPO: repo }, stdio: 'pipe' });
            const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');
            return {
                lessons: read('agent-hub/src/components/onboarding/generated/lessons.js'),
                catalog: read('server/learning/catalog.generated.js'),
                dict: read('server/i18n/defaults/en/learn.js'),
            };
        };

        const plain = run(null);
        const withVideo = run({ id: 'roles-tour', titleFallback: 'Roles in one minute' });

        assert.ok(!plain.lessons.includes('STEP_TYPES.VIDEO'));
        assert.match(withVideo.lessons, /\{ type: STEP_TYPES\.SLIDE, id: "two-axes"[^\n]*\n\s+\{ type: STEP_TYPES\.VIDEO, id: "video-roles-tour", videoId: "roles-tour", titleKey: "learn\.admin-access-control\.video-roles-tour\.title", titleFallback: "Roles in one minute" \},/);
        assert.match(withVideo.dict, /'learn\.admin-access-control\.video-roles-tour\.title': 'Roles in one minute',/);
        assert.ok(withVideo.dict.includes("'learn.kind.video': 'video',"), 'hand-written keys survive');
        // Gates, ids, rubrics and practice topics do not move for an optional step.
        assert.equal(withVideo.catalog, plain.catalog);

        // And a bad field fails the run instead of writing anything.
        assert.throws(() => run({ id: 'Bad Id' }), /id must match/);

        // A lesson file no course lists (a draft, even an invalid one) is
        // skipped with a warning instead of failing the whole run.
        fs.writeFileSync(path.join(cur, 'lessons', 'draft-orphan.json'), JSON.stringify({ id: 'draft-orphan', steps: [] }));
        fs.writeFileSync(path.join(cur, 'curriculum.json'), JSON.stringify(course(null)));
        const out = spawnSync(process.execPath, [path.join(cur, 'generate.mjs')], { env: { ...process.env, BEEFLOW_REPO: repo }, encoding: 'utf8' });
        assert.equal(out.status, 0, out.stderr);
        assert.match(out.stderr, /lessons\/draft-orphan\.json is in no course; skipped/);
        assert.equal(fs.readFileSync(path.join(repo, 'agent-hub/src/components/onboarding/generated/lessons.js'), 'utf8'), plain.lessons);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
