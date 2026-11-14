'use strict';

/**
 * http_request in an action a schedule trigger starts: it validates, the publish arms it and the
 * fire runs it as the owner. A trigger kind that lists it in `refusedKinds` still refuses it, and
 * a public page still may not post it.
 *
 * Run: cd server && node --test appStudio/triggers/httpRequestTrigger.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { triggerHarness } = require('../../testUtils/triggerHarness.testkit');
const { canonicalizeAppDefinition } = require('../canonicalize');
const { validateAppDefinition } = require('../validate');
const { emptyDefinition } = require('../componentSpecs');
const { _withTriggerKinds } = require('./triggerKinds.mts');
const { runsUnattended } = require('./unattendedPolicy.mts');
const { publicStepRefusal } = require('../../usecases/studioAppPublicStepGate.mts');
const schedule = require('./kinds/schedule.mts').default;

const h = triggerHarness({ before, after, beforeEach });
const { s, publish, row, pass, settle, definition, every, MINUTE } = h;

const MODEL = { tables: [], connectors: [{ id: 'conn_ab12cd', kind: 'rest', url: 'https://api.example.test/v1' }] };
const CALL = { kind: 'http_request', connectorId: 'conn_ab12cd', method: 'GET', path: '/v1/orders', resultVar: 'orders' };
const triggerCodes = (def) => validateAppDefinition(def, { dataModel: MODEL }).errors.filter((e) => e.code.startsWith('triggers.')).map((e) => e.code);

/** A canonical definition whose action `act_job1` calls the service, started by `triggers`. */
function withCall(triggers) {
    const base = canonicalizeAppDefinition(emptyDefinition()).def;
    return canonicalizeAppDefinition({ ...base, actions: { act_job1: { kind: 'sequence', steps: [CALL] } }, triggers }).def;
}

test('a schedule trigger may start an action that calls a web service: no trigger finding', () => {
    assert.equal(runsUnattended('http_request'), true);
    const def = withCall([{ id: 'tick', kind: 'schedule', actionId: 'act_job1', schedule: { everyMinutes: 15 } }]);
    assert.deepEqual(triggerCodes(def), []);
});

test('a trigger kind that refuses http_request still refuses it, and the schedule kind next to it does not', async () => {
    const record = { kind: 'record', since: 3, fields: ['tableId'], canon: (raw) => ({ tableId: String(raw.tableId) }), validate() {}, config: (t) => ({ tableId: t.tableId }), refusedKinds: ['http_request'], shape: '{…}', description: 'On a changed record.' };
    await _withTriggerKinds([schedule, record], () => {
        assert.equal(runsUnattended('http_request', record.refusedKinds), false);
        const def = withCall([
            { id: 'r', kind: 'record', actionId: 'act_job1', tableId: 'orders' },
            { id: 's', kind: 'schedule', actionId: 'act_job1', schedule: { everyMinutes: 15 } },
        ]);
        assert.deepEqual(triggerCodes(def), ['triggers.step_not_unattended'], 'only the record trigger is refused');
    });
});

test('the publish arms it and the fire runs the step as the owner', async () => {
    assert.deepEqual(await publish(definition([every(15)], [CALL])), { armed: 1, updated: 0, kept: 0, removed: 0 });
    s.clock += 15 * MINUTE;
    assert.equal((await pass()).fired, 1);
    const run = await settle((await row()).lastRunId);
    assert.equal(run.status, 'success', run.error);
    assert.equal(run.origin, 'trigger');
    assert.deepEqual(s.executed.map((e) => e.step.kind), ['http_request']);
    const { ctx } = s.executed[0];
    assert.deepEqual([ctx.viewerId, ctx.role], ['owner', 'owner'], 'the call is made as the owner');
});

test('a public page still may not post the step', () => {
    assert.equal(publicStepRefusal('http_request')?.status, 403);
});
