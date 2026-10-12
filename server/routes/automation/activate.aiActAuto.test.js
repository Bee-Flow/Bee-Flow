/**
 * The AI Act gate on POST /:id/activate and POST /:id/publish with the
 * automatic check crud.js injects (automation/aiActAuto.js gateState).
 * Handlers are called directly with an injected store, register, licence and
 * fast-model verdict; no module mocking.
 *
 * Proven:
 *   - an automation Bee can assess by itself goes live, and the check is recorded
 *     (source 'auto') on the way;
 *   - otherwise 409 `ai_act_check_required` with ONLY the open questions,
 *     each with its suggestion and evidence, and nothing goes live;
 *   - after those are answered the same publish goes through;
 *   - without the model the two model questions are asked, never guessed.
 *
 * Run: cd server && node --test routes/automation/activate.aiActAuto.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { publishAutomation, activateAutomation } = require('./activate');
const { makeAiActState } = require('../../automation/aiActCheck');
const { makeAiActAuto } = require('../../automation/aiActAuto');
const assess = require('../../compliance/aiAct/assess');
const signalsLib = require('../../compliance/aiAct/signals');
const { HttpError } = require('../../core/http/errors');

const NOW = Date.parse('2026-09-28T10:00:00Z');
const SCHEMA = { type: 'object', properties: { text: { type: 'string' } } };
const AI = { id: 'a', type: 'ai_step', label: 'Extract invoice details', prompt: 'Read the invoice', outputSchema: SCHEMA };
const def = (steps) => ({ trigger: { id: 't1', kind: 'manual' }, steps, edges: steps.map((s, i) => ({ from: i ? steps[i - 1].id : 't1', to: s.id })) });
const INTERNAL = def([AI, { id: 'w', type: 'wait', seconds: 1 }]);
const REPLY = def([AI, { id: 'm', type: 'integration_action', tool: 'gmail_compose', label: 'Reply', inputs: { to: '{{trigger.output.from}}', subject: 'Re', body: '{{steps.a.output.text}}' } }]);
const SURE_NO = {
    available: true, modelId: 'fast-1',
    prohibited: { answer: 'no', confidence: 'high', practices: [] },
    highRisk: { answer: 'no', confidence: 'high', domains: [] },
};

function automation(definition) {
    const a = {
        id: 'a1', userId: 'u1', organizationId: 'org-1', title: 'Invoices', kind: 'automation', version: 4,
        isActive: false, isDraft: true, definition, liveVersion: null, triggerType: 'manual',
        scheduleCron: null, scheduleTz: 'Europe/Amsterdam',
    };
    Object.defineProperty(a, 'liveDefinition', { value: definition, enumerable: false, writable: true });
    return a;
}

function harness(a, { verdict = SURE_NO } = {}) {
    const w = { rows: [], attests: [], publish: [], update: [], verdict };
    const store = {
        getAutomation: async (id) => (id === a.id ? a : null),
        publishWorkingCopy: async (id, opts) => { w.publish.push(opts); return { ...a, liveVersion: opts.expectedVersion }; },
        updateAutomation: async (id, updates) => { w.update.push(updates); return { ...a, ...updates }; },
        getSubscriptionsForAutomation: async () => [],
    };
    const aiActState = makeAiActState({
        organisationOf: async (x) => x.organizationId,
        isRequired: async () => true,
        getLatest: async () => w.rows[w.rows.length - 1] || null,
        now: () => NOW,
    });
    w.auto = makeAiActAuto({
        aiActState,
        attest: async (input) => {
            w.attests.push(input);
            const result = assess.assess(input.signals, input.answers, { attestedAt: new Date(NOW) });
            const row = {
                signals: input.signals, answers: result.answers, outcome: result.outcome, attested_by: input.actorId,
                attested_at: new Date(NOW).toISOString(), expires_at: assess.expiresAt(new Date(NOW), 12).toISOString(),
                source: input.source, evidence: input.evidence,
            };
            w.rows.push(row);
            return { row, result };
        },
        classify: async ({ hash }) => ({ ...w.verdict, hash }),
        signalsFor: async (x, orgId, d) => signalsLib.signalsFromDefinition(d, { title: x.title }),
        internalDomainsOf: async () => ['acme.nl'],
        now: () => NOW,
    });
    w.deps = {
        store,
        agentsFor: async () => null,
        kbFindingsFor: async () => [],
        permittedApps: async () => new Set(['gmail']),
        wakeComplianceReview: () => {},
        ensureFormPages: async () => {},
        syncAppEventSubscription: async () => {},
        syncSchedules: async () => {},
        aiActState: w.auto.gateState,
    };
    return w;
}

function run(handler, deps) {
    let out = null;
    const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        json(b) { out = { status: this.statusCode, body: b }; return this; },
    };
    const req = { params: { id: 'a1' }, body: {}, session: { user: { id: 'u1' } } };
    return Promise.resolve(handler(req, res, deps)).then(() => out);
}

for (const [name, handler] of [['activate', activateAutomation], ['publish', publishAutomation]]) {
    test(`${name}: Bee answers everything itself, records the check and the automation goes live`, async () => {
        const w = harness(automation(INTERNAL));
        const r = await run(handler, w.deps);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(w.attests.length, 1);
        assert.strictEqual(w.attests[0].source, 'auto');
        assert.strictEqual(w.attests[0].actorId, 'bee');
        assert.strictEqual(w.publish.length + w.update.length, 1);
    });

    test(`${name}: 409 with only the question Bee could not answer; answered, the same call goes through`, async () => {
        const w = harness(automation(REPLY));
        await assert.rejects(run(handler, w.deps), (e) => {
            assert.ok(e instanceof HttpError);
            assert.strictEqual(e.status, 409);
            assert.strictEqual(e.code, 'ai_act_check_required');
            assert.deepStrictEqual(e.details.questions.map(q => [q.id, q.confidence, q.suggested]), [['externalOutput', 'likely', 'yes']]);
            assert.deepStrictEqual(e.details.questions[0].evidence.map(x => x.code), ['ai_act.external.email', 'ai_act.external.ai_flows']);
            assert.strictEqual(e.details.aiAct.status, 'missing');
            assert.match(e.message, /one answer/);
            assert.ok(!/[–—]/.test(e.message));
            return true;
        });
        assert.strictEqual(w.publish.length + w.update.length, 0, 'nothing went live');
        assert.strictEqual(w.attests.length, 0);

        // The builder's dialog: PUT /:id/ai-act/answers, then the same call again.
        await w.auto.check(automation(REPLY), REPLY, { actorId: 'u1', answers: { externalOutput: 'yes' } });
        const r = await run(handler, w.deps);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(w.attests.length, 1, 'no second record on the way through');
        assert.strictEqual(w.attests[0].source, 'mixed');
    });

    test(`${name}: without the model the two model questions are asked, never guessed`, async () => {
        const w = harness(automation(INTERNAL), { verdict: { available: false } });
        await assert.rejects(run(handler, w.deps), (e) => {
            assert.strictEqual(e.code, 'ai_act_check_required');
            assert.deepStrictEqual(e.details.questions.map(q => [q.id, q.confidence]), [['sensitiveUse', 'unknown'], ['prohibitedUse', 'unknown']]);
            assert.ok(e.details.questions.every(q => q.evidence[0].code === 'ai_act.model.unavailable'));
            return true;
        });
        assert.strictEqual(w.attests.length, 0);
    });
}
