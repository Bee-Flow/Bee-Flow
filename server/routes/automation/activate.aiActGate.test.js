/**
 * The AI Act gate on POST /:id/activate and POST /:id/publish (handoff 5,
 * owner decision 2). Handlers are called directly with an injected store and
 * an injected `aiActState`; no module mocking.
 *
 * Proven:
 *   - with the compliance hub licence and no valid check, activate and publish
 *     throw HttpError 409 `ai_act_check_required` and change nothing;
 *   - an expired check refuses the same way, a prohibited outcome refuses with
 *     `ai_act_prohibited`;
 *   - a valid check (a "not applicable" one included) lets both through;
 *   - without the licence there is no gate;
 *   - the steps are checked first: a broken definition answers its 400, not
 *     the AI Act 409.
 *
 * Run: cd server && node --test routes/automation/activate.aiActGate.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { publishAutomation, activateAutomation } = require('./activate');
const { makeAiActState } = require('../../automation/aiActCheck');
const { HttpError } = require('../../core/http/errors');

const MANUAL = { trigger: { id: 't1', kind: 'manual' }, steps: [{ id: 's1', type: 'wait', seconds: 1 }], edges: [{ from: 't1', to: 's1' }] };
const NOW = Date.parse('2026-09-28T10:00:00Z');

function routine(overrides = {}) {
    const a = {
        id: 'a1', userId: 'u1', organizationId: 'org-1', title: 'R', kind: 'automation', version: 4,
        isActive: false, isDraft: true, definition: MANUAL, liveVersion: null, triggerType: 'manual',
        scheduleCron: null, scheduleTz: 'Europe/Amsterdam', ...overrides,
    };
    Object.defineProperty(a, 'liveDefinition', { value: overrides.liveDefinition ?? MANUAL, enumerable: false, writable: true });
    return a;
}

function harness(a, { required = true, latest = null } = {}) {
    const calls = { publish: [], update: [] };
    const store = {
        getAutomation: async (id) => (a && id === a.id ? a : null),
        publishWorkingCopy: async (id, opts) => { calls.publish.push(opts); return { ...a, liveVersion: opts.expectedVersion, pendingChanges: 0 }; },
        updateAutomation: async (id, updates) => { calls.update.push(updates); return { ...a, ...updates }; },
        getSubscriptionsForAutomation: async () => [],
    };
    const aiActState = makeAiActState({
        organisationOf: async (x) => x.organizationId || null,
        isRequired: async () => required,
        getLatest: async () => latest,
        now: () => NOW,
    });
    const deps = {
        store,
        agentsFor: async () => null,
        kbFindingsFor: async () => [],
        permittedApps: async () => new Set(),
        wakeComplianceReview: () => {},
        ensureFormPages: async () => {},
        syncAppEventSubscription: async () => {},
        syncSchedules: async () => {},
        aiActState,
    };
    return { deps, calls };
}

function run(handler, deps, { body = {}, user = 'u1' } = {}) {
    let out = null;
    const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        json(b) { out = { status: this.statusCode, body: b }; return this; },
    };
    const req = { params: { id: 'a1' }, body, session: { user: { id: user } } };
    return Promise.resolve(handler(req, res, deps)).then(() => out);
}

const assessed = (extra = {}) => ({
    attested_at: '2026-06-01T00:00:00Z', expires_at: '2027-06-01T00:00:00Z', outcome: 'minimal', ...extra,
});

for (const [name, handler] of [['activate', activateAutomation], ['publish', publishAutomation]]) {
    test(`${name}: licence and no check → 409 ai_act_check_required, nothing changes`, async () => {
        const { deps, calls } = harness(routine());
        await assert.rejects(run(handler, deps), (e) => {
            assert.ok(e instanceof HttpError);
            assert.strictEqual(e.status, 409);
            assert.strictEqual(e.code, 'ai_act_check_required');
            assert.strictEqual(e.details.aiAct.status, 'missing');
            assert.strictEqual(e.details.aiAct.required, true);
            return true;
        });
        assert.strictEqual(calls.publish.length, 0);
        assert.strictEqual(calls.update.length, 0);
    });

    test(`${name}: an expired check refuses, a prohibited outcome refuses with its own code`, async () => {
        const expired = harness(routine(), { latest: assessed({ expires_at: '2026-09-01T00:00:00Z' }) });
        await assert.rejects(run(handler, expired.deps), (e) => e.code === 'ai_act_check_required' && e.details.aiAct.status === 'expired');
        const prohibited = harness(routine(), { latest: assessed({ outcome: 'prohibited' }) });
        await assert.rejects(run(handler, prohibited.deps), (e) => e.status === 409 && e.code === 'ai_act_prohibited');
    });

    test(`${name}: a valid check lets it through; so does "not applicable" on a routine without AI`, async () => {
        const valid = harness(routine(), { latest: assessed() });
        assert.strictEqual((await run(handler, valid.deps)).status, 200);
        const na = harness(routine(), { latest: assessed({ outcome: 'not_applicable', expires_at: null }) });
        assert.strictEqual((await run(handler, na.deps)).status, 200);
    });

    test(`${name}: a "not applicable" check does not cover a routine that has an AI step now`, async () => {
        const def = {
            trigger: { id: 't1', kind: 'manual' },
            steps: [{ id: 'a', type: 'ai_step', prompt: 'Summarise', outputSchema: { type: 'object', properties: { text: { type: 'string' } } } }],
            edges: [{ from: 't1', to: 'a' }],
        };
        const { deps } = harness(routine({ definition: def, liveDefinition: def }), { latest: assessed({ outcome: 'not_applicable' }) });
        await assert.rejects(run(handler, deps), (e) => e.code === 'ai_act_check_required' && e.details.aiAct.status === 'outdated');
    });

    test(`${name}: without the compliance hub licence there is no gate`, async () => {
        const { deps } = harness(routine(), { required: false });
        assert.strictEqual((await run(handler, deps)).status, 200);
    });

    test(`${name}: a broken definition answers its own 400 before the AI Act gate`, async () => {
        const broken = { trigger: { id: 't1', kind: 'manual' }, steps: [{ id: 's1', type: 'no_such_type' }], edges: [{ from: 't1', to: 's1' }] };
        const { deps } = harness(routine({ definition: broken, liveDefinition: broken }));
        const r = await run(handler, deps);
        assert.strictEqual(r.status, 400);
        assert.strictEqual(r.body.error, 'Invalid definition');
    });
}

test('activate on a paused routine with a live version is gated too', async () => {
    const { deps } = harness(routine({ liveVersion: 2, isDraft: false }));
    await assert.rejects(run(activateAutomation, deps), (e) => e.code === 'ai_act_check_required');
});
