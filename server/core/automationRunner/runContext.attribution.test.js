/**
 * The run context names who caused the run: the starter (Run / Test button,
 * an agent's asker, a signed-in form submitter) or, failing that, the form
 * submitter recorded on the run. A scheduled or webhook run has nobody, and
 * says so with null rather than repeating the owner.
 *
 * Run: node --test core/automationRunner/runContext.attribution.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { buildRunContext } = require('./runContext');

const ctxOf = (run) => buildRunContext({
    automation: { id: 'a1', userId: 'owner', definition: {} },
    runOrgId: 'org-1', isResume: false, session: null,
    run: { id: 'r1', triggerPayload: null, ...run },
    tokenVault: null, runPolicy: null, stepRecord: null,
    effectiveMode: 'live', onlyStepId: null, fromStepId: null, emitLifecycle: () => {},
    enteredTrigger: { id: 't', kind: 'manual' },
    identity: { runUserGroupIds: [], runUserOrgRole: null, runUserHomeOrgId: null, runIdentityError: null },
});

test('the starter is the actor; the owner stays userId; the run id is carried', () => {
    const ctx = ctxOf({ startedByUserId: 'starter' });
    assert.strictEqual(ctx.actorUserId, 'starter');
    assert.strictEqual(ctx.userId, 'owner');
    assert.strictEqual(ctx.runId, 'r1');
});

test('a form submitter is the actor when nobody started the run by hand', () => {
    assert.strictEqual(ctxOf({ submittedByUserId: 'submitter' }).actorUserId, 'submitter');
    assert.strictEqual(ctxOf({ startedByUserId: 'starter', submittedByUserId: 'submitter' }).actorUserId, 'starter');
});

test('a run nobody caused (schedule, webhook) has a null actor', () => {
    assert.strictEqual(ctxOf({}).actorUserId, null);
});
