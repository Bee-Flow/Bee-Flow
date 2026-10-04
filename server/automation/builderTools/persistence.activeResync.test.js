'use strict';

/**
 * persistDraft on an ACTIVE automation re-syncs the trigger rows the engine
 * fires from — app_event subscriptions and secondary automation_schedules —
 * exactly the way PUT /:id does, and with the same fingerprint gates.
 *
 * Before 2026-09-04 the MCP builder's save path skipped this entirely: an
 * edited Gmail filter kept firing on the old subscription, a new secondary
 * schedule never fired at all, until the owner deactivated and re-activated.
 *
 * The real subscriptionSync / scheduleSync run here against a mocked store,
 * so what is asserted is the rows they would write.
 *
 * Run: node --test --test-force-exit automation/builderTools/persistence.activeResync.test.js
 */
const { test, beforeEach } = require('node:test');
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

let stored = null;
let subscriptionsCreated = [];
let subscriptionWipes = 0;
let schedulesUpserted = [];
let createShouldThrow = false;

mock(path.join(SERVER, 'stores/automationStore'), {
    getAutomation: async () => stored,
    updateAutomation: async (id, updates) => { stored = { ...stored, ...updates }; return stored; },
    createAutomation: async () => { throw new Error('not used here'); },
    getSubscriptionsForAutomation: async () => [],
    deleteSubscriptionsForAutomation: async () => { subscriptionWipes += 1; },
    createSubscription: async (opts) => {
        if (createShouldThrow) throw new Error('gmail down');
        subscriptionsCreated.push(opts);
        return { id: `sub-${subscriptionsCreated.length}`, ...opts };
    },
    updateSubscription: async () => true,
    upsertSchedule: async (opts) => { schedulesUpserted.push(opts); return { id: `sch-${schedulesUpserted.length}`, ...opts }; },
    deleteSchedulesExcept: async () => {},
});
mock(path.join(SERVER, 'automation/triggerBus'), {
    getPublicBaseUrl: () => null,
    loadSession: async () => null,
    revokeSubscription: async () => {},
});
mock(path.join(SERVER, 'automation/validate'), { validateDefinition: () => ({ ok: true, errors: [], warnings: [] }) });
mock(path.join(SERVER, 'automation/deliverableEvents'), { getDeliverableEvents: () => [] });
mock(path.join(SERVER, 'automation/datatableUsageSync'), { syncDatatableUsage: async () => {} });
mock(path.join(SERVER, 'automation/approvalService'), { validateApprovalAssignees: async () => [] });

const { persistDraft } = require('./persistence');

const gmail = (filter, extra = {}) => ({ id: 'trg', type: 'trigger', kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new', filter }, ...extra });
const sched = (cron) => ({ id: 'trig_s', type: 'trigger', kind: 'schedule', schedule: { cron, tz: 'Europe/Amsterdam' } });
const def = (trigger, triggers = []) => ({ schemaVersion: 2, trigger, triggers, steps: [{ id: 's1', type: 'set', fields: {} }], edges: [] });

beforeEach(() => {
    subscriptionsCreated = [];
    subscriptionWipes = 0;
    schedulesUpserted = [];
    createShouldThrow = false;
});

test('an active automation whose app_event filter changed gets its subscription rebuilt', async () => {
    stored = { id: 'a1', userId: 'u1', isActive: true, definition: def(gmail({ labelId: 'INBOX' })) };
    await persistDraft({ automationId: 'a1', userId: 'u1', def: def(gmail({ labelId: 'Label_9' })) });
    assert.strictEqual(subscriptionWipes, 1);
    assert.strictEqual(subscriptionsCreated.length, 1);
    assert.deepStrictEqual(subscriptionsCreated[0].filter, { labelId: 'Label_9' });
    assert.strictEqual(subscriptionsCreated[0].triggerStepId, 'trg');
    assert.strictEqual(subscriptionsCreated[0].userId, 'u1');
    assert.strictEqual(schedulesUpserted.length, 0, 'no schedule trigger came or went');
});

test('a label-only edit on an active automation leaves the subscription (and its poller cursor) alone', async () => {
    stored = { id: 'a1', userId: 'u1', isActive: true, definition: def(gmail({ labelId: 'INBOX' }, { label: 'Old name' })) };
    await persistDraft({ automationId: 'a1', userId: 'u1', def: def(gmail({ labelId: 'INBOX' }, { label: 'New name' })) });
    assert.strictEqual(subscriptionWipes, 0);
    assert.strictEqual(subscriptionsCreated.length, 0);
    assert.strictEqual(schedulesUpserted.length, 0);
});

test('an INACTIVE automation never touches subscriptions or schedules — activate does that', async () => {
    stored = { id: 'a1', userId: 'u1', isActive: false, definition: def(gmail({ labelId: 'INBOX' })) };
    await persistDraft({ automationId: 'a1', userId: 'u1', def: def(gmail({ labelId: 'Label_9' }), [sched('0 7 * * 1-5')]) });
    assert.strictEqual(subscriptionWipes, 0);
    assert.strictEqual(subscriptionsCreated.length, 0);
    assert.strictEqual(schedulesUpserted.length, 0);
});

test('a new or changed secondary schedule on an active automation gets its schedule row', async () => {
    stored = { id: 'a1', userId: 'u1', isActive: true, definition: def(gmail({ labelId: 'INBOX' }), [sched('0 7 * * 1-5')]) };
    await persistDraft({ automationId: 'a1', userId: 'u1', def: def(gmail({ labelId: 'INBOX' }), [sched('0 8 * * 1-5')]) });
    assert.strictEqual(subscriptionWipes, 0, 'the app_event config did not change');
    assert.strictEqual(schedulesUpserted.length, 1);
    assert.strictEqual(schedulesUpserted[0].automationId, 'a1');
    assert.strictEqual(schedulesUpserted[0].triggerStepId, 'trig_s');
    assert.strictEqual(schedulesUpserted[0].cron, '0 8 * * 1-5');
});

test('a sync failure is logged, never thrown — the save already landed', async () => {
    createShouldThrow = true;
    stored = { id: 'a1', userId: 'u1', isActive: true, definition: def(gmail({ labelId: 'INBOX' })) };
    const origWarn = console.warn;
    const warned = [];
    console.warn = (m) => warned.push(String(m));
    try {
        const saved = await persistDraft({ automationId: 'a1', userId: 'u1', def: def(gmail({ labelId: 'Label_9' })) });
        assert.strictEqual(saved.isActive, true);
        assert.ok(warned.some(w => w.includes('subscription re-sync failed')), warned.join('\n'));
    } finally {
        console.warn = origWarn;
    }
});
