/**
 * supportSlaEnforcer: the scheduled tick follows the runtime module switch, and
 * a breach reaches the team chat channel.
 *
 * BFSF-438: boot starts the enforcer from the deploy-time catalog flag and
 * never looked again, so removing Support in the admin Modules panel left a
 * running pod flagging SLA breaches and writing notifications. The tick now
 * goes through the module gate; the exported slaTick stays ungated.
 *
 * BFSF-448: "An SLA is breached" was a checkbox in the chat settings with
 * nothing behind it: an admin could tick it and never hear a thing. The
 * enforcer is where a breach happens, so it sends, for the company inbox only,
 * because the sweep covers every organisation's inbox and a customer
 * organisation's tickets are not Bee Flow's to post.
 *
 * The stores are stubbed through testUtils/stubRequire; the gate is injected
 * through start({ gate }).
 *
 * Run: cd server && node --test services/supportSlaEnforcer.test.js
 */

'use strict';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const { installResolveStub } = require('../testUtils/stubRequire');
const { mountGated } = require('../testUtils/gatedStart');

const calls = { chat: [], getThread: [], events: [], staff: [] };
let firstBreaches = [];
let resolutionBreaches = [];
let threads = {};
let chatFails = false;
let breachReads = 0;

const restoreStubs = installResolveStub({
    '../stores/supportStore': {
        flagFirstResponseBreaches: async () => { breachReads += 1; return firstBreaches; },
        flagResolutionBreaches: async () => resolutionBreaches,
        recordThreadEvent: async (e) => { calls.events.push(e); },
        getThread: async (id) => { calls.getThread.push(id); return threads[id] || null; },
        getSlaPolicy: async () => null,
    },
    '../stores/notificationStore': { createNotification: async () => ({}) },
    '../support/notifications': { notifyStaff: (n) => { calls.staff.push(n); } },
    '../support/events': { supportEvents: { emit() {} } },
    './outboundChatNotifier': {
        notify: async (n) => {
            calls.chat.push(n);
            if (chatFails) throw new Error('chat is down');
            return { sent: true };
        },
    },
});
const enforcer = require('./supportSlaEnforcer');

after(() => restoreStubs());

beforeEach(() => {
    calls.chat = []; calls.getThread = []; calls.events = []; calls.staff = [];
    firstBreaches = []; resolutionBreaches = []; threads = {}; chatFails = false;
    breachReads = 0;
});

test('slaTick itself stays ungated: it flags breaches when called directly', async () => {
    await enforcer.slaTick();
    assert.strictEqual(breachReads, 1);
});

test('BFSF-438: the scheduled tick goes through the support module gate', async () => {
    const w = mountGated((opts) => enforcer.start(opts), { intervalMs: 1000 });
    try {
        assert.deepStrictEqual(w.state.consulted.map(c => [c.moduleId, c.fn]), [['support', enforcer.slaTick]]);
        assert.strictEqual(w.timers.length, 1);
        assert.strictEqual(w.timers[0].delay, 1000);

        // Support removed in the Modules panel: nothing is flagged.
        w.state.active = false;
        breachReads = 0;
        await w.fireAll();
        assert.strictEqual(breachReads, 0, 'a removed Support module still flagged SLA breaches');

        w.state.active = true;
        await w.fireAll();
        assert.strictEqual(breachReads, 1, 'the gated tick no longer reaches the enforcer');
    } finally {
        enforcer.stop();
    }
});

const companyRow = { id: 'th-company', subject: 'Synthetic', assignee_user_id: null, organization_id: null, inbox_id: null };
const tenantRow = { id: 'th-tenant', subject: 'Synthetic', assignee_user_id: null, organization_id: 'org-1', inbox_id: 'inbox-1' };
const companyThread = { id: 'th-company', ticket_ref: 'BF-1001', source: 'in_app', priority: 'high', inbox_id: null };

test('a company-inbox breach sends sla_breach with the full thread row', async () => {
    firstBreaches = [companyRow];
    threads = { 'th-company': companyThread };

    await enforcer.slaTick();
    assert.strictEqual(calls.chat.length, 1);
    assert.strictEqual(calls.chat[0].event, 'sla_breach');
    assert.strictEqual(calls.chat[0].thread, companyThread);
    assert.strictEqual(calls.chat[0].detail, 'First-response SLA missed');
});

test('a resolution breach says which clock ran out', async () => {
    resolutionBreaches = [companyRow];
    threads = { 'th-company': companyThread };
    await enforcer.slaTick();
    assert.strictEqual(calls.chat[0].detail, 'Resolution SLA missed');
});

test('a customer organisation\'s inbox breach stays out of the team channel', async () => {
    firstBreaches = [tenantRow];
    await enforcer.slaTick();
    assert.strictEqual(calls.chat.length, 0);
    assert.deepStrictEqual(calls.getThread, [], 'not even read for the card');
    // The breach itself is still recorded.
    assert.strictEqual(calls.events[0].action, 'sla_breach');
});

test('a chat outage does not stop the sweep', async () => {
    chatFails = true;
    firstBreaches = [companyRow, { ...companyRow, id: 'th-second' }];
    threads = { 'th-company': companyThread, 'th-second': { ...companyThread, id: 'th-second' } };

    await enforcer.slaTick();
    assert.strictEqual(calls.chat.length, 2);
    assert.strictEqual(calls.events.length, 2);
});
