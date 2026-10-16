'use strict';

/**
 * Starting a run on an automation that uses the CALLER's own connections
 * (runPolicy.connections = 'caller') from the manual-run endpoint:
 *   - a person other than the owner sees the one-time notice first (409
 *     caller_notice_required, naming the apps), acknowledges it once, then runs;
 *   - the sample trigger payload is read from THEIR account, never the owner's;
 *   - the starter is the session user, whatever the body claims;
 *   - the owner is never asked.
 *
 * Route handlers invoked directly (same technique as runs.triggerStepId.test.js).
 * Run: node --test routes/automation/runs.callerConnections.test.js
 */
const { test, after } = require('node:test');
const assert = require('node:assert');
const { serverStubber } = require('../../testUtils/stubServer');

const mock = serverStubber();

const seen = new Map();
const calls = { execute: [], gmailLookups: [] };
const DEF = {
    trigger: { id: 'trg', kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new', filter: null } },
    steps: [{ id: 's1', type: 'integration_action', tool: 'gmail_search' }],
    edges: [{ from: 'trg', to: 's1' }],
    runPolicy: { connections: 'caller' },
};
const AUTOMATION = { id: 'a1', userId: 'owner1', organizationId: 'org1', definition: DEF };
const grow = () => { AUTOMATION.definition = { ...DEF, steps: [...DEF.steps, { id: 's2', type: 'knowledge_write' }] }; };

mock('stores/automationStore', {
    getAutomation: async (id) => (id === 'a1' ? { ...AUTOMATION } : null),
    getRunSteps: async () => [],
    listSharesForAutomation: async () => [{ principalType: 'user', principalId: 'user2', role: 'run' }, { principalType: 'user', principalId: 'editor3', role: 'edit' }],
    getCallerNoticeAck: async (u, a) => (seen.has(`${u}:${a}`) ? seen.get(`${u}:${a}`) : null),
    markCallerNoticeSeen: async (u, a, items) => { seen.set(`${u}:${a}`, items); },
});
mock('stores/userStore', { getUser: async (id) => ({ id, organizationId: 'org1', groups: [] }) });
mock('auth/permissions', { hasPermission: async () => false });
mock('core/automationRunner', {
    executeAutomation: async (a, opts) => { calls.execute.push(opts); return { id: 'run-1', status: 'success' }; },
});
mock('core/integrations/connectionResolution', { providerForTool: (t) => (t.startsWith('gmail_') ? 'google' : (t.startsWith('outlook_') ? 'microsoft' : null)) });
mock('automation/triggerBus', {
    fetchLatestGmailMatch: async (userId) => { calls.gmailLookups.push(userId); return { messageId: 'm1' }; },
    fetchLatestNextcloudMatch: async () => null,
});
mock('core/scheduling/cron', { nextRunAt: () => null });
mock('automation/deliverableEvents', { getDeliverableEvents: () => [], isPushPending: () => false });
mock('utils/perUserRateLimit', { perUserRateLimit: () => (req, res, next) => next() });

const { runRoute: runRouteOf, makeRes } = require('../../testUtils/routeHandlers');
const router = require('./runs');
const runRoute = (method, routePath) => runRouteOf(router, method, routePath);
after(() => { setImmediate(() => process.exit(process.exitCode || 0)); });

const run = runRoute('post', '/:id/run');
const getNotice = runRoute('get', '/:id/caller-notice');
const ackNotice = runRoute('post', '/:id/caller-notice/seen');
const req = (userId, body = {}) => ({ params: { id: 'a1' }, query: {}, session: { user: { id: userId } }, body });

test('the first run by a shared user is held for the notice, which names the apps', async () => {
    const res = await run(req('user2'), makeRes());
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'caller_notice_required');
    assert.deepStrictEqual(res.body.details?.providers ?? res.body.providers, ['Google']);
    assert.deepStrictEqual(res.body.details?.destinations ?? res.body.destinations, []);
    assert.strictEqual(calls.execute.length, 0, 'nothing ran');
    const info = await getNotice(req('user2'), makeRes());
    assert.deepStrictEqual(info.body, { applies: true, seen: false, providers: ['Google'], destinations: [], items: ['app:google'] });
});

test('after the acknowledgement it runs, as the session user, with a sample from THEIR account', async () => {
    const ack = await ackNotice(req('user2', { items: ['app:google'] }), makeRes());
    assert.strictEqual(ack.statusCode, 200);
    const info = await getNotice(req('user2'), makeRes());
    assert.strictEqual(info.body.seen, true);
    // The body schema is strict: a claimed starter is refused outright, not believed.
    const forged = await run(req('user2', { startedByUserId: 'owner1' }), makeRes());
    assert.strictEqual(forged.statusCode, 400);
    assert.strictEqual(calls.execute.length, 0);
    const res = await run(req('user2'), makeRes());
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(calls.execute[0].startedByUserId, 'user2');
    assert.deepStrictEqual(calls.gmailLookups, ['user2'], 'the owner\'s mailbox is never read for the sample');
});

test('the notice is per person: another sharer still sees it; the owner never does and gets their own sample', async () => {
    const owner = await getNotice(req('owner1'), makeRes());
    assert.deepStrictEqual(owner.body, { applies: false, seen: false, providers: [], destinations: [], items: [] });
    calls.execute.length = 0; calls.gmailLookups.length = 0;
    const res = await run(req('owner1'), makeRes());
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(calls.gmailLookups, ['owner1']);
    assert.strictEqual(calls.execute[0].startedByUserId, 'owner1');
});

test('a person with no access cannot read or acknowledge the notice', async () => {
    const info = await getNotice(req('stranger'), makeRes());
    assert.strictEqual(info.statusCode, 403);
    const ack = await ackNotice(req('stranger', { items: [] }), makeRes());
    assert.strictEqual(ack.statusCode, 403);
    assert.ok(!seen.has('stranger:a1'));
});

test('the notice names owner-controlled destinations and comes back when the automation grows one', async () => {
    assert.strictEqual((await getNotice(req('user2'), makeRes())).body.seen, true);
    grow();
    const info = await getNotice(req('user2'), makeRes());
    assert.deepStrictEqual([info.body.seen, info.body.destinations], [false, ['knowledge_base']]);
    assert.strictEqual((await run(req('user2'), makeRes())).statusCode, 409);
    await ackNotice(req('user2', { items: ['app:google', 'dest:knowledge_base'] }), makeRes());
    assert.deepStrictEqual(seen.get('user2:a1'), ['app:google', 'dest:knowledge_base']);
    assert.strictEqual((await getNotice(req('user2'), makeRes())).body.seen, true);
});

test('only what the person was shown is acknowledged: a changed notice is refused (409), nothing recorded', async () => {
    const before = seen.get('user2:a1');
    grow();   // the knowledge-base destination is now part of the notice; this person saw only Google
    const res = await ackNotice(req('user2', { items: ['app:google'] }), makeRes());
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'caller_notice_changed');
    assert.deepStrictEqual(seen.get('user2:a1'), before);
    // Items nobody named are dropped, not stored.
    const ok = await ackNotice(req('user2', { items: ['app:google', 'dest:knowledge_base', 'app:invented'] }), makeRes());
    assert.strictEqual(ok.statusCode, 200);
    assert.deepStrictEqual(seen.get('user2:a1'), ['app:google', 'dest:knowledge_base']);
});

test('an editor\'s one confirmation covers the live AND the working copy, so a test run cannot loop on the notice', async () => {
    // The working copy (what a Test runs) has a Microsoft step that is not live yet.
    AUTOMATION.liveVersion = 1;
    AUTOMATION.liveDefinition = { ...DEF };
    AUTOMATION.definition = { ...DEF, steps: [...DEF.steps, { id: 's3', type: 'integration_action', tool: 'outlook_send' }] };
    const info = await getNotice(req('editor3'), makeRes());
    assert.deepStrictEqual(info.body.items, ['app:google', 'app:microsoft']);
    await ackNotice(req('editor3', { items: info.body.items }), makeRes());
    const test = await run(req('editor3', { test: true }), makeRes());
    assert.strictEqual(test.statusCode, 200, JSON.stringify(test.body));
    assert.strictEqual(calls.execute.at(-1).startedByUserId, 'editor3');
});
