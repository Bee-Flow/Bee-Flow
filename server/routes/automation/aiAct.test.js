/**
 * routes/automation/aiAct: the routine's own AI Act check and its readiness
 * checklist. The router is built with injected stores, licence, signals and
 * fast-model verdict (makeAiActRouter); no module mocking.
 *
 * Run: cd server && node --test routes/automation/aiAct.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { makeAiActRouter } = require('./aiAct');
const { createTerminalErrorHandler } = require('../../core/http/terminalErrorHandler');
const { validateDefinition } = require('../../automation/validate');

const NOW = Date.parse('2026-09-28T10:00:00Z');
const NO_AI = { trigger: { id: 't1', kind: 'manual' }, steps: [{ id: 's1', type: 'wait', seconds: 1 }], edges: [{ from: 't1', to: 's1' }] };
const WITH_AI = {
    trigger: { id: 't1', kind: 'manual' },
    steps: [
        { id: 'a', type: 'ai_step', label: 'Draft reply', prompt: 'Write a reply', outputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
        { id: 'm', type: 'integration_action', tool: 'gmail_compose', label: 'Send reply', inputs: { to: '{{trigger.output.from}}', subject: 'Re', body: '{{steps.a.output.text}}' } },
    ],
    edges: [{ from: 't1', to: 'a' }, { from: 'a', to: 'm' }],
};

const state = {};
function reset() {
    state.automations = {
        a1: { id: 'a1', userId: 'owner', organizationId: 'org-1', title: 'Replies', description: '', version: 5, definition: WITH_AI },
        a2: { id: 'a2', userId: 'owner', organizationId: 'org-1', title: 'Tidy', description: 'Moves files.', version: 2, definition: NO_AI },
    };
    state.users = {
        owner: { id: 'owner', organizationId: 'org-1', email: 'owner@acme.nl' },
        editor: { id: 'editor', organizationId: 'org-1' },
        viewer: { id: 'viewer', organizationId: 'org-1' },
        stranger: { id: 'stranger', organizationId: 'org-1' },
    };
    state.shares = { a1: [{ principalType: 'user', principalId: 'editor', role: 'edit' }, { principalType: 'user', principalId: 'viewer', role: 'view' }] };
    state.runs = { a2: [{ id: 'r1', isTest: true, status: 'success', finishedAt: '2026-09-28T09:49:00Z', version: 2 }] };
    state.rows = [];
    state.attests = [];
    state.required = true;
    // The fast model: unreachable unless a test says otherwise.
    state.verdict = { available: false };
    state.classifyCalls = 0;
}

const SURE_NO = {
    available: true, modelId: 'fast-model',
    prohibited: { answer: 'no', confidence: 'high', practices: [] },
    highRisk: { answer: 'no', confidence: 'high', domains: [] },
};

function attestDouble(input) {
    state.attests.push(input);
    const assess = require('../../compliance/aiAct/assess');
    const result = assess.assess(input.signals, input.answers, { attestedAt: new Date(NOW) });
    const row = {
        organization_id: input.orgId, target_kind: input.kind, target_id: input.id,
        signals: input.signals, answers: result.answers, outcome: result.outcome, attested_by: input.actorId,
        attested_at: new Date(NOW).toISOString(),
        expires_at: input.validMonths ? assess.expiresAt(new Date(NOW), input.validMonths).toISOString() : result.expires_at,
        source: input.source || null,
        evidence: input.evidence || null,
    };
    state.rows.push(row);
    return Promise.resolve({ row, result });
}

const router = makeAiActRouter({
    store: {
        getAutomation: async (id) => state.automations[id] || null,
        listSharesForAutomation: async (id) => state.shares[id] || [],
        getRunsForAutomation: async (id) => state.runs[id] || [],
    },
    getUser: async (id) => state.users[id] || null,
    hasPermission: async () => false,
    assessments: {
        getLatest: async (orgId, kind, id) => [...state.rows].reverse().find(r => r.organization_id === orgId && r.target_id === id) || null,
    },
    isRequired: async () => state.required,
    liveSignals: async (orgId, id) => {
        const a = state.automations[id];
        return require('../../compliance/aiAct/signals').signalsFromDefinition(a.definition, { title: a.title });
    },
    attest: attestDouble,
    classify: async ({ hash }) => { state.classifyCalls++; return { ...state.verdict, hash }; },
    loadBlocks: async () => null,
    validateDefinition: (def) => validateDefinition(def),
    now: () => NOW,
});

let currentUser = 'owner';
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.session = { user: { id: currentUser } }; next(); });
app.use('/api/automation', router);
app.use(createTerminalErrorHandler({ log: { error() {}, warn() {}, info() {} } }));

let server;
let base;
test.before(async () => {
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}/api/automation`;
});
test.after(() => server && server.close());

async function call(method, path, body, user = 'owner') {
    currentUser = user;
    const res = await fetch(base + path, {
        method,
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
}

test('GET /:id/ai-act: never checked is "missing"; 404 unknown; 403 for someone without a share', async () => {
    reset();
    const r = await call('GET', '/a1/ai-act');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json, {
        required: true, status: 'missing', expiresAt: null, outcome: null, attestedAt: null, attestedBy: null, source: null,
        answers: null, openDuties: [], canEdit: true,
    });
    assert.strictEqual((await call('GET', '/nope/ai-act')).status, 404);
    const f = await call('GET', '/a1/ai-act', null, 'stranger');
    assert.strictEqual(f.status, 403);
    assert.strictEqual(f.json.code, 'automation_forbidden');
    const v = await call('GET', '/a1/ai-act', null, 'viewer');
    assert.strictEqual(v.status, 200);
    assert.strictEqual(v.json.canEdit, false);
});

test('without the licence everything says required:false and a PUT is refused', async () => {
    reset();
    state.required = false;
    assert.strictEqual((await call('GET', '/a1/ai-act')).json.status, 'not_required');
    assert.strictEqual((await call('GET', '/a1/ai-act/suggestion')).json.required, false);
    const r = await call('PUT', '/a1/ai-act', { usesAi: 'yes', externalOutput: 'yes', sensitiveUse: 'no' });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.json.code, 'ai_act_not_available');
    const ready = await call('GET', '/a1/readiness');
    assert.strictEqual(ready.json.aiAct.required, false);
    assert.strictEqual(ready.json.aiAct.status, 'not_required');
});

test('GET /:id/ai-act/suggestion: AI and an outside mail are suggested, question 3 is open', async () => {
    reset();
    const r = await call('GET', '/a1/ai-act/suggestion');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.required, true);
    const [q1, q2, q3] = r.json.questions;
    assert.strictEqual(q1.id, 'usesAi');
    assert.strictEqual(q1.suggested, 'yes');
    assert.deepStrictEqual(q1.reasons[0].params.steps.map(s => s.stepId), ['a']);
    assert.strictEqual(q2.suggested, 'yes');
    assert.strictEqual(q2.reasons[0].code, 'ai_act.external.email');
    assert.strictEqual(q3.suggested, null);
    assert.strictEqual(q3.domains.length, 10);
    assert.strictEqual(r.json.suggestedOutcome, 'transparency');
    assert.strictEqual(r.json.previous, null);
});

test('PUT /:id/ai-act: an editor records the check; the answer is the new state, valid for 12 months', async () => {
    reset();
    const r = await call('PUT', '/a1/ai-act', { usesAi: 'yes', externalOutput: 'yes', sensitiveUse: 'no' }, 'editor');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.status, 'valid');
    assert.strictEqual(r.json.outcome, 'transparency');
    assert.strictEqual(r.json.expiresAt, '2027-09-28T10:00:00.000Z');
    assert.strictEqual(r.json.attestedBy, 'editor');
    assert.deepStrictEqual(r.json.answers, { usesAi: 'yes', externalOutput: 'yes', sensitiveUse: 'no', domains: [] });
    assert.deepStrictEqual(r.json.openDuties, ['art50_1_disclosure']);
    const a = state.attests[0];
    assert.strictEqual(a.kind, 'automation');
    assert.strictEqual(a.id, 'a1');
    assert.strictEqual(a.orgId, 'org-1');
    assert.strictEqual(a.validMonths, 12);

    const again = await call('GET', '/a1/ai-act/suggestion');
    assert.deepStrictEqual(again.json.previous, { usesAi: 'yes', externalOutput: 'yes', sensitiveUse: 'no', domains: [] });
});

test('PUT: a viewer may not; a bad body is a 400 with a code', async () => {
    reset();
    const v = await call('PUT', '/a1/ai-act', { usesAi: 'yes', externalOutput: 'no', sensitiveUse: 'no' }, 'viewer');
    assert.strictEqual(v.status, 403);
    assert.strictEqual(v.json.need, 'edit');
    const bad = await call('PUT', '/a1/ai-act', { usesAi: 'yes', externalOutput: 'no', sensitiveUse: 'yes' });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.json.code, 'ai_act.domain_required');
    assert.strictEqual(state.attests.length, 0);
});

test('PUT on a routine without AI records "not applicable", also valid for 12 months', async () => {
    reset();
    const r = await call('PUT', '/a2/ai-act', { usesAi: 'no', externalOutput: 'no', sensitiveUse: 'unknown' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.outcome, 'not_applicable');
    assert.strictEqual(r.json.status, 'valid');
    assert.strictEqual(r.json.expiresAt, '2027-09-28T10:00:00.000Z');
});

test('PUT: "uses AI: yes" on a routine where Bee saw none widens the signals', async () => {
    reset();
    const r = await call('PUT', '/a2/ai-act', { usesAi: 'yes', externalOutput: 'no', sensitiveUse: 'no' });
    assert.strictEqual(r.json.outcome, 'minimal');
    assert.strictEqual(state.attests[0].signals.contains_ai, true);
});

test('GET /:id/readiness: the checklist, before and after the check', async () => {
    reset();
    const before = await call('GET', '/a2/readiness');
    assert.strictEqual(before.status, 200);
    assert.deepStrictEqual(before.json, {
        version: 2,
        stepsComplete: { ok: true, issues: 0, firstIssue: null },
        lastTest: { ok: true, at: '2026-09-28T09:49:00Z', runId: 'r1', status: 'success', version: 2 },
        aiAct: { required: true, status: 'missing', expiresAt: null, outcome: null, attestedAt: null },
        description: { ok: true },
        canActivate: false,
    });
    await call('PUT', '/a2/ai-act', { usesAi: 'no', externalOutput: 'no', sensitiveUse: 'unknown' });
    const after = await call('GET', '/a2/readiness');
    assert.strictEqual(after.json.aiAct.status, 'valid');
    assert.strictEqual(after.json.canActivate, true);
    assert.strictEqual((await call('GET', '/a1/readiness', null, 'stranger')).status, 403);
    assert.strictEqual((await call('GET', '/a1/readiness', null, 'viewer')).status, 200);
});

// ── The automatic check ─────────────────────────────────────────────────────

test('GET /:id/ai-act/check: a routine without AI is checked and recorded by Bee alone, without asking the model', async () => {
    reset();
    const r = await call('GET', '/a2/ai-act/check');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.recorded, true);
    assert.strictEqual(r.json.status, 'valid');
    assert.strictEqual(r.json.outcome, 'not_applicable');
    assert.strictEqual(r.json.source, 'auto');
    assert.strictEqual(r.json.attestedBy, 'bee');
    assert.strictEqual(r.json.expiresAt, '2027-09-28T10:00:00.000Z');
    assert.deepStrictEqual(r.json.questions, []);
    assert.deepStrictEqual(r.json.findings.map(f => [f.id, f.answer, f.confidence, f.by]), [['usesAi', 'no', 'certain', 'bee']]);
    assert.strictEqual(state.classifyCalls, 0);
    // Looking again changes nothing.
    const again = await call('GET', '/a2/ai-act/check');
    assert.strictEqual(again.json.recorded, false);
    assert.strictEqual(state.attests.length, 1);
});

test('GET /:id/ai-act/check: only what Bee cannot tell is asked; a person\'s answer records the rest (mixed)', async () => {
    reset();
    state.verdict = SURE_NO;
    const r = await call('GET', '/a1/ai-act/check');
    assert.strictEqual(r.json.recorded, false);
    assert.strictEqual(r.json.status, 'missing');
    // The reply goes to a templated address: AI output, recipient unknown.
    assert.deepStrictEqual(r.json.questions.map(q => [q.id, q.confidence, q.suggested]), [['externalOutput', 'likely', 'yes']]);
    assert.strictEqual(r.json.questions[0].evidence[0].code, 'ai_act.external.email');
    assert.strictEqual(r.json.questions[0].evidence[1].code, 'ai_act.external.ai_flows');
    assert.ok(r.json.questions[0].evidence.every(e => typeof e.text === 'string' && e.text));
    assert.deepStrictEqual(r.json.findings.map(f => [f.id, f.answer, f.by]).sort(), [['prohibitedUse', 'no', 'bee'], ['sensitiveUse', 'no', 'bee'], ['usesAi', 'yes', 'bee']]);
    assert.strictEqual(state.attests.length, 0);

    const put = await call('PUT', '/a1/ai-act/answers', { externalOutput: 'yes' }, 'editor');
    assert.strictEqual(put.status, 200);
    assert.strictEqual(put.json.recorded, true);
    assert.strictEqual(put.json.status, 'valid');
    assert.strictEqual(put.json.source, 'mixed');
    assert.strictEqual(put.json.attestedBy, 'editor');
    assert.strictEqual(put.json.outcome, 'transparency');
    assert.deepStrictEqual(put.json.questions, []);
    const rec = state.attests[0];
    assert.strictEqual(rec.answers.art50.interacts, 'yes');
    assert.strictEqual(rec.answers.art5.answer, 'no');
    assert.strictEqual(rec.answers.annex_iii.answer, 'no');
    assert.strictEqual(rec.evidence.questions.externalOutput.by, 'person');
    assert.strictEqual(rec.evidence.questions.sensitiveUse.by, 'bee');
    assert.ok(!JSON.stringify(rec.evidence).includes('trigger.output.from'), 'no recipient in the evidence');

    // The answer stands on the next look, also after a rename.
    state.automations.a1 = { ...state.automations.a1, definition: {
        ...WITH_AI, steps: [WITH_AI.steps[0], { ...WITH_AI.steps[1], label: 'Send the reply' }],
    } };
    const later = await call('GET', '/a1/ai-act/check');
    assert.deepStrictEqual(later.json.questions, []);
    assert.strictEqual(later.json.recorded, false);
});

test('GET /:id/ai-act/check: a question is asked again when what Bee found for it changes', async () => {
    reset();
    state.verdict = SURE_NO;
    await call('PUT', '/a1/ai-act/answers', { externalOutput: 'no' });
    assert.strictEqual(state.attests.length, 1);
    const second = { id: 'm2', type: 'integration_action', tool: 'outlook_compose', label: 'Copy', inputs: { to: '{{trigger.output.cc}}', body: '{{steps.a.output.text}}' } };
    state.automations.a1 = { ...state.automations.a1, definition: { ...WITH_AI, steps: [...WITH_AI.steps, second], edges: [...WITH_AI.edges, { from: 'a', to: 'm2' }] } };
    const r = await call('GET', '/a1/ai-act/check');
    assert.deepStrictEqual(r.json.questions.map(q => q.id), ['externalOutput']);
    assert.strictEqual(r.json.status, 'outdated');
});

test('GET /:id/ai-act/check: without the model the two model questions stay open, never guessed', async () => {
    reset();
    const r = await call('GET', '/a1/ai-act/check');
    const byId = Object.fromEntries(r.json.questions.map(q => [q.id, q]));
    assert.deepStrictEqual(Object.keys(byId).sort(), ['externalOutput', 'prohibitedUse', 'sensitiveUse']);
    assert.strictEqual(byId.sensitiveUse.confidence, 'unknown');
    assert.strictEqual(byId.sensitiveUse.suggested, null);
    assert.strictEqual(byId.sensitiveUse.evidence[0].code, 'ai_act.model.unavailable');
    assert.strictEqual(byId.sensitiveUse.domains.length, 10);
    assert.strictEqual(byId.prohibitedUse.confidence, 'unknown');
    assert.strictEqual(state.attests.length, 0);

    // Answering all three records the check.
    const put = await call('PUT', '/a1/ai-act/answers', { externalOutput: 'yes', sensitiveUse: 'no', prohibitedUse: 'no' });
    assert.strictEqual(put.json.recorded, true);
    assert.strictEqual(put.json.status, 'valid');
    // Answering only some leaves the rest open and records nothing.
    reset();
    const part = await call('PUT', '/a1/ai-act/answers', { externalOutput: 'yes' });
    assert.strictEqual(part.status, 200);
    assert.strictEqual(part.json.recorded, false);
    assert.deepStrictEqual(part.json.questions.map(q => q.id).sort(), ['prohibitedUse', 'sensitiveUse']);
    assert.strictEqual(state.attests.length, 0);
});

test('GET /:id/ai-act/check: a viewer sees the result, nothing is recorded for them', async () => {
    reset();
    const r = await call('GET', '/a1/ai-act/check', null, 'viewer');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.canEdit, false);
    assert.strictEqual(state.attests.length, 0);
    state.shares.a2 = [{ principalType: 'user', principalId: 'viewer', role: 'view' }];
    const na = await call('GET', '/a2/ai-act/check', null, 'viewer');
    assert.strictEqual(na.json.recorded, false);
    assert.strictEqual(state.attests.length, 0);
    assert.strictEqual((await call('GET', '/a1/ai-act/check', null, 'stranger')).status, 403);
});

test('PUT /:id/ai-act/answers: validation, rights and the licence', async () => {
    reset();
    const codes = async (body, user = 'owner') => { const r = await call('PUT', '/a1/ai-act/answers', body, user); return [r.status, r.json && r.json.code]; };
    assert.deepStrictEqual(await codes({}), [400, 'ai_act.answers_empty']);
    assert.deepStrictEqual(await codes({ sensitiveUse: 'yes' }), [400, 'ai_act.domain_required']);
    assert.deepStrictEqual(await codes({ sensitiveUse: 'yes', domains: ['astrology'] }), [400, 'ai_act.domain_invalid']);
    assert.deepStrictEqual(await codes({ prohibitedUse: 'yes', practices: ['mind_reading'] }), [400, 'ai_act.practice_invalid']);
    assert.deepStrictEqual(await codes({ externalOutput: 'perhaps' }), [400, 'ai_act.answer_invalid']);
    assert.deepStrictEqual(await codes({ externalOutput: 'no', note: 'x' }), [400, 'ai_act.unknown_field']);
    assert.strictEqual((await call('PUT', '/a1/ai-act/answers', { externalOutput: 'no' }, 'viewer')).status, 403);
    state.required = false;
    assert.deepStrictEqual(await codes({ externalOutput: 'no' }), [403, 'ai_act_not_available']);
    const off = await call('GET', '/a1/ai-act/check');
    assert.strictEqual(off.json.required, false);
    assert.deepStrictEqual(off.json.questions, []);
    assert.strictEqual(state.attests.length, 0);
});

test('the full editor records "manual" and its answers stand at the next automatic check', async () => {
    reset();
    state.verdict = SURE_NO;
    const r = await call('PUT', '/a1/ai-act', { usesAi: 'yes', externalOutput: 'no', sensitiveUse: 'no' });
    assert.strictEqual(r.json.source, 'manual');
    assert.strictEqual(r.json.status, 'valid');
    assert.strictEqual(r.json.outcome, 'minimal');
    const check = await call('GET', '/a1/ai-act/check');
    assert.deepStrictEqual(check.json.questions, []);
    assert.strictEqual(check.json.recorded, false);
    assert.strictEqual(check.json.findings.find(f => f.id === 'externalOutput').by, 'person');
});

test('a valid hub attestation stands: the check does not redo it or ask the model', async () => {
    reset();
    state.rows.push({
        organization_id: 'org-1', target_kind: 'automation', target_id: 'a1', signals: { contains_ai: true },
        answers: {}, outcome: 'minimal', attested_by: 'officer', attested_at: '2026-06-01T00:00:00.000Z', expires_at: '2027-06-01T00:00:00.000Z',
    });
    const r = await call('GET', '/a1/ai-act/check');
    assert.strictEqual(r.json.status, 'valid');
    assert.strictEqual(r.json.attestedBy, 'officer');
    assert.deepStrictEqual(r.json.questions, []);
    assert.strictEqual(state.classifyCalls, 0);
    assert.strictEqual(state.attests.length, 0);
});

