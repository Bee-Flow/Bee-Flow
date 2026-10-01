#!/usr/bin/env node
// Integrates the authored curriculum into the repo.
//
//   node generate.mjs [--check]
//
// Reads  <DIR>/curriculum.json and <DIR>/lessons/*.json (the validator's shape)
// Writes agent-hub/src/components/onboarding/generated/{lessons,courses,practiceLessonIds,actionChecks}.js
//        server/learning/catalog.generated.js
//        the <learning-generated> block of server/i18n/defaults/en/learn.js
//        (the `learn` namespace file of the English dictionary), after which it
//        regenerates the frontend copy agent-hub/src/i18n/en-defaults.js with
//        scripts/gen-i18n-defaults.mjs — that file is generated, never written
//        here directly.
//
// Deterministic and idempotent: every generated artifact is fully rebuilt
// from the JSON, and dictionary keys the generator owns are stripped from the
// hand-written part before the block is rewritten.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DIR = path.dirname(new URL(import.meta.url).pathname);
// This file lives in <repo>/.claude/handoff/curriculum; BEEFLOW_REPO overrides
// that for a copy run from elsewhere.
const REPO = process.env.BEEFLOW_REPO || path.resolve(DIR, '..', '..', '..');
const CLIENT_GEN = path.join(REPO, 'agent-hub/src/components/onboarding/generated');
const SERVER_GEN = path.join(REPO, 'server/learning/catalog.generated.js');
const EN_SERVER = path.join(REPO, 'server/i18n/defaults/en/learn.js');
const GEN_DEFAULTS = path.join(REPO, 'scripts/gen-i18n-defaults.mjs');
const checkOnly = process.argv.includes('--check');

const curriculum = JSON.parse(fs.readFileSync(path.join(DIR, 'curriculum.json'), 'utf8'));
const lessonFiles = fs.readdirSync(path.join(DIR, 'lessons')).filter((f) => f.endsWith('.json')).sort();
const lessonsById = new Map();
const problems = [];
for (const f of lessonFiles) {
    const p = path.join(DIR, 'lessons', f);
    try { execFileSync('node', [path.join(DIR, 'validate-lesson.mjs'), p], { stdio: 'pipe' }); }
    catch (e) { problems.push(`${f}: ${String(e.stdout || e.message).trim().split('\n').slice(0, 3).join(' | ')}`); continue; }
    const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (doc.id !== f.replace(/\.json$/, '')) problems.push(`${f}: id ${doc.id} does not match file name`);
    lessonsById.set(doc.id, doc);
}

// Lessons that stay hand-written in lessons.js (the intro tour and its legacy sibling).
const HANDWRITTEN = new Set(['getting-started', 'effective-prompts']);

// ── Course list ────────────────────────────────────────────────────────────
const courses = curriculum.courses;
const seenLesson = new Set();
for (const c of courses) {
    for (const l of c.lessons) {
        if (seenLesson.has(l.id)) problems.push(`lesson ${l.id} appears in two courses`);
        seenLesson.add(l.id);
        if (!HANDWRITTEN.has(l.id) && !lessonsById.has(l.id)) problems.push(`course ${c.id}: lesson ${l.id} has no authored file`);
    }
}
for (const id of lessonsById.keys()) if (!seenLesson.has(id)) problems.push(`authored lesson ${id} is in no course`);
if (courses.at(-1)?.id !== 'course-hive-master') problems.push('course-hive-master must be the last course');
if (problems.length) { console.error('PROBLEMS:\n' + problems.join('\n')); if (!checkOnly) process.exit(1); }

const GROUP = { everyday: 'basics', builder: 'building', admin: 'admin' };
const key = (...parts) => `learn.${parts.join('.')}`;
const dict = new Map(); // key → English
const put = (k, v) => { if (typeof v !== 'string') return; if (dict.has(k) && dict.get(k) !== v) problems.push(`key ${k} generated twice with different text`); dict.set(k, v); };
const js = (v) => JSON.stringify(v);

function stepToJs(lessonId, s) {
    const K = (f) => key(lessonId, s.id, f);
    const lines = [];
    const icon = s.icon ? `icon: ${js(s.icon)}, ` : '';
    switch (s.type) {
        case 'slide':
            put(K('title'), s.title); put(K('body'), s.bodyMd);
            return `{ type: STEP_TYPES.SLIDE, id: ${js(s.id)}, ${icon}titleKey: ${js(K('title'))}, titleFallback: ${js(s.title)}, bodyMdKey: ${js(K('body'))}, bodyMdFallback: ${js(s.bodyMd)} }`;
        case 'quiz': {
            put(K('q'), s.question); put(K('explanation'), s.explanation);
            const choiceJs = s.choices.map((c) => {
                const lk = key(lessonId, s.id, 'choice', c.id, 'label');
                const fk = key(lessonId, s.id, 'choice', c.id, 'feedback');
                put(lk, c.label);
                if (c.feedback) put(fk, c.feedback);
                return `{ id: ${js(c.id)}, labelKey: ${js(lk)}, labelFallback: ${js(c.label)}, correct: ${!!c.correct}${c.feedback ? `, feedbackKey: ${js(fk)}, feedbackFallback: ${js(c.feedback)}` : ''} }`;
            });
            return `{ type: STEP_TYPES.QUIZ, id: ${js(s.id)}, icon: ${js(s.icon || '❓')}, questionKey: ${js(K('q'))}, questionFallback: ${js(s.question)}${s.multi ? ', multi: true' : ''}, choices: [${choiceJs.join(', ')}], explanationKey: ${js(K('explanation'))}, explanationFallback: ${js(s.explanation)} }`;
        }
        case 'exercise':
            put(K('title'), s.title); put(K('instruction'), s.instruction); put(K('placeholder'), s.placeholder);
            return `{ type: STEP_TYPES.EXERCISE, id: ${js(s.id)}, exerciseId: ${js(s.exerciseId)}, ${icon}titleKey: ${js(K('title'))}, titleFallback: ${js(s.title)}, instructionKey: ${js(K('instruction'))}, instructionFallback: ${js(s.instruction)}, placeholderKey: ${js(K('placeholder'))}, placeholderFallback: ${js(s.placeholder)}, passScore: ${s.passScore}, maxAttempts: ${s.maxAttempts} }`;
        case 'sim': {
            put(K('title'), s.title); put(K('instruction'), s.instruction);
            const sim = s.sim;
            let simJs;
            if (sim.kind === 'match') {
                const pairJs = sim.pairs.map((p) => {
                    const lk = key(lessonId, s.id, 'pair', p.id, 'left');
                    const rk = key(lessonId, s.id, 'pair', p.id, 'right');
                    const nk = key(lessonId, s.id, 'pair', p.id, 'note');
                    put(lk, p.left); put(rk, p.right);
                    if (p.note) put(nk, p.note);
                    return `{ id: ${js(p.id)}, leftKey: ${js(lk)}, left: ${js(p.left)}, rightKey: ${js(rk)}, right: ${js(p.right)}${p.note ? `, noteKey: ${js(nk)}, noteFallback: ${js(p.note)}` : ''} }`;
                });
                simJs = `{ kind: 'match', pairs: [${pairJs.join(', ')}] }`;
            } else if (sim.kind === 'order') {
                const itemJs = sim.items.map((i) => {
                    const lk = key(lessonId, s.id, 'item', i.id, 'label');
                    put(lk, i.label);
                    return `{ id: ${js(i.id)}, labelKey: ${js(lk)}, label: ${js(i.label)} }`;
                });
                const fk = K('feedback');
                put(fk, sim.feedback);
                simJs = `{ kind: 'order', items: [${itemJs.join(', ')}], solution: ${js(sim.solution)}, feedbackKey: ${js(fk)}, feedbackFallback: ${js(sim.feedback)} }`;
            } else {
                // flow-build: the scenario BRIEF is keyed; the option/palette
                // vocabularies stay fallback-only for now (they double as the
                // solution's node names, so keying them is a matching change,
                // not a lookup change — see the handoff note for BFSF-474).
                const scenarioJs = sim.scenarios.map((sc) => {
                    const bk = key(lessonId, s.id, 'scenario', sc.id, 'brief');
                    put(bk, sc.brief);
                    return `{ id: ${js(sc.id)}, briefKey: ${js(bk)}, briefFallback: ${js(sc.brief)}, trigger: { options: ${js(sc.trigger.options)}, correct: ${js(sc.trigger.correct)}, feedback: ${js(sc.trigger.feedback || {})} }, steps: { palette: ${js(sc.steps.palette)}, solution: ${js(sc.steps.solution)}, feedback: ${js(sc.steps.feedback || {})} } }`;
                });
                simJs = `{ kind: 'flow-build', scenarios: [${scenarioJs.join(', ')}] }`;
            }
            return `{ type: STEP_TYPES.SIM, id: ${js(s.id)}, ${icon}titleKey: ${js(K('title'))}, titleFallback: ${js(s.title)}, instructionKey: ${js(K('instruction'))}, instructionFallback: ${js(s.instruction)}, sim: ${simJs} }`;
        }
        case 'action': {
            put(K('title'), s.title); put(K('instruction'), s.instruction);
            const lk = K('launch');
            put(lk, s.launch.label);
            return `{ type: STEP_TYPES.ACTION, id: ${js(s.id)}, checkId: ${js(s.checkId)}, ${icon}titleKey: ${js(K('title'))}, titleFallback: ${js(s.title)}, instructionKey: ${js(K('instruction'))}, instructionFallback: ${js(s.instruction)}, launch: { navigateTo: ${js(s.launch.navigateTo)}, labelKey: ${js(lk)}, labelFallback: ${js(s.launch.label)} } }`;
        }
        case 'tour':
            put(K('title'), s.title); put(K('body'), s.body);
            return `{ id: ${js(s.id)}, target: ${js(s.target)}${s.navigateTo ? `, navigateTo: ${js(s.navigateTo)}` : ''}, placement: ${js(s.placement || 'bottom')}, optional: true, timeoutMs: ${s.timeoutMs}, ${icon}titleKey: ${js(K('title'))}, titleFallback: ${js(s.title)}, bodyKey: ${js(K('body'))}, bodyFallback: ${js(s.body)} }`;
        default:
            throw new Error(`unknown step type ${s.type}`);
    }
}

// ── Client: lessons ────────────────────────────────────────────────────────
const lessonBlocks = [];
const rubrics = {};
const practiceTopics = {};
const exerciseLessons = {};
const lessonGates = {};
const newChecks = new Map();
for (const c of courses) {
    for (const l of c.lessons) {
        if (HANDWRITTEN.has(l.id)) continue;
        const doc = lessonsById.get(l.id);
        if (!doc) continue;
        put(key(l.id, 'title'), doc.title); put(key(l.id, 'desc'), doc.desc);
        const gate = doc.gate && Object.keys(doc.gate).length ? doc.gate : {};
        // Every gate key the runtime understands has to be listed here: a gate
        // the client enforces but the server never sees makes the server think
        // the lesson is visible to everyone, and completion.js then demands a
        // lesson the learner cannot open before it will mint a certificate.
        if (gate.permission || gate.permissionsAll || gate.feature) lessonGates[l.id] = gate;
        lessonBlocks.push(`    {\n        id: ${js(l.id)}, group: ${js(GROUP[c.pathId] || 'basics')}, icon: ${js(doc.icon)}, estMinutes: ${doc.estMinutes},\n        titleKey: ${js(key(l.id, 'title'))}, titleFallback: ${js(doc.title)},\n        descKey: ${js(key(l.id, 'desc'))}, descFallback: ${js(doc.desc)},\n        gate: ${js(gate)},\n        steps: [\n${doc.steps.map((s) => '            ' + stepToJs(l.id, s) + ',').join('\n')}\n        ],\n    },`);
        for (const [exId, r] of Object.entries(doc.rubrics || {})) { rubrics[exId] = r; exerciseLessons[exId] = l.id; }
        if (doc.practiceTopic) practiceTopics[l.id] = doc.practiceTopic;
        for (const ck of doc.actionChecks || []) newChecks.set(ck.checkId, ck);
    }
}

const header = (what) => `// GENERATED by scratchpad/curriculum/generate.mjs from the authored curriculum — do not edit by hand.\n// ${what}\n`;
const clientLessons = `${header('Every Learning Center lesson except the intro tour (lessons.js keeps getting-started / effective-prompts).')}import { STEP_TYPES } from '../stepTypes';\n\nexport const GENERATED_LESSONS = [\n${lessonBlocks.join('\n')}\n];\n`;

const clientCourses = `${header('Course presentation (ids, order, icons, levels, badges, i18n keys); structure mirrors server/learning/catalog.generated.js.')}export const GENERATED_COURSES = [\n${courses.map((c) => {
    put(`learn.course.${c.id.replace(/^course-/, '')}.title`, c.title); put(`learn.course.${c.id.replace(/^course-/, '')}.desc`, c.desc); put(`learn.badge.${c.badge.id.replace(/^badge-/, '')}`, c.badge.title);
    const slug = c.id.replace(/^course-/, '');
    return `    {\n        id: ${js(c.id)}, pathId: ${js(c.pathId)},\n        titleKey: ${js(`learn.course.${slug}.title`)}, titleFallback: ${js(c.title)},\n        descKey: ${js(`learn.course.${slug}.desc`)}, descFallback: ${js(c.desc)},\n        icon: ${js(c.icon)}, level: ${js(c.level)}, track: ${js(c.track)},\n        lessonIds: ${js(c.lessons.map((l) => l.id))},\n        prereqCourseIds: ${js(c.prereqCourseIds || [])},\n        badge: { id: ${js(c.badge.id)}, icon: ${js(c.badge.icon)}, titleKey: ${js(`learn.badge.${c.badge.id.replace(/^badge-/, '')}`)}, titleFallback: ${js(c.badge.title)}, descFallback: ${js(c.badge.desc)} },\n    },`;
}).join('\n')}\n];\n`;

// The server merges LEGACY_PRACTICE_TOPICS (hand-written lessons that survive,
// e.g. effective-prompts) over the generated ones, so the client mirror must
// carry those ids too or catalogLockstep fails.
const HANDWRITTEN_PRACTICE_IDS = ['effective-prompts'];
const pathOrder = { everyday: [], builder: [], admin: [] };
for (const c of courses) if (pathOrder[c.pathId]) pathOrder[c.pathId].push(c.id);
const clientPaths = `${header('Which courses each learning path orders first — derived from every course\'s pathId, so a new course is never stranded in the unclaimed column.')}export const GENERATED_PATH_ORDER = ${JSON.stringify(pathOrder, null, 4)};\n`;

const clientPractice = `${header('Which lessons the AI practice generator accepts — mirror of the server registry.')}export const GENERATED_PRACTICE_LESSON_IDS = ${js([...Object.keys(practiceTopics), ...HANDWRITTEN_PRACTICE_IDS])};\n`;

// ActionStep renders t(labelKey, labelFallback), so every criterion gets a key
// and its English lands in the dictionary — without them the checklist copy
// would be permanently untranslatable.
const clientChecks = `${header('New verified-action checks declared by lessons. A criterion is checked ONLY through its authored `expect` (rows / truthy / nonEmpty / equals); one without `expect` is unverifiable and never passes — see AUTHORING-SPEC.md. Author the expectation in the lesson JSON, never in this file.')}export const GENERATED_ACTION_CHECKS = ${JSON.stringify(Object.fromEntries([...newChecks].map(([id, ck]) => [id, {
    criteria: ck.criteria.map((cr, i) => {
        // `rule` stays in the authored JSON as metadata for humans; it never
        // reaches the client, where untranslatable English would be a bundle leak.
        const lk = key('check', id, cr.id, 'label');
        const hk = key('check', id, cr.id, 'hint');
        put(lk, cr.label); put(hk, cr.hint);
        return { id: cr.id, labelKey: lk, labelFallback: cr.label, hintKey: hk, hintFallback: cr.hint, endpoint: cr.endpoint || (ck.endpoints[i] || ck.endpoints[0]).path, expect: cr.expect || undefined, gate: cr.gate || undefined };
    }),
}])), null, 4)};\n`;

// ── Server catalog ─────────────────────────────────────────────────────────
const serverCourses = courses.map((c) => ({ id: c.id, track: c.track, title: c.title, lessonIds: c.lessons.map((l) => l.id), prereqCourseIds: c.prereqCourseIds || [], badge: { id: c.badge.id, title: c.badge.title } }));
const lessonIds = ['getting-started', 'effective-prompts', ...courses.flatMap((c) => c.lessons.map((l) => l.id)).filter((id) => !HANDWRITTEN.has(id))];
const serverGen = `${header('Structure (courses, gates, ids), rubrics and practice topics — the server is the authority for all of these.')}'use strict';\n\nconst COURSES = ${JSON.stringify(serverCourses, null, 4)};\n\nconst LESSON_GATES = ${JSON.stringify(lessonGates, null, 4)};\n\nconst LESSON_IDS = ${JSON.stringify(lessonIds, null, 4)};\n\nconst EXERCISE_LESSONS = ${JSON.stringify(exerciseLessons, null, 4)};\n\nconst RUBRICS = ${JSON.stringify(rubrics, null, 4)};\n\nconst PRACTICE_TOPICS = ${JSON.stringify(practiceTopics, null, 4)};\n\nmodule.exports = { COURSES, LESSON_GATES, LESSON_IDS, EXERCISE_LESSONS, RUBRICS, PRACTICE_TOPICS };\n`;

// ── Dictionaries ───────────────────────────────────────────────────────────
const BEGIN = '// <learning-generated>';
const END = '// </learning-generated>';
function rewriteDict(file, render, insertBefore) {
    let src = fs.readFileSync(file, 'utf8');
    // strip a previous generated block
    const b = src.indexOf(BEGIN);
    if (b !== -1) { const e = src.indexOf(END, b); src = src.slice(0, b) + src.slice(e + END.length + 1); }
    // strip hand-written lines for keys the generator owns
    const owned = new Set(dict.keys());
    src = src.split('\n').filter((line) => {
        const m = line.match(/^\s+(['"])(learn\.[^'"]+)\1\s*:/);
        return !(m && owned.has(m[2]));
    }).join('\n');
    const block = `${BEGIN}\n${[...dict].map(([k, v]) => `    ${render(k, v)},`).join('\n')}\n${END}\n`;
    const at = src.lastIndexOf(insertBefore);
    if (at === -1) throw new Error(`anchor not found in ${file}`);
    src = src.slice(0, at) + block + src.slice(at);
    return src;
}
// Single-quoted JS string, fully escaped. Lesson bodies are markdown with real
// newlines in them — emitting those raw produced an unparseable dictionary.
const q1 = (v) => `'${String(v)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')}'`;
// Every generated key lives in the `learn` namespace, i.e. in learn.js — a key
// outside it would be filed under the wrong namespace and en/index.js throws.
for (const k of dict.keys()) if (!k.startsWith('learn.')) problems.push(`generated key ${k} is outside the learn namespace`);
// The block goes right before the closing `};` of learn.js's module.exports.
const serverDict = rewriteDict(EN_SERVER, (k, v) => `${q1(k)}: ${q1(v)}`, '};\n');

if (problems.length) { console.error('PROBLEMS:\n' + problems.join('\n')); process.exit(1); }
// How much of the hands-on checking is real: a criterion is only checkable when
// the lesson authored an `expect` for it. Printed so a curriculum edit that
// silently drops one is visible in the check run rather than in the product.
const allCriteria = [...newChecks.values()].flatMap((ck) => ck.criteria || []);
const verifiable = allCriteria.filter((cr) => cr.expect && ['rows', 'truthy', 'nonEmpty', 'equals'].includes(cr.expect.kind));
const coverage = `${verifiable.length}/${allCriteria.length} criteria verifiable`;
if (checkOnly) { console.log(`OK (check): ${courses.length} courses, ${lessonBlocks.length} lessons, ${Object.keys(rubrics).length} rubrics, ${Object.keys(practiceTopics).length} practice topics, ${newChecks.size} new checks (${coverage}), ${dict.size} keys`); process.exit(0); }

fs.mkdirSync(CLIENT_GEN, { recursive: true });
fs.writeFileSync(path.join(CLIENT_GEN, 'lessons.js'), clientLessons);
fs.writeFileSync(path.join(CLIENT_GEN, 'courses.js'), clientCourses);
fs.writeFileSync(path.join(CLIENT_GEN, 'practiceLessonIds.js'), clientPractice);
    fs.writeFileSync(path.join(CLIENT_GEN, 'pathOrder.js'), clientPaths);
fs.writeFileSync(path.join(CLIENT_GEN, 'actionChecks.js'), clientChecks);
fs.writeFileSync(SERVER_GEN, serverGen);
fs.writeFileSync(EN_SERVER, serverDict);
// The frontend dictionary is generated from the server's; never written here.
execFileSync(process.execPath, [GEN_DEFAULTS], { cwd: REPO, stdio: 'inherit' });
console.log(`Wrote ${courses.length} courses, ${lessonBlocks.length} lessons, ${Object.keys(rubrics).length} rubrics, ${Object.keys(practiceTopics).length} practice topics, ${newChecks.size} new checks, ${dict.size} dictionary keys`);
