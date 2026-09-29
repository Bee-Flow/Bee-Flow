/**
 * The plan gate on POST /:id/activate and POST /:id/publish for licensed
 * steps (automation/licensedSteps.js, wired in activate.js checkBeforeLive).
 *
 * Handlers are called directly with an injected store and an injected
 * capability answer, the activate.publish.test.js harness: no module mocking,
 * validateDefinition is the real, pure validator.
 *
 * Proven:
 *   - a routine going live with a Privacy Shield step (guard, tokenize) or an
 *     approval step is refused with a readable 403 when the owner's plan lacks
 *     it, and nothing is published or switched on;
 *   - with the capability it goes live as before;
 *   - what is live keeps working: re-activating a paused routine whose live
 *     copy has the step, and publishing a version that still carries a live
 *     step, are not refused; untokenize is never asked about;
 *   - approvals are the exception: the runner refuses them, so going live
 *     with one is refused even when it is already live;
 *   - the OWNER's plan is asked, not the editor's who pressed the button.
 *
 * Run: cd server && node --test routes/automation/activate.licence.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { publishAutomation, activateAutomation } = require('./activate');

const PRIVACY = 'automation_privacy_steps';
const APPROVALS = 'approvals';

const trigger = { id: 't1', kind: 'manual' };
const GUARDED = {
    trigger,
    steps: [
        { id: 'g1', type: 'guard', sourceRef: 'trigger.output.text', label: 'Scan the message' },
        { id: 'w1', type: 'wait', seconds: 1 },
    ],
    edges: [{ from: 't1', to: 'g1' }, { from: 'g1', to: 'w1', label: 'then' }],
};
const PLAIN = { trigger, steps: [{ id: 'w1', type: 'wait', seconds: 1 }], edges: [{ from: 't1', to: 'w1' }] };
const withTokenize = (base) => ({
    ...base,
    steps: [...base.steps, { id: 'tok1', type: 'tokenize', sourceRef: 'trigger.output.text', label: 'Hide names' }],
    edges: [...base.edges, { from: 'w1', to: 'tok1' }],
});
const REVEAL_ONLY = {
    trigger,
    steps: [{ id: 'u1', type: 'untokenize', sourceRef: 'trigger.output.text' }],
    edges: [{ from: 't1', to: 'u1' }],
};
const APPROVING = {
    trigger,
    steps: [{ id: 'ap1', type: 'approval', prompt: 'Send it?' }],
    edges: [{ from: 't1', to: 'ap1' }],
};

function routine(overrides = {}) {
    const a = {
        id: 'a1', userId: 'owner', organizationId: 'org1', title: 'R', kind: 'automation', version: 4,
        isActive: false, isDraft: true, definition: PLAIN, liveVersion: null,
        triggerType: 'manual', scheduleCron: null, scheduleTz: 'Europe/Amsterdam',
        ...overrides,
    };
    Object.defineProperty(a, 'liveDefinition', { value: overrides.liveDefinition ?? null, enumerable: false, writable: true });
    return a;
}

/** `granted` capability ids answer granted; the rest are outside the plan. */
function plan(granted = []) {
    const calls = [];
    const fn = async (caps, who) => {
        calls.push({ caps, who });
        const states = {};
        for (const c of caps) states[c] = granted.includes(c) ? 'granted' : 'locked';
        return { degraded: false, states };
    };
    fn.calls = calls;
    return fn;
}

function harness(a, capabilityStates, { access = null } = {}) {
    const calls = { publish: [], update: [], subs: [], schedules: [], woke: [] };
    const store = {
        getAutomation: async (id) => (a && id === a.id ? a : null),
        publishWorkingCopy: async (id, opts) => {
            calls.publish.push({ id, opts });
            return { ...a, liveVersion: opts.expectedVersion, isActive: a.isActive || !!opts.columns?.isActive };
        },
        updateAutomation: async (id, updates) => { calls.update.push(updates); return { ...a, ...updates }; },
        getSubscriptionsForAutomation: async () => [],
    };
    const deps = {
        store,
        capabilityStates,
        ...(access ? { access } : {}),
        agentsFor: async () => null,
        kbFindingsFor: async () => [],
        permittedApps: async () => new Set(),
        wakeComplianceReview: (x, reason) => calls.woke.push(reason),
        ensureFormPages: async () => {},
        syncAppEventSubscription: async (id, userId, def) => calls.subs.push(def),
        syncSchedules: async (id, def) => calls.schedules.push(def),
    };
    return { deps, calls };
}

function call(handler, deps, { body = {}, user = 'owner' } = {}) {
    return new Promise((resolve) => {
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(b) { resolve({ status: this.statusCode, body: b }); return this; },
        };
        const req = { params: { id: 'a1' }, body, session: { user: { id: user } } };
        Promise.resolve(handler(req, res, deps)).catch((e) => resolve({ status: 500, body: { error: e.message } }));
    });
}

const nothingWritten = (calls) => calls.publish.length === 0 && calls.update.length === 0 && calls.woke.length === 0;

// ── Activate ─────────────────────────────────────────────────────────────

test('activate: a never-live routine with a Privacy Shield check is refused without the plan, in words', async () => {
    const { deps, calls } = harness(routine({ definition: GUARDED }), plan());
    const r = await call(activateAutomation, deps);
    assert.strictEqual(r.status, 403, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'feature_locked');
    assert.strictEqual(r.body.feature, PRIVACY);
    assert.strictEqual(r.body.required, 'enterprise');
    assert.match(r.body.error, /^This routine cannot go live/, 'the sentence is in `error`, where every client looks');
    assert.strictEqual(r.body.details.length, 1);
    assert.match(r.body.details[0].message, /"Scan the message" is a Privacy Shield step/);
    assert.strictEqual(r.body.details[0].path, 'steps[0]', 'the validator\'s own address');
    assert.ok(nothingWritten(calls), 'nothing is published or switched on');
});

test('activate: the same routine goes live when the plan has the privacy steps', async () => {
    const { deps, calls } = harness(routine({ definition: GUARDED }), plan([PRIVACY]));
    const r = await call(activateAutomation, deps);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(calls.publish.length, 1);
});

test('activate: a hide step is refused the same way', async () => {
    const { deps } = harness(routine({ definition: withTokenize(PLAIN) }), plan());
    const r = await call(activateAutomation, deps);
    assert.strictEqual(r.status, 403);
    assert.deepStrictEqual(r.body.details.map(d => d.stepId), ['tok1']);
});

test('activate: re-activating a paused routine whose LIVE copy has the step is not refused', async () => {
    const cap = plan();
    const a = routine({ definition: withTokenize(GUARDED), liveDefinition: GUARDED, liveVersion: 2, isDraft: false });
    const { deps, calls } = harness(a, cap);
    const r = await call(activateAutomation, deps);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(cap.calls.length, 0, 'what is live keeps working, the plan is not even asked');
    assert.strictEqual(calls.update[0].isActive, true);
    assert.strictEqual(calls.publish.length, 0, 'the pending hide step stays pending');
});

test('activate: untokenize alone never asks the plan', async () => {
    const cap = plan();
    const { deps } = harness(routine({ definition: REVEAL_ONLY }), cap);
    const r = await call(activateAutomation, deps);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(cap.calls.length, 0);
});

test('activate: an approval step is refused without approvals, even when it is already live', async () => {
    const neverLive = harness(routine({ definition: APPROVING }), plan([PRIVACY]));
    const r1 = await call(activateAutomation, neverLive.deps);
    assert.strictEqual(r1.status, 403);
    assert.strictEqual(r1.body.feature, APPROVALS);
    assert.match(r1.body.details[0].message, /asks a person for approval/);
    assert.ok(nothingWritten(neverLive.calls));

    const paused = harness(routine({ definition: APPROVING, liveDefinition: APPROVING, liveVersion: 2 }), plan([PRIVACY]));
    const r2 = await call(activateAutomation, paused.deps);
    assert.strictEqual(r2.status, 403, 'the runner would fail the step, so going live says so now');
    assert.ok(nothingWritten(paused.calls));
});

test('activate: with approvals in the plan the approval routine goes live', async () => {
    const { deps } = harness(routine({ definition: APPROVING }), plan([APPROVALS]));
    const r = await call(activateAutomation, deps);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
});

test('activate: the owner\'s plan is asked, not the plan of the editor who pressed the button', async () => {
    const cap = plan([PRIVACY]);
    const access = { guard: async () => ({ role: 'edit', via: 'share' }) };
    const { deps } = harness(routine({ definition: GUARDED }), cap, { access });
    const r = await call(activateAutomation, deps, { user: 'editor' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(cap.calls[0].who.userId, 'owner');
    assert.strictEqual(cap.calls[0].who.orgId, 'org1');
    assert.strictEqual(cap.calls[0].who.session, null, 'the editor\'s session never stands in for the owner');
});

test('activate: a plan that cannot be checked is a 503, not a refusal', async () => {
    const { deps, calls } = harness(routine({ definition: GUARDED }), async () => ({ degraded: true, states: {} }));
    const r = await call(activateAutomation, deps);
    assert.strictEqual(r.status, 503);
    assert.strictEqual(r.body.code, 'entitlement_unavailable');
    assert.ok(nothingWritten(calls));
});

// ── Publish ──────────────────────────────────────────────────────────────

test('publish: a new version that ADDS a privacy step is refused without the plan', async () => {
    const a = routine({ definition: withTokenize(GUARDED), liveDefinition: GUARDED, liveVersion: 2, isActive: true, isDraft: false });
    const { deps, calls } = harness(a, plan());
    const r = await call(publishAutomation, deps);
    assert.strictEqual(r.status, 403, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.details.map(d => d.stepId), ['tok1'], 'only the step that is new is named');
    assert.strictEqual(calls.publish.length, 0);
});

test('publish: a version that only keeps the live privacy step is not refused', async () => {
    const edited = { ...GUARDED, steps: GUARDED.steps.map(s => (s.id === 'g1' ? { ...s, label: 'Scan the whole message' } : s)) };
    const a = routine({ definition: edited, liveDefinition: GUARDED, liveVersion: 2, isActive: true, isDraft: false });
    const cap = plan();
    const { deps, calls } = harness(a, cap);
    const r = await call(publishAutomation, deps);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(calls.publish.length, 1);
    assert.strictEqual(cap.calls.length, 0);
});

test('publish: removing the privacy step is never gated', async () => {
    const a = routine({ definition: PLAIN, liveDefinition: GUARDED, liveVersion: 2, isActive: true, isDraft: false });
    const cap = plan();
    const { deps } = harness(a, cap);
    const r = await call(publishAutomation, deps);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(cap.calls.length, 0);
});

test('publish: the first publish of a never-live routine with a privacy step needs the plan', async () => {
    const refused = harness(routine({ definition: GUARDED }), plan());
    assert.strictEqual((await call(publishAutomation, refused.deps)).status, 403);
    const allowed = harness(routine({ definition: GUARDED }), plan([PRIVACY]));
    assert.strictEqual((await call(publishAutomation, allowed.deps)).status, 200);
});
