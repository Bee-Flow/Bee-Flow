'use strict';

/**
 * The run endpoints can enter an automation through a chosen ADDITIONAL trigger.
 *
 * POST /:id/run, /:id/dry-run and /:id/steps/:stepId/run accept an optional
 * `triggerStepId`. A known secondary id becomes the runner's `rootStepId`; the
 * primary (or no id) keeps `rootStepId` null so nothing changes for an automation
 * with one trigger; an unknown id is a 400 — never a silent fall-back to the
 * primary, because the caller asked to test a specific root. The Gmail payload
 * synthesis on /run follows the chosen trigger's filter.
 *
 * Route handlers invoked directly — same require.cache Module mock +
 * findHandler technique as crud.multiTrigger.test.js.
 *
 * Run: node --test routes/automation/runs.triggerStepId.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

const SERVER = path.resolve(__dirname, '..', '..');
function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

let AUTOMATIONS = {};
const calls = { execute: [], partial: [], gmailLookups: [] };

mock(path.join(SERVER, 'stores/automationStore'), {
    getAutomation: async (id) => AUTOMATIONS[id] || null,
    getRunSteps: async () => [],
});
mock(path.join(SERVER, 'core/automationRunner'), {
    executeAutomation: async (a, opts) => { calls.execute.push({ id: a.id, ...opts }); return { id: `run-${calls.execute.length}`, status: 'success' }; },
    runPartial: async (a, stepId, opts) => { calls.partial.push({ id: a.id, stepId, ...opts }); return { id: `prun-${calls.partial.length}`, status: 'success' }; },
});
mock(path.join(SERVER, 'automation/triggerBus'), {
    fetchLatestGmailMatch: async (userId, filter) => { calls.gmailLookups.push(filter); return { messageId: 'm1', subject: 'latest' }; },
    fetchLatestNextcloudMatch: async () => null,
});
mock(path.join(SERVER, 'automation/cron'), { nextRunAt: () => null });
mock(path.join(SERVER, 'automation/deliverableEvents'), { getDeliverableEvents: () => [], isPushPending: () => false });
mock(path.join(SERVER, 'utils/perUserRateLimit'), { perUserRateLimit: () => (req, res, next) => next() });

const router = require('./runs');

function findHandler(method, routePath) {
    for (const layer of router.stack) {
        if (layer.route && layer.route.path === routePath && layer.route.methods[method]) {
            return layer.route.stack[layer.route.stack.length - 1].handle;
        }
    }
    throw new Error(`route not found: ${method} ${routePath}`);
}
function makeRes() {
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
}
const runHandler = findHandler('post', '/:id/run');
const dryRunHandler = findHandler('post', '/:id/dry-run');
const stepRunHandler = findHandler('post', '/:id/steps/:stepId/run');

const DEF = {
    trigger: { id: 'trg', kind: 'manual' },
    triggers: [
        { id: 'trig_mail', kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new', filter: { from: 'a@b.nl' } } },
        { id: 'trig_daily', kind: 'schedule', schedule: { cron: '0 7 * * 1-5', tz: 'Europe/Amsterdam' } },
    ],
    steps: [{ id: 's1', type: 'set', fields: {} }],
    edges: [{ from: 'trig_mail', to: 's1' }],
};
const req = (id, body = {}, stepId = null) => ({ params: stepId ? { id, stepId } : { id }, session: { user: { id: 'user1' } }, body });

test('an unknown triggerStepId is a 400 on every run endpoint, and nothing runs', async () => {
    AUTOMATIONS = { a1: { id: 'a1', userId: 'user1', definition: DEF } };
    for (const [h, extra] of [[runHandler, null], [dryRunHandler, null], [stepRunHandler, 's1']]) {
        const res = makeRes();
        await h(req('a1', { triggerStepId: 'trig_nope' }, extra), res);
        assert.strictEqual(res.statusCode, 400, JSON.stringify(res.body));
        assert.match(res.body.error, /Unknown triggerStepId "trig_nope"/);
        assert.match(res.body.error, /trig_mail \(app_event\)/);
    }
    assert.deepStrictEqual(calls.execute, []);
    assert.deepStrictEqual(calls.partial, []);
});

test('a secondary id becomes rootStepId; the primary or no id keeps it null', async () => {
    calls.execute.length = 0;
    AUTOMATIONS = { a1: { id: 'a1', userId: 'user1', definition: DEF } };
    await dryRunHandler(req('a1', { triggerStepId: 'trig_daily', triggerPayload: { now: 'x' } }), makeRes());
    await dryRunHandler(req('a1', { triggerStepId: 'trg' }), makeRes());
    await dryRunHandler(req('a1', {}), makeRes());
    assert.deepStrictEqual(calls.execute.map(c => [c.mode, c.rootStepId]), [['dry_run', 'trig_daily'], ['dry_run', null], ['dry_run', null]]);
    assert.deepStrictEqual(calls.execute[0].triggerPayload, { now: 'x' });
});

test('/run through a secondary Gmail trigger synthesises the payload from THAT trigger\'s filter', async () => {
    calls.execute.length = 0; calls.gmailLookups.length = 0;
    AUTOMATIONS = { a1: { id: 'a1', userId: 'user1', definition: DEF } };
    const res = makeRes();
    await runHandler(req('a1', { triggerStepId: 'trig_mail' }), res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(calls.gmailLookups, [{ from: 'a@b.nl' }]);
    assert.strictEqual(calls.execute.length, 1);
    assert.strictEqual(calls.execute[0].rootStepId, 'trig_mail');
    assert.strictEqual(calls.execute[0].triggerKind, 'manual');
    assert.deepStrictEqual(calls.execute[0].triggerPayload, { provider: 'gmail', event: 'mail.new', messageId: 'm1', subject: 'latest' });
    // The primary is manual: no Gmail lookup, no payload.
    calls.gmailLookups.length = 0;
    await runHandler(req('a1', {}), makeRes());
    assert.deepStrictEqual(calls.gmailLookups, []);
    assert.strictEqual(calls.execute[1].rootStepId, null);
});

test('/steps/:stepId/run forwards the chosen root to runPartial', async () => {
    calls.partial.length = 0;
    AUTOMATIONS = { a1: { id: 'a1', userId: 'user1', definition: DEF } };
    await stepRunHandler(req('a1', { mode: 'upTo', triggerStepId: 'trig_mail' }, 's1'), makeRes());
    assert.strictEqual(calls.partial.length, 1);
    assert.strictEqual(calls.partial[0].stepId, 's1');
    assert.strictEqual(calls.partial[0].mode, 'upTo');
    assert.strictEqual(calls.partial[0].rootStepId, 'trig_mail');
    await stepRunHandler(req('a1', {}, 's1'), makeRes());
    assert.strictEqual(calls.partial[1].rootStepId, null, 'no id → runPartial picks the root itself');
});
