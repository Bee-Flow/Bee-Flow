/**
 * automation/aiActCheck: the three-question wizard, Bee's suggestions, the
 * mapping onto the register and the status the activation gate reads.
 *
 * Run: cd server && node --test automation/aiActCheck.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const c = require('./aiActCheck');
const annexIii = require('../compliance/aiAct/annexIii');

const manual = (steps) => ({ trigger: { id: 't1', kind: 'manual' }, steps, edges: [] });
const mail = (id, to, tool = 'gmail_compose') => ({ id, type: 'integration_action', tool, label: `Mail ${id}`, inputs: { to, subject: 's', body: 'b' } });

// ── Q1 ──────────────────────────────────────────────────────────────────────

test('Q1: ai_step, data_extraction, ai_tool and an AI-mode parse_json are AI; summarize is not', () => {
    const def = manual([
        { id: 'a', type: 'ai_step', label: 'Write reply', prompt: 'x' },
        { id: 'b', type: 'data_extraction', label: 'Read invoice' },
        { id: 'c', type: 'summarize', label: 'Count rows' },
        { id: 'd', type: 'parse_json', mode: 'ai', label: 'Pick fields' },
        { id: 'e', type: 'parse_json', mode: 'paths', label: 'Paths only' },
        { id: 'f', type: 'ai_step', agentId: 'ag-1', label: 'Ask agent' },
    ]);
    const r = c.detectAiUse(def);
    assert.strictEqual(r.detected, true);
    assert.deepStrictEqual(r.steps.map(s => s.stepId), ['a', 'b', 'd', 'f']);
    assert.strictEqual(r.steps.find(s => s.stepId === 'f').type, 'agent');
});

test('Q1: AI inside a loop body and a layer is found', () => {
    const def = {
        ...manual([{ id: 'l', type: 'loop', body: [{ id: 'in', type: 'ai_step', prompt: 'x' }] }]),
        layers: { sub: { trigger: { id: 'lt', kind: 'layer_input' }, steps: [{ id: 'x', type: 'ai_tool' }], edges: [] } },
    };
    assert.deepStrictEqual(c.detectAiUse(def).steps.map(s => s.stepId).sort(), ['in', 'x']);
});

test('Q1: a routine without AI suggests "no" and "not applicable"', () => {
    const s = c.suggestWizard({ definition: manual([{ id: 's1', type: 'wait', seconds: 1 }]) });
    const [q1, q2, q3] = s.questions;
    assert.strictEqual(q1.suggested, 'no');
    assert.strictEqual(q1.reasons[0].code, 'ai_act.uses_ai.none');
    assert.strictEqual(q2.suggested, 'no');
    assert.strictEqual(q3.applicable, false);
    assert.strictEqual(s.suggestedOutcome, 'not_applicable');
    assert.strictEqual(s.previous, null);
});

// ── Q2 ──────────────────────────────────────────────────────────────────────

test('Q2: a mail to a templated address is external; to a colleague\'s literal address it is not', () => {
    const ext = c.detectExternalOutput(manual([mail('m1', '{{trigger.output.email}}')]), { internalDomains: ['acme.nl'] });
    assert.strictEqual(ext.detected, true);
    assert.strictEqual(ext.reasons[0].code, 'ai_act.external.email');
    assert.strictEqual(ext.reasons[0].params.stepId, 'm1');

    const internal = c.detectExternalOutput(manual([mail('m2', 'finance@acme.nl, Jan <jan@ACME.nl>')]), { internalDomains: ['acme.nl'] });
    assert.strictEqual(internal.detected, false);

    const mixed = c.detectExternalOutput(manual([mail('m3', 'finance@acme.nl, klant@elders.com', 'nextcloud_mail_send')]), { internalDomains: ['acme.nl'] });
    assert.strictEqual(mixed.detected, true);
});

test('Q2: http, share by e-mail, signature, social post and a public web page count; Talk, bell and forms do not', () => {
    const def = manual([
        { id: 'h', type: 'http_request', url: 'https://example.com' },
        { id: 's', type: 'integration_action', tool: 'nextcloud_share_by_email', inputs: { path: '/a', shareWith: 'x@y.org' } },
        { id: 'sig', type: 'integration_action', tool: 'signrequest_send_document', inputs: {} },
        { id: 'li', type: 'integration_action', tool: 'linkedin_create_post', inputs: {} },
        { id: 'w', type: 'integration_action', tool: 'webpage_file_write', inputs: {} },
        { id: 'wr', type: 'integration_action', tool: 'webpage_file_read', inputs: {} },
        { id: 't', type: 'integration_action', tool: 'nextcloud_talk_send_message', inputs: {} },
        { id: 'n', type: 'notification', title: 'x', channels: ['notification', 'email'] },
        { id: 'fp', type: 'form_page', mode: 'ending' },
    ]);
    def.trigger = { id: 't1', kind: 'form' };
    const r = c.detectExternalOutput(def, { internalDomains: ['acme.nl'] });
    assert.deepStrictEqual(r.reasons.map(x => x.code), [
        'ai_act.external.http', 'ai_act.external.share_by_email', 'ai_act.external.signature_request',
        'ai_act.external.social_post', 'ai_act.external.webpage',
    ]);
});

test('Q2: a calendar invite counts only with an outside attendee', () => {
    const inv = (att) => manual([{ id: 'c', type: 'integration_action', tool: 'calendar_create_event', inputs: { attendees: att } }]);
    assert.strictEqual(c.detectExternalOutput(inv(['a@acme.nl']), { internalDomains: ['acme.nl'] }).detected, false);
    assert.strictEqual(c.detectExternalOutput(inv(['a@klant.nl']), { internalDomains: ['acme.nl'] }).detected, true);
    assert.strictEqual(c.detectExternalOutput(inv(undefined), { internalDomains: ['acme.nl'] }).detected, false);
});

test('reasons never carry the recipient addresses', () => {
    const r = c.detectExternalOutput(manual([mail('m1', 'jan@klant.nl')]), { internalDomains: ['acme.nl'] });
    assert.ok(!JSON.stringify(r).includes('jan@klant.nl'));
});

// ── Q3 ──────────────────────────────────────────────────────────────────────

test('Q3 is never pre-answered; all ten domains are listed, hinted ones first', () => {
    const def = manual([{ id: 'a', type: 'ai_step', prompt: 'Screen each sollicitatie and rank the candidates' }]);
    const s = c.suggestWizard({ definition: def, title: 'CV screening' });
    const q3 = s.questions[2];
    assert.strictEqual(q3.suggested, null);
    assert.strictEqual(q3.applicable, true);
    assert.strictEqual(q3.domains.length, 10);
    assert.strictEqual(q3.domains[0].id, 'employment');
    assert.strictEqual(q3.domains[0].hint, true);
    assert.strictEqual(q3.reasons[0].code, 'ai_act.sensitive.hints');
    assert.deepStrictEqual(q3.reasons[0].params.domains, ['employment']);
});

test('suggestion with AI and an outside mail leads to "transparency"', () => {
    const def = manual([{ id: 'a', type: 'ai_step', prompt: 'x', label: 'Draft' }, mail('m', '{{x}}')]);
    const s = c.suggestWizard({ definition: def, internalDomains: ['acme.nl'] });
    assert.strictEqual(s.questions[0].suggested, 'yes');
    assert.strictEqual(s.questions[1].suggested, 'yes');
    assert.strictEqual(s.suggestedOutcome, 'transparency');
});

// ── Mapping ─────────────────────────────────────────────────────────────────

test('parseWizard: tri-states only, known domains only, "yes" needs a domain, unknown keys refused', () => {
    const ok = c.parseWizard({ usesAi: 'yes', externalOutput: 'no', sensitiveUse: 'no' });
    assert.strictEqual(ok.ok, true);
    assert.deepStrictEqual(ok.wizard.domains, []);
    assert.strictEqual(c.parseWizard({ usesAi: 'maybe', externalOutput: 'no', sensitiveUse: 'no' }).code, 'ai_act.answer_invalid');
    assert.strictEqual(c.parseWizard({ usesAi: 'yes', externalOutput: 'no', sensitiveUse: 'yes' }).code, 'ai_act.domain_required');
    assert.strictEqual(c.parseWizard({ usesAi: 'yes', externalOutput: 'no', sensitiveUse: 'yes', domains: ['astrology'] }).code, 'ai_act.domain_invalid');
    assert.strictEqual(c.parseWizard({ usesAi: 'yes', externalOutput: 'no', sensitiveUse: 'no', name: 'x' }).code, 'ai_act.unknown_field');
    const yes = c.parseWizard({ usesAi: 'yes', externalOutput: 'no', sensitiveUse: 'yes', domains: ['credit', 'credit'] });
    assert.deepStrictEqual(yes.wizard.domains, ['credit']);
});

test('answersFromWizard: "no" answers all ten domains, "yes" the chosen ones, "unknown" none; Art. 5 survives', () => {
    const prev = { art5: { answer: 'no', practices: [] }, art50: { disclosure: 'yes', marking: 'yes' } };
    const no = c.answersFromWizard({ usesAi: 'yes', externalOutput: 'yes', sensitiveUse: 'no' }, prev);
    assert.strictEqual(no.annex_iii.answer, 'no');
    assert.ok(annexIii.ANNEX_III_IDS.every(id => no.annex_iii.domains[id] === 'no'));
    assert.strictEqual(no.art50.interacts, 'yes');
    assert.strictEqual(no.art50.disclosure, 'yes', 'finer Art. 50 answers from the hub are kept');
    assert.strictEqual(no.art5.answer, 'no', 'Art. 5 is not a wizard question and stays as recorded');

    const yes = c.answersFromWizard({ usesAi: 'yes', externalOutput: 'no', sensitiveUse: 'yes', domains: ['employment'] }, null);
    assert.strictEqual(yes.annex_iii.answer, 'yes');
    assert.strictEqual(yes.annex_iii.domains.employment, 'yes');
    assert.strictEqual(yes.annex_iii.domains.credit, 'no');

    const unk = c.answersFromWizard({ usesAi: 'yes', externalOutput: 'unknown', sensitiveUse: 'unknown' }, null);
    assert.strictEqual(unk.annex_iii.answer, 'unknown');
    assert.ok(annexIii.ANNEX_III_IDS.every(id => unk.annex_iii.domains[id] === 'unknown'));
});

test('effectiveSignals: "yes" widens, "no" never narrows', () => {
    assert.strictEqual(c.effectiveSignals({ contains_ai: false }, { usesAi: 'yes' }).contains_ai, true);
    assert.strictEqual(c.effectiveSignals({ contains_ai: true }, { usesAi: 'no' }).contains_ai, true);
    assert.strictEqual(c.effectiveSignals({}, { usesAi: 'no' }).contains_ai, false);
});

test('wizardFromAssessment reads a stored row back as the three answers', () => {
    const answers = c.answersFromWizard({ usesAi: 'yes', externalOutput: 'yes', sensitiveUse: 'yes', domains: ['credit'] }, null);
    const w = c.wizardFromAssessment({ signals: { contains_ai: true }, answers });
    assert.deepStrictEqual(w, { usesAi: 'yes', externalOutput: 'yes', sensitiveUse: 'yes', domains: ['credit'] });
});

// ── Status and gate ─────────────────────────────────────────────────────────

const NOW = Date.parse('2026-09-28T10:00:00Z');
const row = (extra) => ({ attested_at: '2026-01-01T00:00:00Z', expires_at: '2027-01-01T00:00:00Z', outcome: 'minimal', ...extra });

test('assessmentStatus: missing, valid, expired, prohibited, and an outdated "not applicable"', () => {
    assert.strictEqual(c.assessmentStatus(null, { now: NOW }), 'missing');
    assert.strictEqual(c.assessmentStatus(row(), { now: NOW }), 'valid');
    assert.strictEqual(c.assessmentStatus(row({ expires_at: '2026-09-01T00:00:00Z' }), { now: NOW }), 'expired');
    assert.strictEqual(c.assessmentStatus(row({ outcome: 'prohibited' }), { now: NOW }), 'prohibited');
    assert.strictEqual(c.assessmentStatus(row({ outcome: 'not_applicable', expires_at: null }), { containsAi: false, now: NOW }), 'valid');
    assert.strictEqual(c.assessmentStatus(row({ outcome: 'not_applicable' }), { containsAi: true, now: NOW }), 'outdated');
});

function stateFor({ required = true, latest = null, org = 'org-1' } = {}) {
    const calls = { org: 0, required: 0, latest: 0 };
    const fn = c.makeAiActState({
        organisationOf: async () => { calls.org++; return org; },
        isRequired: async () => { calls.required++; return required; },
        getLatest: async () => { calls.latest++; return latest; },
        now: () => NOW,
    });
    return { fn, calls };
}

test('makeAiActState: no licence is not_required and never reads the register', async () => {
    const { fn, calls } = stateFor({ required: false });
    const s = await fn({ id: 'a1', userId: 'u1' }, manual([]));
    assert.strictEqual(s.required, false);
    assert.strictEqual(s.status, 'not_required');
    assert.strictEqual(calls.latest, 0);
    assert.strictEqual(c.gateRefusal(s), null);
});

test('makeAiActState: without an organisation there is no licence to ask about', async () => {
    const { fn, calls } = stateFor({ org: null });
    assert.strictEqual((await fn({ id: 'a1' }, manual([]))).status, 'not_required');
    assert.strictEqual(calls.required, 0);
});

test('makeAiActState: a disabled compliance module short-circuits before any read', async () => {
    let reads = 0;
    const fn = c.makeAiActState({
        enabled: async () => false,
        organisationOf: async () => { reads++; return 'org-1'; },
        isRequired: async () => { reads++; return true; },
        getLatest: async () => { reads++; return null; },
    });
    assert.strictEqual((await fn({ id: 'a1' }, manual([]))).status, 'not_required');
    assert.strictEqual(reads, 0);
});

test('gateRefusal: missing, expired and outdated need the check; prohibited is its own refusal; valid passes', async () => {
    const missing = await stateFor().fn({ id: 'a1' }, manual([]));
    const r1 = c.gateRefusal(missing);
    assert.strictEqual(r1.status, 409);
    assert.strictEqual(r1.code, 'ai_act_check_required');
    assert.strictEqual(r1.details.aiAct.status, 'missing');
    assert.ok(!/[–—]/.test(r1.message), 'no dashes as punctuation');

    const expired = await stateFor({ latest: row({ expires_at: '2026-09-01T00:00:00Z' }) }).fn({ id: 'a1' }, manual([]));
    assert.strictEqual(c.gateRefusal(expired).code, 'ai_act_check_required');
    assert.strictEqual(expired.expiresAt, '2026-09-01T00:00:00.000Z');

    const aiDef = manual([{ id: 'a', type: 'ai_step', prompt: 'x' }]);
    const outdated = await stateFor({ latest: row({ outcome: 'not_applicable' }) }).fn({ id: 'a1' }, aiDef);
    assert.strictEqual(outdated.status, 'outdated');
    assert.strictEqual(c.gateRefusal(outdated).code, 'ai_act_check_required');

    const prohibited = await stateFor({ latest: row({ outcome: 'prohibited' }) }).fn({ id: 'a1' }, aiDef);
    assert.strictEqual(c.gateRefusal(prohibited).code, 'ai_act_prohibited');

    const valid = await stateFor({ latest: row({ outcome: 'not_applicable' }) }).fn({ id: 'a1' }, manual([]));
    assert.strictEqual(valid.status, 'valid');
    assert.strictEqual(c.gateRefusal(valid), null);
});

test('user-facing texts carry no em or en dashes', () => {
    const def = manual([{ id: 'a', type: 'ai_step', prompt: 'x', label: 'A' }, mail('m', '{{x}}'),
        { id: 'h', type: 'http_request' }]);
    const s = c.suggestWizard({ definition: def });
    for (const q of s.questions) for (const r of q.reasons) assert.ok(!/[–—]/.test(r.text), r.text);
});
