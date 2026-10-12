/**
 * automation/aiActAuto: the AI Act check that does itself. Everything is
 * injected (register, licence, attestation, model verdict); no module mocks.
 *
 * Proven:
 *   - Bee alone: certain everywhere is recorded automatically (source 'auto',
 *     attested by 'bee'), once; a lapsed automatic check renews itself;
 *   - a stored assessment is updated when a new certain detection differs;
 *   - a question that was certain and is not any more is asked, and only it;
 *   - a person's answer stands while what Bee found for it is unchanged, and
 *     lapses with the row;
 *   - without the model the model questions are open, never guessed;
 *   - a hub attestation stands; a viewer never records.
 *
 * Run: cd server && node --test automation/aiActAuto.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { makeAiActAuto, mergeAnswers } = require('./aiActAuto');
const { makeAiActState } = require('./aiActCheck');
const { detectQuestions } = require('./aiActDetect');
const assess = require('../compliance/aiAct/assess');
const signalsLib = require('../compliance/aiAct/signals');

const NOW = Date.parse('2026-09-28T10:00:00Z');
const SURE_NO = {
    available: true, modelId: 'fast-1',
    prohibited: { answer: 'no', confidence: 'high', practices: [] },
    highRisk: { answer: 'no', confidence: 'high', domains: [] },
};
const flow = (steps) => ({ trigger: { id: 't1', kind: 'manual' }, steps, edges: [] });
const AI = { id: 'a', type: 'ai_step', label: 'Extract invoice details', prompt: 'Read the invoice' };
const INTERNAL = flow([AI, { id: 'd', type: 'datatable', label: 'Save row' }]);

function world({ required = true, verdict = SURE_NO, rows = [], now = NOW } = {}) {
    const w = { rows: [...rows], attests: [], classifyCalls: 0, verdict, now };
    const aiActState = makeAiActState({
        organisationOf: async () => 'org-1',
        isRequired: async () => required,
        getLatest: async () => w.rows[w.rows.length - 1] || null,
        now: () => w.now,
    });
    w.auto = makeAiActAuto({
        aiActState,
        attest: async (input) => {
            w.attests.push(input);
            const result = assess.assess(input.signals, input.answers, { attestedAt: new Date(w.now) });
            const row = {
                signals: input.signals, answers: result.answers, outcome: result.outcome, attested_by: input.actorId,
                attested_at: new Date(w.now).toISOString(), expires_at: assess.expiresAt(new Date(w.now), input.validMonths).toISOString(),
                source: input.source, evidence: input.evidence,
            };
            w.rows.push(row);
            return { row, result };
        },
        classify: async ({ hash }) => { w.classifyCalls++; return { ...w.verdict, hash }; },
        signalsFor: async (a, orgId, def) => signalsLib.signalsFromDefinition(def, { title: a.title }),
        internalDomainsOf: async () => ['acme.nl'],
        now: () => w.now,
    });
    return w;
}

const automation = (definition, extra = {}) => ({ id: 'r1', userId: 'u1', title: 'Invoices', description: 'Books invoices', definition, ...extra });

test('Bee alone: every answer certain is recorded automatically, once', async () => {
    const w = world();
    const r = await w.auto.check(automation(INTERNAL), INTERNAL);
    assert.strictEqual(r.recorded, true);
    assert.deepStrictEqual(r.pending, []);
    assert.strictEqual(r.state.status, 'valid');
    assert.strictEqual(r.state.source, 'auto');
    assert.strictEqual(r.state.attestedBy, 'bee');
    assert.strictEqual(r.state.outcome, 'minimal');
    const rec = w.attests[0];
    assert.strictEqual(rec.validMonths, 12);
    assert.deepStrictEqual(Object.keys(rec.evidence.questions).sort(), ['externalOutput', 'prohibitedUse', 'sensitiveUse', 'usesAi']);
    assert.ok(Object.values(rec.evidence.questions).every(q => q.by === 'bee' && q.confidence === 'certain'));
    assert.strictEqual(rec.evidence.classification.modelId, 'fast-1');
    assert.strictEqual(rec.answers.art5.answer, 'no');
    assert.strictEqual(rec.answers.annex_iii.answer, 'no');

    const again = await w.auto.check(automation(INTERNAL), INTERNAL);
    assert.strictEqual(again.recorded, false);
    assert.strictEqual(w.attests.length, 1);
    assert.strictEqual(w.classifyCalls, 1, 'the stored verdict is reused for the same text');
});

test('no AI: "not applicable", certain, without asking the model', async () => {
    const w = world();
    const def = flow([{ id: 'w', type: 'wait', seconds: 1 }]);
    const r = await w.auto.check(automation(def), def);
    assert.strictEqual(r.state.outcome, 'not_applicable');
    assert.strictEqual(r.applicable, false);
    assert.strictEqual(w.classifyCalls, 0);
    assert.deepStrictEqual(Object.keys(w.attests[0].evidence.questions), ['usesAi']);
});

test('a certain detection that differs from the stored assessment updates it', async () => {
    const w = world();
    await w.auto.check(automation(INTERNAL), INTERNAL);
    const published = flow([AI, { id: 'p', type: 'integration_action', tool: 'webpage_file_write', label: 'Publish', inputs: { content: '{{steps.a.output.text}}' } }]);
    const r = await w.auto.check(automation(published), published);
    assert.strictEqual(r.recorded, true);
    assert.strictEqual(w.attests.length, 2);
    assert.strictEqual(w.attests[1].answers.art50.interacts, 'yes');
    assert.strictEqual(r.state.outcome, 'transparency');
    assert.strictEqual(r.state.source, 'auto');
});

test('previously certain, now unknown: only that question is asked, nothing is recorded', async () => {
    const w = world();
    await w.auto.check(automation(INTERNAL), INTERNAL);
    // The prompt changes (new text for the model) and the model is unreachable now.
    w.verdict = { available: false };
    const changed = flow([{ ...AI, prompt: 'Read the invoice and the supplier rating' }, INTERNAL.steps[1]]);
    const r = await w.auto.check(automation(changed), changed);
    assert.strictEqual(r.recorded, false);
    assert.deepStrictEqual(r.pending.map(q => q.id), ['sensitiveUse', 'prohibitedUse']);
    assert.strictEqual(r.state.status, 'outdated');
    assert.ok(r.pending.every(q => q.confidence === 'unknown' && q.suggested === null));
    assert.strictEqual(w.attests.length, 1);
});

test('a person answers the open questions; the answer stands until what Bee found changes', async () => {
    const w = world();
    const dyn = flow([AI, { id: 'm', type: 'integration_action', tool: 'gmail_compose', label: 'Reply', inputs: { to: '{{trigger.output.from}}', body: '{{steps.a.output.text}}' } }]);
    const first = await w.auto.check(automation(dyn), dyn);
    assert.deepStrictEqual(first.pending.map(q => [q.id, q.confidence, q.suggested]), [['externalOutput', 'likely', 'yes']]);

    const answered = await w.auto.check(automation(dyn), dyn, { actorId: 'u2', answers: { externalOutput: 'yes' } });
    assert.strictEqual(answered.recorded, true);
    assert.strictEqual(answered.state.source, 'mixed');
    assert.strictEqual(answered.state.attestedBy, 'u2');
    assert.strictEqual(answered.state.outcome, 'transparency');

    // Publishing again (Bee alone, record allowed): nothing to ask, nothing new.
    const gate = await w.auto.gateState(automation(dyn), dyn);
    assert.strictEqual(gate.status, 'valid');
    assert.deepStrictEqual(gate.pendingQuestions, []);
    assert.strictEqual(w.attests.length, 1);

    // A year later the row lapses; the person's answer goes with it.
    w.now = Date.parse('2027-10-01T00:00:00Z');
    const lapsed = await w.auto.check(automation(dyn), dyn);
    assert.deepStrictEqual(lapsed.pending.map(q => q.id), ['externalOutput']);
    assert.strictEqual(lapsed.state.status, 'expired');
});

test('a lapsed automatic check renews itself', async () => {
    const w = world();
    await w.auto.check(automation(INTERNAL), INTERNAL);
    w.now = Date.parse('2027-10-01T00:00:00Z');
    const r = await w.auto.check(automation(INTERNAL), INTERNAL);
    assert.strictEqual(r.recorded, true);
    assert.strictEqual(r.state.status, 'valid');
    assert.strictEqual(r.state.expiresAt, '2028-10-01T00:00:00.000Z');
});

test('a model "yes" is put to a person, never recorded by Bee', async () => {
    const w = world({ verdict: { ...SURE_NO, prohibited: { answer: 'yes', confidence: 'high', practices: ['social_scoring'] } } });
    const r = await w.auto.check(automation(INTERNAL), INTERNAL);
    assert.deepStrictEqual(r.pending.map(q => [q.id, q.confidence, q.suggested, q.practices]), [['prohibitedUse', 'likely', 'yes', ['social_scoring']]]);
    assert.strictEqual(w.attests.length, 0);
    const no = await w.auto.check(automation(INTERNAL), INTERNAL, { actorId: 'u1', answers: { prohibitedUse: 'no' } });
    assert.strictEqual(no.state.outcome, 'minimal');
});

test('a hub attestation stands while valid; a viewer (record: false) never writes', async () => {
    const hubRow = { signals: { contains_ai: true }, answers: {}, outcome: 'minimal', attested_by: 'officer', attested_at: '2026-06-01T00:00:00Z', expires_at: '2027-06-01T00:00:00Z' };
    const w = world({ rows: [hubRow] });
    const r = await w.auto.check(automation(INTERNAL), INTERNAL);
    assert.strictEqual(r.state.attestedBy, 'officer');
    assert.strictEqual(w.classifyCalls, 0);

    const v = world();
    const seen = await v.auto.check(automation(INTERNAL), INTERNAL, { record: false });
    assert.strictEqual(seen.recorded, false);
    assert.strictEqual(seen.state.status, 'missing');
    assert.strictEqual(v.attests.length, 0);
    assert.strictEqual(seen.findings.length, 4);
});

test('without the licence nothing is detected or recorded', async () => {
    const w = world({ required: false });
    const r = await w.auto.check(automation(INTERNAL), INTERNAL);
    assert.strictEqual(r.state.required, false);
    assert.strictEqual(w.classifyCalls, 0);
    const gate = await w.auto.gateState(automation(INTERNAL), INTERNAL);
    assert.deepStrictEqual(gate.pendingQuestions, []);
});

test('"uses AI: no" from a person does not narrow AI Bee is certain of', async () => {
    const w = world();
    const r = await w.auto.check(automation(INTERNAL), INTERNAL, { actorId: 'u1', answers: { usesAi: 'no' } });
    assert.strictEqual(r.state.outcome, 'minimal');
    assert.strictEqual(w.attests[0].evidence.questions.usesAi.by, 'bee');
});

test('mergeAnswers: a person\'s answer is kept on the same fingerprint, dropped on another', () => {
    const detection = detectQuestions({ definition: INTERNAL, verdict: { available: false } });
    const row = {
        attested_at: '2026-09-01T00:00:00Z', expires_at: '2027-09-01T00:00:00Z',
        evidence: { questions: { sensitiveUse: { answer: 'no', by: 'person', sig: detection.questions.sensitiveUse.sig } } },
    };
    const kept = mergeAnswers(detection, row, { now: NOW });
    assert.strictEqual(kept.final.sensitiveUse.by, 'person');
    assert.deepStrictEqual(kept.pending, ['prohibitedUse']);
    const other = { ...row, evidence: { questions: { sensitiveUse: { answer: 'no', by: 'person', sig: 'something-else' } } } };
    assert.deepStrictEqual(mergeAnswers(detection, other, { now: NOW }).pending, ['sensitiveUse', 'prohibitedUse']);
});
