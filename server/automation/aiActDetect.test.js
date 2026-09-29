/**
 * automation/aiActDetect: what Bee can tell about the AI Act by itself, per
 * question, and how sure it is. Definitions in, answers out; the model
 * verdict is handed in.
 *
 * Run: cd server && node --test automation/aiActDetect.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const d = require('./aiActDetect');

const flow = (steps, extra = {}) => ({ trigger: { id: 't1', kind: 'manual' }, steps, edges: [], ...extra });
const ai = (id, extra = {}) => ({ id, type: 'ai_step', label: `AI ${id}`, prompt: 'Write a friendly reply', ...extra });
const mail = (id, to, body = 'Hello', tool = 'gmail_compose') => ({ id, type: 'integration_action', tool, label: `Mail ${id}`, inputs: { to, subject: 's', body } });
const SURE_NO = {
    available: true,
    prohibited: { answer: 'no', confidence: 'high', practices: [] },
    highRisk: { answer: 'no', confidence: 'high', domains: [] },
};
const detect = (definition, extra = {}) => d.detectQuestions({ definition, internalDomains: ['acme.nl'], verdict: SURE_NO, ...extra });

// ── Uses AI ─────────────────────────────────────────────────────────────────

test('uses AI: every step kind that calls a model is found; summarize and a paths parse_json are not', () => {
    const def = flow([
        ai('a'),
        { id: 'b', type: 'data_extraction', label: 'Read invoice' },
        { id: 'c', type: 'summarize', label: 'Count rows' },
        { id: 'p', type: 'parse_json', mode: 'ai' },
        { id: 'q', type: 'parse_json', mode: 'paths' },
        ai('g', { agentId: 'ag-1' }),
        { id: 'k', type: 'knowledge_write', nearDuplicateStrategy: 'merge' },
        { id: 'k2', type: 'knowledge_write', nearDuplicateStrategy: 'skip' },
        { id: 'img', type: 'integration_action', tool: 'generate_image' },
        { id: 'if', type: 'condition', expression: 'isAbout(trigger.output.body, "complaint")' },
    ]);
    const r = d.detectAiUse(def);
    assert.deepStrictEqual(r.steps.map(s => [s.stepId, s.type]), [
        ['a', 'ai_step'], ['b', 'data_extraction'], ['p', 'parse_json'], ['g', 'agent'],
        ['k', 'knowledge_write'], ['img', 'ai_tool'], ['if', 'topic_rule'],
    ]);
    const q = detect(def).questions.usesAi;
    assert.deepStrictEqual([q.answer, q.confidence], ['yes', 'certain']);
    assert.strictEqual(q.evidence[0].code, 'ai_act.uses_ai.steps');
    assert.strictEqual(q.evidence[0].params.count, 7);
});

test('uses AI: a loop around an "is about" rule is not counted twice', () => {
    const def = flow([{ id: 'l', type: 'loop', body: [{ id: 'c', type: 'condition', expression: 'isAbout(item, "x")' }] }]);
    assert.deepStrictEqual(d.detectAiUse(def).steps.map(s => s.stepId), ['c']);
});

test('uses AI: without AI it is a certain "no" and the rest does not apply', () => {
    const r = detect(flow([{ id: 'w', type: 'wait', seconds: 1 }]));
    assert.strictEqual(r.applicable, false);
    assert.deepStrictEqual([r.questions.usesAi.answer, r.questions.usesAi.confidence], ['no', 'certain']);
    assert.strictEqual(r.questions.usesAi.evidence[0].code, 'ai_act.uses_ai.none');
});

test('uses AI: Bee looks inside a reusable Step; one it cannot open makes "no" only likely', () => {
    const def = flow([{ id: 'cb', type: 'call_block', blockId: 'blk-1', label: 'Classify ticket' }]);
    const inside = d.detectQuestions({ definition: def, blocks: { 'blk-1': flow([ai('inner')]) }, verdict: SURE_NO });
    assert.strictEqual(inside.applicable, true);
    assert.deepStrictEqual(inside.ai.steps, [{ stepId: 'cb', label: 'Classify ticket', type: 'block' }]);

    const closed = d.detectQuestions({ definition: def, blocks: { 'blk-1': null }, verdict: SURE_NO });
    assert.strictEqual(closed.applicable, null);
    assert.deepStrictEqual([closed.questions.usesAi.answer, closed.questions.usesAi.confidence], ['no', 'likely']);
    assert.strictEqual(closed.questions.usesAi.evidence[0].code, 'ai_act.uses_ai.block_unknown');

    const plain = d.detectQuestions({ definition: def, blocks: { 'blk-1': flow([{ id: 'w', type: 'wait' }]) } });
    assert.deepStrictEqual([plain.questions.usesAi.answer, plain.questions.usesAi.confidence], ['no', 'certain']);
});

// ── Output outside the organisation ─────────────────────────────────────────

test('outside: nothing leaves (Talk, bell, draft, form, an internal literal address) is a certain "no"', () => {
    const def = flow([
        ai('a'),
        { id: 't', type: 'integration_action', tool: 'nextcloud_talk_send_message', inputs: { message: '{{steps.a.output.text}}' } },
        { id: 'n', type: 'notification', title: '{{steps.a.output.text}}' },
        { id: 'dr', type: 'integration_action', tool: 'gmail_create_draft', inputs: { to: 'klant@elders.com', body: '{{steps.a.output.text}}' } },
        { id: 'fp', type: 'form_page', mode: 'ending', content: '{{steps.a.output.text}}' },
        mail('m', 'finance@acme.nl, Jan <jan@ACME.nl>', '{{steps.a.output.text}}'),
    ], { trigger: { id: 't1', kind: 'form' } });
    const q = detect(def).questions.externalOutput;
    assert.deepStrictEqual([q.answer, q.confidence], ['no', 'certain']);
    assert.strictEqual(q.evidence[0].code, 'ai_act.external.none');
});

test('outside: AI text to a fixed outside address is a certain "yes"', () => {
    const q = detect(flow([ai('a'), mail('m', 'orders@supplier.com', 'Dear supplier, {{steps.a.output.text}}')])).questions.externalOutput;
    assert.deepStrictEqual([q.answer, q.confidence], ['yes', 'certain']);
    assert.deepStrictEqual(q.evidence.map(e => e.code), ['ai_act.external.email_fixed', 'ai_act.external.ai_flows']);
    assert.strictEqual(q.evidence[0].params.reach, 'fixed_external');
    assert.ok(!JSON.stringify(q).includes('supplier.com'), 'no address in the evidence');
});

test('outside: AI text to a templated address is only likely; a mail without AI text leans "no"', () => {
    const dyn = detect(flow([ai('a'), mail('m', '{{trigger.output.from}}', '{{steps.a.output.text}}')])).questions.externalOutput;
    assert.deepStrictEqual([dyn.answer, dyn.confidence], ['yes', 'likely']);
    assert.strictEqual(dyn.evidence[0].code, 'ai_act.external.email');

    const plain = detect(flow([ai('a'), mail('m', 'orders@supplier.com', 'We received your order.')])).questions.externalOutput;
    assert.deepStrictEqual([plain.answer, plain.confidence], ['no', 'likely']);
    assert.deepStrictEqual(plain.evidence.map(e => e.code), ['ai_act.external.email_fixed', 'ai_act.external.no_ai']);
});

test('outside: AI output reaches a public page through a set step (transitively) and through a loop item', () => {
    const viaSet = flow([
        ai('a'),
        { id: 's', type: 'set', values: { html: { kind: 'ref', path: 'steps.a.output.text' } } },
        { id: 'w', type: 'integration_action', tool: 'webpage_file_write', label: 'Publish', inputs: { content: '{{steps.s.output.html}}' } },
    ]);
    const q = detect(viaSet).questions.externalOutput;
    assert.deepStrictEqual([q.answer, q.confidence], ['yes', 'certain']);
    assert.strictEqual(q.evidence[0].code, 'ai_act.external.webpage');

    const viaLoop = flow([
        ai('a'),
        { id: 'l', type: 'loop', items: '{{steps.a.output.posts}}', body: [{ id: 'li', type: 'integration_action', tool: 'linkedin_create_post', inputs: { text: '{{item.text}}' } }] },
    ]);
    const q2 = detect(viaLoop).questions.externalOutput;
    assert.deepStrictEqual([q2.answer, q2.confidence], ['yes', 'certain']);
    assert.strictEqual(q2.evidence[0].params.stepId, 'li');
});

test('outside: a system call with AI output is likely; steps ids are not confused by a shared prefix', () => {
    const def = flow([ai('a'), { id: 'a1', type: 'set', values: { x: 1 } }, { id: 'h', type: 'http_request', label: 'Push', body: '{{steps.a1.output.x}}' }]);
    const q = detect(def).questions.externalOutput;
    assert.deepStrictEqual([q.answer, q.confidence], ['no', 'likely'], 'steps.a1 is not steps.a');
    const withAi = detect(flow([ai('a'), { id: 'h', type: 'http_request', body: '{{steps.a.output.text}}' }])).questions.externalOutput;
    assert.deepStrictEqual([withAi.answer, withAi.confidence], ['yes', 'likely']);
});

test('outside: a calendar invite counts only with an outside attendee; internal signers are not outward', () => {
    const inv = (att) => flow([ai('a'), { id: 'c', type: 'integration_action', tool: 'calendar_create_event', inputs: { attendees: att, description: '{{steps.a.output.text}}' } }]);
    assert.strictEqual(detect(inv(['a@acme.nl'])).questions.externalOutput.confidence, 'certain');
    assert.strictEqual(detect(inv(['a@acme.nl'])).questions.externalOutput.answer, 'no');
    assert.strictEqual(detect(inv(['a@klant.nl'])).questions.externalOutput.answer, 'yes');
    const sign = flow([{ id: 's', type: 'integration_action', tool: 'signrequest_send_document', inputs: { signers: [{ email: 'boss@acme.nl' }] } }]);
    assert.strictEqual(detect(sign).questions.externalOutput.evidence[0].code, 'ai_act.external.none');
});

// ── The model's questions ───────────────────────────────────────────────────

test('model: a confident "no" is certain; a keyword hint turns it into a likely one', () => {
    const plain = detect(flow([ai('a')])).questions;
    assert.deepStrictEqual([plain.sensitiveUse.answer, plain.sensitiveUse.confidence], ['no', 'certain']);
    assert.deepStrictEqual([plain.prohibitedUse.answer, plain.prohibitedUse.confidence], ['no', 'certain']);
    const hinted = d.detectQuestions({ definition: flow([ai('a', { prompt: 'Rank each sollicitatie' })]), verdict: SURE_NO }).questions.sensitiveUse;
    assert.deepStrictEqual([hinted.answer, hinted.confidence], ['no', 'likely']);
    assert.deepStrictEqual(hinted.evidence.map(e => e.code), ['ai_act.sensitive.none_found', 'ai_act.sensitive.hints']);
});

test('model: a "yes" is never certain; medium or low is unknown with a lean; no model is unknown', () => {
    const yes = d.detectQuestions({ definition: flow([ai('a')]), verdict: {
        available: true,
        prohibited: { answer: 'yes', confidence: 'high', practices: ['social_scoring', 'invented'] },
        highRisk: { answer: 'yes', confidence: 'high', domains: ['credit'] },
    } }).questions;
    assert.deepStrictEqual([yes.prohibitedUse.answer, yes.prohibitedUse.confidence, yes.prohibitedUse.practices], ['yes', 'likely', ['social_scoring']]);
    assert.deepStrictEqual([yes.sensitiveUse.answer, yes.sensitiveUse.confidence, yes.sensitiveUse.domains], ['yes', 'likely', ['credit']]);

    const unsure = d.detectQuestions({ definition: flow([ai('a')]), verdict: {
        available: true,
        prohibited: { answer: 'no', confidence: 'medium', practices: [] },
        highRisk: { answer: 'no', confidence: 'low', domains: [] },
    } }).questions;
    assert.deepStrictEqual([unsure.sensitiveUse.answer, unsure.sensitiveUse.confidence, unsure.sensitiveUse.lean], ['unknown', 'unknown', 'no']);
    assert.strictEqual(unsure.prohibitedUse.evidence[0].code, 'ai_act.model.unsure');

    for (const verdict of [null, { available: false }]) {
        const none = d.detectQuestions({ definition: flow([ai('a')]), verdict }).questions;
        assert.deepStrictEqual([none.sensitiveUse.confidence, none.prohibitedUse.confidence], ['unknown', 'unknown']);
        assert.strictEqual(none.sensitiveUse.evidence[0].code, 'ai_act.model.unavailable');
    }
});

// ── Fingerprints ────────────────────────────────────────────────────────────

test('sig: a rename keeps the fingerprint, a new outward step changes it', () => {
    const base = flow([ai('a'), mail('m', '{{x}}', '{{steps.a.output.text}}')]);
    const renamed = flow([ai('a', { label: 'Other name' }), { ...mail('m', '{{x}}', '{{steps.a.output.text}}'), label: 'Send it' }]);
    const more = flow([ai('a'), mail('m', '{{x}}', '{{steps.a.output.text}}'), mail('m2', '{{y}}', '{{steps.a.output.text}}')]);
    const s = (def) => detect(def).questions.externalOutput.sig;
    assert.strictEqual(s(base), s(renamed));
    assert.notStrictEqual(s(base), s(more));
    assert.strictEqual(detect(base).questions.usesAi.sig, detect(renamed).questions.usesAi.sig);
});

test('recipient reading: templates are dynamic, literal addresses are fixed, the old three-way reading holds', () => {
    assert.strictEqual(d.recipientClass('{{trigger.output.email}}', ['acme.nl']), 'dynamic');
    assert.strictEqual(d.recipientClass('a@acme.nl; b@klant.nl', ['acme.nl']), 'fixed_external');
    assert.strictEqual(d.recipientClass([{ email: 'a@acme.nl' }], ['acme.nl']), 'internal');
    assert.strictEqual(d.recipientClass('', ['acme.nl']), 'none');
    assert.strictEqual(d.recipientsReach('{{x}}', ['acme.nl']), 'external');
    assert.strictEqual(d.recipientsReach('a@acme.nl', ['acme.nl']), 'internal');
});
