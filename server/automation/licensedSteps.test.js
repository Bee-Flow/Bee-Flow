/**
 * Which steps need the plan before a routine goes live or runs as a test, and
 * what the refusal says (automation/licensedSteps.js).
 *
 * Pure: the capability answer is injected, so nothing here reaches a database.
 *
 * Proven:
 *   - guard, tokenize and approval are found wherever a step can sit (root,
 *     loop body, parallel branch, flowlet); untokenize and triggers never;
 *   - a privacy step already in the live version keeps its place, an approval
 *     step never does, and switching a live check to "hide" counts as new;
 *   - the refusal is a sentence in `error` with the licence code in `code`
 *     (feature_locked; feature_disabled when the plan has it but the org was
 *     not given it), requireCapability's feature / required / upgrade_url and
 *     one detail per step, and a 503 when the resolver could not answer;
 *   - a run of the live copy is never refused; a run of the working copy is,
 *     only for privacy steps, and a partial run only for its own step.
 *
 * Run: cd server && node --test automation/licensedSteps.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
    licensedStepsIn, stepsNeedingLicence, liveDefinitionOf, licenceRefusal,
    refusalForRun, refusalAsToolError, resolveCapabilityStates, PRIVACY_STEPS, APPROVALS,
} = require('./licensedSteps');

const guard = (id = 'g1', extra = {}) => ({ id, type: 'guard', sourceRef: 'trigger.output.text', ...extra });
const tokenize = (id = 't1', extra = {}) => ({ id, type: 'tokenize', sourceRef: 'trigger.output.text', ...extra });
const untokenize = (id = 'u1') => ({ id, type: 'untokenize', sourceRef: 'steps.t1.output.text' });
const approval = (id = 'ap1') => ({ id, type: 'approval', prompt: 'OK?' });
const wait = (id = 'w1') => ({ id, type: 'wait', seconds: 1 });

const def = (steps, extra = {}) => ({ trigger: { id: 'trg', kind: 'manual' }, steps, edges: [], ...extra });

/** A capabilityStates double: `granted` ids answer granted, `disabled` ids disabled, the rest locked. */
function states({ granted = [], disabled = [], degraded = false } = {}) {
    const calls = [];
    const fn = async (caps, who) => {
        calls.push({ caps, who });
        if (degraded) return { degraded: true, states: {} };
        const out = {};
        for (const c of caps) out[c] = granted.includes(c) ? 'granted' : disabled.includes(c) ? 'disabled' : 'locked';
        return { degraded: false, states: out };
    };
    fn.calls = calls;
    return fn;
}

/** A store row the way rowToAutomation hands it out: liveDefinition non-enumerable. */
function row({ definition, live = null, liveVersion = live ? 2 : null, userId = 'owner', organizationId = 'org1' } = {}) {
    const a = { id: 'a1', userId, organizationId, kind: 'automation', version: 3, liveVersion, definition };
    Object.defineProperty(a, 'liveDefinition', { value: live, enumerable: false, writable: true });
    return a;
}

// ── Finding the steps ────────────────────────────────────────────────────

test('guard, tokenize and approval are found in the root, loop bodies, parallel branches and flowlets', () => {
    const d = def([
        guard('g_root'),
        { id: 'loop', type: 'loop', overRef: 'trigger.output.items', body: [tokenize('t_loop')] },
        { id: 'par', type: 'parallel', branches: [[approval('ap_par')], [wait()]] },
    ], { layers: { clean: { trigger: { id: 'ltrg', kind: 'layer_input' }, steps: [guard('g_layer', { label: 'Scan the upload' })] } } });
    const found = licensedStepsIn(d);
    assert.deepStrictEqual(found.map(s => [s.id, s.type, s.layerKey, s.capability]), [
        ['g_root', 'guard', null, PRIVACY_STEPS],
        ['t_loop', 'tokenize', null, PRIVACY_STEPS],
        ['ap_par', 'approval', null, APPROVALS],
        ['g_layer', 'guard', 'clean', PRIVACY_STEPS],
    ]);
    assert.strictEqual(found[3].label, 'Scan the upload', 'the author\'s own name is used');
    assert.strictEqual(found[0].label, 'Check for personal data', 'else the step\'s default name');
});

test('untokenize is never a licensed step, and neither is a trigger', () => {
    const d = def([untokenize(), wait()], { trigger: { id: 'trg', kind: 'manual', type: 'guard' } });
    assert.deepStrictEqual(licensedStepsIn(d), []);
    assert.deepStrictEqual(stepsNeedingLicence(d, null), []);
});

// ── New versus already live ──────────────────────────────────────────────

test('with nothing live, every licensed step needs the plan', () => {
    const got = stepsNeedingLicence(def([guard(), tokenize(), approval()]), null);
    assert.deepStrictEqual(got.map(s => s.id), ['g1', 't1', 'ap1']);
});

test('a privacy step already in the live version keeps its place, whatever else changed', () => {
    const live = def([guard('g1', { label: 'Old name' }), tokenize()]);
    const working = def([guard('g1', { label: 'New name', categories: ['email'] }), tokenize(), wait()]);
    assert.deepStrictEqual(stepsNeedingLicence(working, live), []);
});

test('a privacy step that is not live yet counts, the live ones next to it do not', () => {
    const live = def([guard('g1')]);
    const working = def([guard('g1'), tokenize('t_new')]);
    assert.deepStrictEqual(stepsNeedingLicence(working, live).map(s => s.id), ['t_new']);
});

test('switching a live check to "hide" makes it a tokenize step that was never live', () => {
    const live = def([guard('p1')]);
    const working = def([tokenize('p1')]);
    assert.deepStrictEqual(stepsNeedingLicence(working, live).map(s => [s.id, s.type]), [['p1', 'tokenize']]);
});

test('the same id in another flowlet is another step', () => {
    const live = def([guard('g1')]);
    const working = def([guard('g1')], { layers: { other: { steps: [guard('g1')] } } });
    assert.deepStrictEqual(stepsNeedingLicence(working, live).map(s => s.layerKey), ['other']);
});

test('an approval step counts even when it is live: the runner refuses it anyway', () => {
    const d = def([approval()]);
    assert.deepStrictEqual(stepsNeedingLicence(d, d).map(s => s.id), ['ap1']);
});

test('a fill_document step needs studio_documents, live or not: the runner refuses it anyway', () => {
    const fill = { id: 'fd1', type: 'fill_document', documentId: 'doc-1' };
    const d = def([fill]);
    const found = stepsNeedingLicence(d, d);
    assert.deepStrictEqual(found.map(s => s.id), ['fd1']);
    assert.strictEqual(found[0].capability, 'studio_documents');
});

test('`only` narrows to the asked capabilities', () => {
    const d = def([guard(), approval()]);
    assert.deepStrictEqual(stepsNeedingLicence(d, null, { only: [PRIVACY_STEPS] }).map(s => s.id), ['g1']);
});

test('the live copy is read off the row, and a missing one means nothing is live', () => {
    const live = def([guard()]);
    assert.strictEqual(liveDefinitionOf(row({ definition: live, live })), live);
    assert.strictEqual(liveDefinitionOf(row({ definition: live })), null, 'never live');
    // liveVersion set but the object lost (a spread copy): fail closed, not "all live".
    assert.strictEqual(liveDefinitionOf({ liveVersion: 2, definition: live }), null);
});

// ── The refusal ──────────────────────────────────────────────────────────

test('nothing to check, nothing asked', async () => {
    const cap = states();
    assert.strictEqual(await licenceRefusal([], { userId: 'u' }, { capabilityStates: cap }), null);
    assert.strictEqual(cap.calls.length, 0);
});

test('granted: no refusal, and the owner is who is asked', async () => {
    const cap = states({ granted: [PRIVACY_STEPS] });
    const steps = stepsNeedingLicence(def([guard()]), null);
    assert.strictEqual(await licenceRefusal(steps, { userId: 'owner', orgId: 'org1' }, { capabilityStates: cap }), null);
    assert.deepStrictEqual(cap.calls[0], { caps: [PRIVACY_STEPS], who: { userId: 'owner', orgId: 'org1' } });
});

test('locked: a 403 feature_locked that names every step in words', async () => {
    const steps = stepsNeedingLicence(def([guard('g1', { label: 'Scan the invoice' })], {
        layers: { l: { steps: [tokenize('t9')] } },
    }), null);
    const r = await licenceRefusal(steps, { userId: 'owner' }, { capabilityStates: states() });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.code, 'feature_locked');
    assert.strictEqual(r.body.feature, PRIVACY_STEPS);
    assert.strictEqual(r.body.required, 'enterprise');
    assert.match(r.body.upgrade_url, /^https?:\/\//);
    assert.strictEqual(r.body.error, 'This routine cannot go live on your organisation\'s plan.', 'a sentence; the steps are in details');
    assert.strictEqual(r.body.details.length, 2);
    assert.match(r.body.details[0].message, /"Scan the invoice" is a Privacy Shield step/);
    assert.match(r.body.details[0].message, /Enterprise/);
    assert.strictEqual(r.body.details[0].path, 'steps[0]');
    assert.strictEqual(r.body.details[1].path, 'layers[l].steps[0]');
    assert.ok(r.body.details.every(d => d.severity === 'error' && d.hint && d.stepId));
});

test('approvals are refused in their own words', async () => {
    const steps = stepsNeedingLicence(def([approval()]), null);
    const r = await licenceRefusal(steps, { userId: 'owner' }, { capabilityStates: states({ granted: [PRIVACY_STEPS] }) });
    assert.strictEqual(r.body.feature, APPROVALS);
    assert.match(r.body.details[0].message, /asks a person for approval/);
});

test('only the refused capability\'s steps are listed', async () => {
    const steps = stepsNeedingLicence(def([guard(), approval()]), null);
    const r = await licenceRefusal(steps, { userId: 'owner' }, { capabilityStates: states({ granted: [APPROVALS] }) });
    assert.deepStrictEqual(r.body.details.map(d => d.stepId), ['g1']);
});

test('in the plan but not given to the organisation: feature_disabled, ask an admin', async () => {
    const steps = stepsNeedingLicence(def([guard()]), null);
    const r = await licenceRefusal(steps, { userId: 'owner' }, { capabilityStates: states({ disabled: [PRIVACY_STEPS] }) });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.code, 'feature_disabled');
    assert.strictEqual(r.body.required, undefined, 'no upgrade to offer');
    assert.match(r.body.details[0].hint, /administrator/);
});

test('locked wins over disabled when both are refused', async () => {
    const steps = stepsNeedingLicence(def([guard(), approval()]), null);
    const r = await licenceRefusal(steps, { userId: 'owner' }, { capabilityStates: states({ disabled: [PRIVACY_STEPS] }) });
    assert.strictEqual(r.body.code, 'feature_locked');
    assert.strictEqual(r.body.feature, APPROVALS);
    assert.strictEqual(r.body.details.length, 2);
});

test('a resolver that cannot answer is a 503, never "your plan lacks this"', async () => {
    const steps = stepsNeedingLicence(def([guard()]), null);
    const degraded = await licenceRefusal(steps, { userId: 'o' }, { capabilityStates: states({ degraded: true }) });
    assert.strictEqual(degraded.status, 503);
    assert.strictEqual(degraded.body.code, 'entitlement_unavailable');
    assert.match(degraded.body.error, /could not be checked/);
    const thrown = await licenceRefusal(steps, { userId: 'o' }, { capabilityStates: async () => { throw new Error('db down'); } });
    assert.strictEqual(thrown.status, 503);
});

test('the test stage says the routine cannot run, not that it cannot go live', async () => {
    const steps = stepsNeedingLicence(def([guard()]), null);
    const r = await licenceRefusal(steps, { userId: 'o' }, { stage: 'test', capabilityStates: states() });
    assert.match(r.body.error, /cannot run/);
    // Test-run screens show only the sentence, so the steps are in it too.
    assert.match(r.body.error, /is a Privacy Shield step/);
});

// ── resolveCapabilityStates against the resolver's own shapes ───────────

test('the resolver answer maps onto granted / locked / disabled, also from a serialised snapshot', async () => {
    const ent = {
        registry: { getCapability: (id) => ({ id, kind: 'beta' }) },
        resolveCapabilitySet: async () => ({
            degraded: false,
            // Read back from the session cache: Sets became `{}`, arrays survive.
            snapshot: { _sets: { ceiling: { beta: {} } }, ceiling: { beta: [APPROVALS] } },
            has: (id) => id === 'granted_one',
        }),
    };
    const got = await resolveCapabilityStates(['granted_one', APPROVALS, PRIVACY_STEPS], { userId: 'u' }, ent);
    assert.deepStrictEqual(got, { degraded: false, states: { granted_one: 'granted', [APPROVALS]: 'disabled', [PRIVACY_STEPS]: 'locked' } });
    const down = await resolveCapabilityStates([PRIVACY_STEPS], {}, { ...ent, resolveCapabilitySet: async () => ({ degraded: true }) });
    assert.strictEqual(down.degraded, true);
});

// ── Runs ─────────────────────────────────────────────────────────────────

test('a run of the live copy is never refused, even with a privacy step and no plan', async () => {
    const live = def([guard(), tokenize(), untokenize()]);
    const cap = states();
    const a = row({ definition: def([guard('g_new')]), live });
    assert.strictEqual(await refusalForRun(a, { mode: 'live', triggerKind: 'schedule' }, { capabilityStates: cap }), null);
    assert.strictEqual(await refusalForRun(a, { mode: 'live', triggerKind: 'manual' }, { capabilityStates: cap }), null);
    assert.strictEqual(cap.calls.length, 0, 'the plan is not even asked');
});

test('a test run of a working copy with a new privacy step is refused in words', async () => {
    const a = row({ definition: def([guard('g_new')]), live: def([wait()]) });
    const r = await refusalForRun(a, { mode: 'live', triggerKind: 'manual', isTest: true }, { capabilityStates: states(), callerId: 'owner', session: { s: 1 } });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.code, 'feature_locked');
    assert.match(r.body.error, /cannot run/);
    assert.deepStrictEqual(r.body.details.map(d => d.stepId), ['g_new']);
});

test('the owner is asked, with the caller\'s session only when the caller is the owner', async () => {
    const a = row({ definition: def([guard()]) });
    const mine = states({ granted: [PRIVACY_STEPS] });
    await refusalForRun(a, { mode: 'dry_run' }, { capabilityStates: mine, callerId: 'owner', session: { me: true } });
    assert.deepStrictEqual(mine.calls[0].who, { userId: 'owner', orgId: 'org1', session: { me: true } });
    const editor = states({ granted: [PRIVACY_STEPS] });
    await refusalForRun(a, { mode: 'dry_run' }, { capabilityStates: editor, callerId: 'editor', session: { me: false } });
    assert.deepStrictEqual(editor.calls[0].who, { userId: 'owner', orgId: 'org1', session: null });
});

test('a dry run, a builder step run and any run of a never-live routine run the working copy', async () => {
    const a = row({ definition: def([tokenize()]) });
    for (const opts of [{ mode: 'dry_run' }, { triggerKind: 'manual_step' }, { mode: 'live', triggerKind: 'manual' }]) {
        const r = await refusalForRun(a, opts, { capabilityStates: states() });
        assert.strictEqual(r?.status, 403, JSON.stringify(opts));
    }
});

test('a privacy step that is live runs in a test run too, and granted plans run everything', async () => {
    const live = def([guard()]);
    const a = row({ definition: def([guard(), wait('w2')]), live });
    assert.strictEqual(await refusalForRun(a, { isTest: true }, { capabilityStates: states() }), null);
    const b = row({ definition: def([guard('g_new')]), live });
    assert.strictEqual(await refusalForRun(b, { isTest: true }, { capabilityStates: states({ granted: [PRIVACY_STEPS] }) }), null);
});

test('untokenize never needs the plan, in any run', async () => {
    const cap = states();
    const a = row({ definition: def([untokenize(), untokenize('u2')]) });
    assert.strictEqual(await refusalForRun(a, { isTest: true }, { capabilityStates: cap }), null);
    assert.strictEqual(await refusalForRun(a, { mode: 'dry_run' }, { capabilityStates: cap }), null);
    assert.strictEqual(cap.calls.length, 0);
});

test('a test run is not refused for an approval: the runner answers that one itself', async () => {
    const a = row({ definition: def([approval()]) });
    assert.strictEqual(await refusalForRun(a, { isTest: true }, { capabilityStates: states() }), null);
});

test('a partial run of one step asks only about that step', async () => {
    const a = row({ definition: def([wait(), guard('g_new')]) });
    assert.strictEqual(await refusalForRun(a, { triggerKind: 'manual_step', onlyStepId: 'w1' }, { capabilityStates: states() }), null);
    const r = await refusalForRun(a, { triggerKind: 'manual_step', onlyStepId: 'g_new' }, { capabilityStates: states() });
    assert.strictEqual(r.status, 403);
});

test('the AI builder hears the refusal as a tool error it can repeat to the author', async () => {
    const a = row({ definition: def([guard('g1', { label: 'Scan it' }), tokenize('t1')]) });
    const refusal = await refusalForRun(a, { mode: 'dry_run', triggerKind: 'dry_run' }, { capabilityStates: states() });
    const out = refusalAsToolError(refusal);
    assert.strictEqual(out.code, 'feature_locked');
    assert.match(out.error, /cannot run/);
    assert.match(out.error, /"Scan it" is a Privacy Shield step/);
    assert.strictEqual(out.error.match(/Remove the step, or upgrade to Enterprise/g).length, 1, 'the same hint is said once');
    assert.strictEqual(refusalAsToolError(null), null);
});
