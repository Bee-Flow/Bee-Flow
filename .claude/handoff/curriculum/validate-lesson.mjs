#!/usr/bin/env node
// Validates one lesson JSON against AUTHORING-SPEC.md. Usage: node validate-lesson.mjs <file.json>
// Exit 0 = valid (prints "OK <id> <n> steps"), exit 1 = problems listed one per line.
import fs from 'node:fs';

const KNOWN_TARGETS = new Set([
    '[data-tour="nav-new-chat"]', '[data-tour="nav-cowork"]', '[data-tour="nav-studio"]', '[data-tour="nav-agents"]', '[data-tour="account"]',
    '[data-testid="settings-nav-preferences"]', '[data-tour="chat-composer"]', '[data-tour="agent-wizard-prompt"]', '[data-tour="agent-system-prompt"]',
    '[data-tour="agent-tools"]', '[data-tour="agent-knowledge"]', '[data-tour="skill-create"]', '[data-tour="knowledge-create"]', '[data-tour="integration-card"]',
    '[data-tour="memory-manage"]', '[data-tour="automation-create"]', '[data-tour="usage-summary"]', '[data-tour="automation-start-tabs"]', '[data-tour="automation-building-blocks"]',
    '[data-tour="cowork-composer"]', '[data-tour="cowork-options"]',
]);
const NAV_RX = /^(agents|agentWizard|cowork|apps|forms|studio\/(agents|skills|knowledge|automations|approvals|datatables|webpages|apps|forms|playbooks|solutions|runs|meetingNotes)|settings\/(memory|integrations|preferences|security|appearance)|settings\/organisation\/(privacy|encryption|info|usage|compliance|users|academy|integrations|nextcloud-sync|meeting-templates|azure|auth|license))$/;
const EXISTING_CHECKS = new Set(['automation-first', 'cowork-first', 'agent-created', 'kb-with-doc', 'hive-master']);
const KINDS = new Set(['slide', 'quiz', 'exercise', 'sim', 'action', 'tour']);
const INTERACTIVE = new Set(['quiz', 'exercise', 'sim', 'action']);
const PURPLE_RX = /purple|violet|#8b5cf6|#a855f7|#7c3aed|#6d28d9|indigo/i;

const file = process.argv[2];
const errs = [];
const err = (m) => errs.push(m);
let doc;
try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.log(`PARSE ERROR: ${e.message}`); process.exit(1); }

const str = (v, path, min = 1, max = 4000) => {
    if (typeof v !== 'string' || v.trim().length < min) err(`${path}: missing or too short`);
    else if (v.length > max) err(`${path}: too long (${v.length} > ${max})`);
};

if (!/^[a-z0-9-]{4,40}$/.test(doc.id || '')) err('id: must match ^[a-z0-9-]{4,40}$');
str(doc.icon, 'icon', 1, 8);
if (!Number.isFinite(doc.estMinutes) || doc.estMinutes < 3 || doc.estMinutes > 30) err('estMinutes: 3..30');
str(doc.title, 'title', 4, 80);
str(doc.desc, 'desc', 10, 200);
str(doc.learningGoal, 'learningGoal', 10, 300);
if (doc.gate && typeof doc.gate !== 'object') err('gate: object');
if (doc.gate?.permission && !(typeof doc.gate.permission === 'string' || Array.isArray(doc.gate.permission))) err('gate.permission: string or array');
if (doc.gate?.permissionsAll && !Array.isArray(doc.gate.permissionsAll)) err('gate.permissionsAll: array');
if (Array.isArray(doc.gate?.permissionsAll)) {
    if (doc.gate.permissionsAll.length < 2) err('gate.permissionsAll: needs 2+ permissions — use `permission` for one');
    if (doc.gate.permissionsAll.some((p) => typeof p !== 'string')) err('gate.permissionsAll: array of strings');
}
if (doc.gate?.feature && !(typeof doc.gate.feature === 'string' || Array.isArray(doc.gate.feature))) err('gate.feature: string or array');
// A feature list is ALL-of: every capability named has to be in the plan. Spelling
// one twice is harmless but always a mistake, so it is loud.
if (Array.isArray(doc.gate?.feature)) {
    if (!doc.gate.feature.length) err('gate.feature: empty array — omit it instead');
    if (doc.gate.feature.some((f) => typeof f !== 'string')) err('gate.feature: array of strings');
    if (new Set(doc.gate.feature).size !== doc.gate.feature.length) err('gate.feature: duplicate capability');
}

const steps = Array.isArray(doc.steps) ? doc.steps : [];
if (steps.length < 8 || steps.length > 24) err(`steps: ${steps.length} (need 8..24)`);
const ids = new Set();
const kinds = [];
let interactions = 0;
const exerciseIds = [];
const newChecks = new Map((doc.actionChecks || []).map((c) => [c.checkId, c]));
let hasQuiz = false;

steps.forEach((s, i) => {
    const p = `steps[${i}]`;
    if (!KINDS.has(s.type)) { err(`${p}: unknown type ${s.type}`); return; }
    kinds.push(s.type);
    if (!/^[a-z0-9-]{2,24}$/.test(s.id || '')) err(`${p}.id: ^[a-z0-9-]{2,24}$`);
    if (ids.has(s.id)) err(`${p}.id: duplicate ${s.id}`);
    ids.add(s.id);
    if (INTERACTIVE.has(s.type)) interactions += 1;
    if (s.type !== 'tour' && s.type !== 'quiz') str(s.icon, `${p}.icon`, 1, 8);
    const textFields = [];
    switch (s.type) {
        case 'slide':
            str(s.title, `${p}.title`, 4, 90); str(s.bodyMd, `${p}.bodyMd`, 40, 1600);
            textFields.push(s.title, s.bodyMd);
            if (s.bodyMd && s.bodyMd.split(/\s+/).length > 220) err(`${p}.bodyMd: over 220 words — split the card`);
            break;
        case 'quiz': {
            hasQuiz = true;
            str(s.question, `${p}.question`, 10, 300);
            const ch = Array.isArray(s.choices) ? s.choices : [];
            if (ch.length < 3 || ch.length > 5) err(`${p}.choices: 3..5`);
            const correct = ch.filter((c) => c.correct).length;
            if (s.multi ? correct < 2 : correct !== 1) err(`${p}: ${s.multi ? '≥2' : 'exactly 1'} correct choice required (have ${correct})`);
            const cids = new Set();
            ch.forEach((c, j) => {
                if (!/^[a-z]$/.test(c.id || '')) err(`${p}.choices[${j}].id: single letter`);
                if (cids.has(c.id)) err(`${p}.choices[${j}].id duplicate`); cids.add(c.id);
                str(c.label, `${p}.choices[${j}].label`, 2, 240);
                if (!c.correct && !(typeof c.feedback === 'string' && c.feedback.length > 10)) err(`${p}.choices[${j}]: wrong choice needs feedback`);
                if (/all of the above/i.test(c.label || '')) err(`${p}.choices[${j}]: no "all of the above"`);
                textFields.push(c.label, c.feedback);
            });
            str(s.explanation, `${p}.explanation`, 10, 500);
            textFields.push(s.question, s.explanation);
            break;
        }
        case 'exercise':
            if (!/^ex-[a-z0-9-]{4,50}$/.test(s.exerciseId || '')) err(`${p}.exerciseId: ^ex-[a-z0-9-]+$`);
            exerciseIds.push(s.exerciseId);
            str(s.title, `${p}.title`, 4, 90); str(s.instruction, `${p}.instruction`, 30, 900); str(s.placeholder, `${p}.placeholder`, 10, 500);
            if (!(s.passScore >= 50 && s.passScore <= 90)) err(`${p}.passScore: 50..90`);
            if (!(s.maxAttempts >= 2 && s.maxAttempts <= 6)) err(`${p}.maxAttempts: 2..6`);
            textFields.push(s.title, s.instruction, s.placeholder);
            break;
        case 'sim': {
            str(s.title, `${p}.title`, 4, 90); str(s.instruction, `${p}.instruction`, 10, 400);
            const sim = s.sim || {};
            textFields.push(s.title, s.instruction);
            if (sim.kind === 'match') {
                const pairs = Array.isArray(sim.pairs) ? sim.pairs : [];
                if (pairs.length < 3 || pairs.length > 6) err(`${p}.sim.pairs: 3..6`);
                const pid = new Set();
                pairs.forEach((pr, j) => {
                    if (!pr.id || pid.has(pr.id)) err(`${p}.sim.pairs[${j}].id missing/duplicate`); pid.add(pr.id);
                    str(pr.left, `${p}.sim.pairs[${j}].left`, 3, 200); str(pr.right, `${p}.sim.pairs[${j}].right`, 2, 120);
                    textFields.push(pr.left, pr.right, pr.note);
                });
                const rights = new Set(pairs.map((x) => x.right)); if (rights.size !== pairs.length) err(`${p}.sim: right-hand labels must be distinct`);
            } else if (sim.kind === 'order') {
                const items = Array.isArray(sim.items) ? sim.items : [];
                if (items.length < 3 || items.length > 7) err(`${p}.sim.items: 3..7`);
                const iid = items.map((x) => x.id);
                if (!Array.isArray(sim.solution) || sim.solution.length !== items.length || [...sim.solution].sort().join() !== [...iid].sort().join()) err(`${p}.sim.solution must be a permutation of item ids`);
                items.forEach((it, j) => { str(it.label, `${p}.sim.items[${j}].label`, 3, 200); textFields.push(it.label); });
                str(sim.feedback, `${p}.sim.feedback`, 10, 400); textFields.push(sim.feedback);
            } else if (sim.kind === 'flow-build') {
                const sc = Array.isArray(sim.scenarios) ? sim.scenarios : [];
                if (sc.length < 1 || sc.length > 4) err(`${p}.sim.scenarios: 1..4`);
                sc.forEach((x, j) => {
                    const q = `${p}.sim.scenarios[${j}]`;
                    str(x.brief, `${q}.brief`, 20, 500); textFields.push(x.brief);
                    const opts = x.trigger?.options || [];
                    if (opts.length < 3) err(`${q}.trigger.options: ≥3`);
                    if (!opts.some((o) => o.id === x.trigger?.correct)) err(`${q}.trigger.correct not in options`);
                    opts.filter((o) => o.id !== x.trigger.correct).forEach((o) => { if (!x.trigger.feedback?.[o.id]) err(`${q}.trigger.feedback missing for ${o.id}`); });
                    const pal = x.steps?.palette || [];
                    const sol = x.steps?.solution || [];
                    if (pal.length < 3) err(`${q}.steps.palette: ≥3`);
                    if (sol.length < 2) err(`${q}.steps.solution: ≥2`);
                    sol.forEach((id) => { if (!pal.some((o) => o.id === id)) err(`${q}.steps.solution has unknown ${id}`); });
                    pal.filter((o) => !sol.includes(o.id)).forEach((o) => { if (!x.steps.feedback?.[o.id]) err(`${q}.steps.feedback missing for distractor ${o.id}`); });
                });
            } else err(`${p}.sim.kind: match|order|flow-build`);
            break;
        }
        case 'action':
            if (!EXISTING_CHECKS.has(s.checkId) && !newChecks.has(s.checkId)) err(`${p}.checkId ${s.checkId}: not an existing check and not declared in actionChecks`);
            str(s.title, `${p}.title`, 4, 90); str(s.instruction, `${p}.instruction`, 30, 600);
            if (!s.launch || !NAV_RX.test(s.launch.navigateTo || '')) err(`${p}.launch.navigateTo invalid (${s.launch?.navigateTo})`);
            str(s.launch?.label, `${p}.launch.label`, 3, 40);
            textFields.push(s.title, s.instruction);
            break;
        case 'tour':
            if (!KNOWN_TARGETS.has(s.target)) err(`${p}.target not a registered anchor: ${s.target}`);
            if (s.optional !== true) err(`${p}.optional must be true`);
            if (!(s.timeoutMs >= 4000 && s.timeoutMs <= 10000)) err(`${p}.timeoutMs 4000..10000`);
            if (s.navigateTo && !NAV_RX.test(s.navigateTo)) err(`${p}.navigateTo invalid`);
            if (!['top', 'bottom', 'left', 'right', 'center'].includes(s.placement || 'bottom')) err(`${p}.placement`);
            str(s.title, `${p}.title`, 4, 90); str(s.body, `${p}.body`, 10, 400);
            textFields.push(s.title, s.body);
            break;
        default:
    }
    textFields.filter(Boolean).forEach((tf) => {
        if (PURPLE_RX.test(tf)) err(`${p}: no purple/indigo/violet in copy`);
        if (/\/home\/|agent-hub\/src|server\//.test(tf)) err(`${p}: internal file path in learner-facing text`);
        // n8n is NOT a competitor here: it is a shipped Bee Flow integration whose row,
        // sub-line and field are literally labelled "n8n" on screen, so lessons must name it.
        if (/\b(ChatGPT|Copilot|Gemini|Notion|Zapier|Make\.com)\b/.test(tf)) err(`${p}: competitor product named`);
    });
});

if (kinds[0] === 'quiz') err('first step must not be a quiz');
if (new Set(kinds).size < 3) err(`only ${new Set(kinds).size} step kinds — need ≥3`);
if (interactions < 3) err(`only ${interactions} interaction points — need ≥3 (quiz/exercise/sim/action)`);
for (let i = 2; i < kinds.length; i += 1) if (kinds[i] === kinds[i - 1] && kinds[i] === kinds[i - 2] && kinds[i] !== 'slide') err(`three ${kinds[i]} steps in a row at ${i}`);
for (let i = 3; i < kinds.length; i += 1) if (kinds.slice(i - 3, i + 1).every((k) => k === 'slide')) err(`four slides in a row at ${i} — add an interaction`);
const last = kinds[kinds.length - 1];
if (!(INTERACTIVE.has(last) || last === 'slide')) err('last step should be a check or a summary slide');

const rubrics = doc.rubrics || {};
exerciseIds.forEach((id) => {
    const r = rubrics[id];
    if (!r) { err(`rubrics.${id} missing`); return; }
    str(r.title, `rubrics.${id}.title`, 4, 80); str(r.task, `rubrics.${id}.task`, 20, 600);
    if (!Array.isArray(r.criteria) || r.criteria.length < 3 || r.criteria.length > 5) err(`rubrics.${id}.criteria: 3..5`);
    if (!(r.passScore >= 50 && r.passScore <= 90)) err(`rubrics.${id}.passScore 50..90`);
    str(r.guidance, `rubrics.${id}.guidance`, 20, 600);
});
Object.keys(rubrics).forEach((id) => { if (!exerciseIds.includes(id)) err(`rubrics.${id}: no exercise step uses it`); });

if (hasQuiz) {
    const pt = doc.practiceTopic;
    if (!pt) err('practiceTopic required (lesson has quizzes)');
    else {
        str(pt.title, 'practiceTopic.title', 4, 80); str(pt.summary, 'practiceTopic.summary', 20, 300);
        if (!Array.isArray(pt.facts) || pt.facts.length < 4 || pt.facts.length > 8) err('practiceTopic.facts: 4..8');
        (pt.facts || []).forEach((f, j) => str(f, `practiceTopic.facts[${j}]`, 20, 300));
    }
}
(doc.actionChecks || []).forEach((c, j) => {
    if (!/^[a-z0-9-]{4,40}$/.test(c.checkId || '')) err(`actionChecks[${j}].checkId`);
    if (EXISTING_CHECKS.has(c.checkId)) err(`actionChecks[${j}]: ${c.checkId} already exists — do not redeclare`);
    if (!Array.isArray(c.endpoints) || !c.endpoints.length) err(`actionChecks[${j}].endpoints required`);
    (c.endpoints || []).forEach((e, k) => { if (!/^\/(api\/)?[a-z0-9/_:-]+$/.test(e.path || '')) err(`actionChecks[${j}].endpoints[${k}].path`); });
    if (!Array.isArray(c.criteria) || !c.criteria.length || c.criteria.length > 4) err(`actionChecks[${j}].criteria 1..4`);
    (c.criteria || []).forEach((cr, k) => {
        const q = `actionChecks[${j}].criteria[${k}]`;
        str(cr.label, `${q}.label`, 5, 120); str(cr.hint, `${q}.hint`, 10, 240); str(cr.rule, `${q}.rule`, 5, 240);
        // A criterion may narrow its GET with a query string — `?mode=dry_run`
        // is what turns "a run exists" into "a DRY run exists", which is the
        // difference between a checklist line the product can prove and one it
        // cannot. Only the safe URL characters, and never a fragment.
        if (cr.endpoint && !/^\/(api\/)?[a-zA-Z0-9/_:.-]+(\?[a-zA-Z0-9_=&,%.:-]+)?$/.test(cr.endpoint)) err(`${q}.endpoint invalid`);
        if (cr.expect) {
            if (!['rows', 'truthy', 'nonEmpty', 'equals'].includes(cr.expect.kind)) err(`${q}.expect.kind must be rows|truthy|nonEmpty|equals`);
            if (cr.expect.kind !== 'rows' && !cr.expect.field) err(`${q}.expect.field required for kind ${cr.expect.kind}`);
            if (cr.expect.kind === 'equals' && cr.expect.value === undefined) err(`${q}.expect.value required for kind equals`);
        }
    });
});

if (errs.length) { console.log(errs.join('\n')); process.exit(1); }
console.log(`OK ${doc.id} ${steps.length} steps · ${interactions} interactions · kinds ${[...new Set(kinds)].join(',')}`);
