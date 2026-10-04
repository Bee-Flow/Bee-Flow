'use strict';

/**
 * Activation wakes the compliance work for THAT automation — the same minute,
 * not at the next sweep.
 *
 * compliance/scheduler.js runs every six hours, and until this landed it was
 * the only thing that ever moved a verdict. Switch an automation on at 09:05 and
 * the last word on the workspace was the 06:00 sweep — a sweep that could not
 * have seen it. For the rest of the morning the Compliance Center described a
 * workspace this automation was not in: green, confident, and silent about a
 * thing now running unattended with personal data in it. An evening
 * activation was not looked at until the next day.
 *
 * Four properties, and every one of them is load-bearing:
 *
 *   1. the review is QUEUED on activation, for this automation, in the
 *      organisation whose checks can actually see it;
 *   2. it happens AFTER the response — nobody waits behind a spinner for a
 *      compliance sweep;
 *   3. anything going wrong in the compliance path leaves the activation
 *      alone: the automation is already on and the user has already been told;
 *   4. an activation that was REFUSED queues nothing — compliance must not be
 *      told about an automation that did not go live.
 *
 * Run: node --test --test-force-exit server/routes/automation/crud.complianceOnActivate.test.js
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
let USERS = {};
let queued = [];
let seq = 0;
let reviewThrows = false;
let userLookupThrows = false;
const userLookups = [];

mock(path.join(SERVER, 'stores/automationStore'), {
    getAutomation: async (id) => AUTOMATIONS[id] || null,
    updateAutomation: async (id, updates) => { AUTOMATIONS[id] = { ...AUTOMATIONS[id], ...updates }; return AUTOMATIONS[id]; },
    getSubscriptionsForAutomation: async () => [],
    deleteSubscriptionsForAutomation: async () => {},
    createSubscription: async () => ({ id: 'sub-0' }),
    updateSubscription: async () => true,
});
mock(path.join(SERVER, 'stores/userStore'), {
    getUser: async (id) => {
        userLookups.push(id);
        if (userLookupThrows) throw new Error('users table unreachable');
        return USERS[id] || null;
    },
});
mock(path.join(SERVER, 'compliance/subjectReview'), {
    reviewAutomation: (orgId, automationId, opts) => {
        if (reviewThrows) throw new Error('compliance queue exploded');
        queued.push({ orgId, automationId, reason: opts && opts.reason, seq: ++seq });
    },
});
mock(path.join(SERVER, 'automation/cron'), { nextRunAt: () => null });
mock(path.join(SERVER, 'automation/validate'), { validateDefinition: () => ({ ok: true, warnings: [] }) });
mock(path.join(SERVER, 'automation/summarise'), { summariseDefinition: () => ({ summary: '' }) });
mock(path.join(SERVER, 'automation/deliverableEvents'), { getDeliverableEvents: () => [] });
mock(path.join(SERVER, 'automation/toolRegistry'), { TOOL_REGISTRY: [], loadTools: () => [] });
mock(path.join(SERVER, 'automation/triggerBus'), {
    getPublicBaseUrl: () => null,
    loadSession: async () => null,
    revokeSubscription: async () => {},
    fetchLatestGmailMatch: async () => null,
    dispatchEvent: async () => [],
});
mock(path.join(SERVER, 'automation/triggerBus/dispatch'), {
    dispatchEvent: async () => [],
    dispatchToSubscription: () => [],
});
mock(path.join(SERVER, 'utils/perUserRateLimit'), { perUserRateLimit: () => (req, res, next) => next() });
// The real pin reader: the refusal case below turns on the activation gate,
// and a stub of the reader would be testing the stub.
const realPortability = require(path.join(SERVER, 'automation/portability'));
mock(path.join(SERVER, 'automation/portability'), {
    buildExport: () => ({}),
    sanitizeImport: () => ({ automation: null, errors: ['not used'] }),
    rekeyDefinition: (d) => ({ definition: d }),
    collectPinnedNodes: realPortability.collectPinnedNodes,
});
mock(path.join(SERVER, 'core/integrations/integrationTools'), { getUserPermittedApps: async () => new Set() });

const crudRouter = require('./crud');

function findHandler(router, method, routePath) {
    for (const layer of router.stack) {
        if (layer.route && layer.route.path === routePath && layer.route.methods[method]) {
            return layer.route.stack[layer.route.stack.length - 1].handle;
        }
    }
    throw new Error(`route not found: ${method} ${routePath}`);
}

function makeRes() {
    const res = { statusCode: 200, body: null, jsonSeq: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; res.jsonSeq = ++seq; return res; };
    return res;
}

const activateHandler = findHandler(crudRouter, 'post', '/:id/activate');
const deactivateHandler = findHandler(crudRouter, 'post', '/:id/deactivate');

// Enough turns for the fire-and-forget chain (microtask → user lookup → queue).
const flushAsync = () => new Promise(r => setImmediate(() => setImmediate(() => setImmediate(r))));

function reset() {
    AUTOMATIONS = {}; USERS = {}; queued = []; seq = 0;
    reviewThrows = false; userLookupThrows = false; userLookups.length = 0;
}

function automation(id, extra = {}) {
    AUTOMATIONS[id] = {
        id, userId: 'user1', isActive: false, isDraft: true, triggerType: 'manual', scheduleCron: null,
        definition: { trigger: { id: 'trg1', kind: 'manual' }, steps: [], edges: [] },
        ...extra,
    };
    return { params: { id }, session: { user: { id: 'user1' }, isAdmin: false }, body: {} };
}

test('activating an automation queues a compliance review of THAT automation', async () => {
    reset();
    const req = automation('auto1', { organizationId: 'org-acme' });
    const res = makeRes();
    await activateHandler(req, res);
    await flushAsync();

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(AUTOMATIONS.auto1.isActive, true);
    assert.deepStrictEqual(
        queued.map(q => [q.orgId, q.automationId, q.reason]),
        [['org-acme', 'auto1', 'activation']],
        'one review, of this automation, in its own organisation — not a workspace sweep',
    );
});

test('the review is queued AFTER the response — the user does not wait for compliance', async () => {
    reset();
    const req = automation('auto2', { organizationId: 'org-acme' });
    const res = makeRes();
    await activateHandler(req, res);
    await flushAsync();

    assert.strictEqual(queued.length, 1);
    assert.ok(res.jsonSeq !== null && res.jsonSeq < queued[0].seq,
        `the activation response must be written before any compliance work is queued (response #${res.jsonSeq}, queue #${queued[0].seq})`);
});

test('the organisation is the AUTOMATION\'S, falling back to its OWNER\'S — the checks scope by that COALESCE', async () => {
    reset();
    // Automations saved before organization_id was stamped carry NULL; the
    // compliance subject queries fall back to the owner's organisation
    // (COALESCE(a.organization_id, u."organizationId")), so this must too or
    // the review asks a dashboard that cannot see the automation.
    USERS.user1 = { id: 'user1', organizationId: 'org-from-owner' };
    const req = automation('auto3', { organizationId: null });
    await activateHandler(req, makeRes());
    await flushAsync();
    assert.deepStrictEqual(queued.map(q => q.orgId), ['org-from-owner']);
    const unstampedReads = userLookups.length;

    queued = [];
    userLookups.length = 0;
    USERS.user1 = { id: 'user1', organizationId: 'org-from-owner' };
    const req2 = automation('auto4', { organizationId: 'org-on-the-row' });
    await activateHandler(req2, makeRes());
    await flushAsync();
    assert.deepStrictEqual(queued.map(q => q.orgId), ['org-on-the-row'], 'the row wins when it has one');
    const stampedReads = userLookups.length;
    // ...and the owner is not read AT ALL then. "First, then" is an order, not
    // a pair of reads: the fallback costs an identity round-trip, so a row
    // that already carries its organisation must not pay it. Measured as the
    // DIFFERENCE between the two activations rather than as an absolute count,
    // because the handler reads identities for its own reasons as well (orgOf,
    // the agent catalogue) and those are the same on both paths. The agent
    // gate measures the same property from the other side: activating a
    // automation that names no agent reads no identity at all
    // (crud.agentGate.test.js, 'and no identity read either') — which is the
    // assertion the unconditional read had turned red.
    // Two readers ask for the automation's organisation on activation: this
    // compliance review and the AI Act gate (automation/aiActCheck.js, which
    // checks the organisation's compliance hub licence). Each follows the same
    // "first, then" rule, so the unstamped row pays one fallback read per
    // reader and the stamped row pays none.
    assert.strictEqual(unstampedReads - stampedReads, 2,
        'a stamped row answers the question by itself; only the unstamped one pays for the fallback');
});

test('an automation with no organisation at all queues nothing — no check could match it', async () => {
    reset();
    USERS.user1 = { id: 'user1', organizationId: null };
    const req = automation('auto5', { organizationId: null });
    const res = makeRes();
    await activateHandler(req, res);
    await flushAsync();
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(queued, []);
});

test('a compliance queue that throws does NOT fail the activation', async () => {
    reset();
    reviewThrows = true;
    const req = automation('auto6', { organizationId: 'org-acme' });
    const res = makeRes();
    await activateHandler(req, res);
    await flushAsync();

    assert.strictEqual(res.statusCode, 200, 'the automation is on and the user was told so — compliance cannot retract that');
    assert.strictEqual(AUTOMATIONS.auto6.isActive, true);
});

test('an organisation lookup that throws does NOT fail the activation', async () => {
    reset();
    userLookupThrows = true;
    const req = automation('auto7', { organizationId: null });
    const res = makeRes();
    await activateHandler(req, res);
    await flushAsync();

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(AUTOMATIONS.auto7.isActive, true);
    assert.deepStrictEqual(queued, [], 'and nothing is queued against a guessed organisation');
});

test('a REFUSED activation queues nothing — compliance is not told about an automation that never went live', async () => {
    reset();
    const req = automation('auto8', { organizationId: 'org-acme' });
    // An edited pin is a hard 400: the automation stays off (see
    // crud.activateCatchup.test.js for the rule itself).
    AUTOMATIONS.auto8.definition.steps = [{
        id: 's1', type: 'notification', title: 'x', body: 'y',
        pinnedOutput: { total: 999999 }, pinnedSource: 'edited',
    }];
    const res = makeRes();
    await activateHandler(req, res);
    await flushAsync();

    assert.strictEqual(res.statusCode, 400, JSON.stringify(res.body));
    assert.strictEqual(AUTOMATIONS.auto8.isActive, false);
    assert.deepStrictEqual(queued, [], 'nothing changed, so there is nothing to re-judge');
});

test('deactivating queues a review too — a finding about an automation nobody runs is wrong', async () => {
    reset();
    const req = automation('auto9', { organizationId: 'org-acme', isActive: true, isDraft: false });
    const res = makeRes();
    await deactivateHandler(req, res);
    await flushAsync();

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(AUTOMATIONS.auto9.isActive, false);
    assert.deepStrictEqual(
        queued.map(q => [q.orgId, q.automationId, q.reason]),
        [['org-acme', 'auto9', 'deactivation']],
    );
    assert.ok(res.jsonSeq < queued[0].seq, 'and it still lands after the response');
});

test('on-off-on-off reaches the queue as four asks about ONE automation, which the queue then coalesces', async () => {
    reset();
    for (let i = 0; i < 2; i++) {
        await activateHandler(automation('auto10', { organizationId: 'org-acme' }), makeRes());
        await deactivateHandler(automation('auto10', { organizationId: 'org-acme', isActive: true }), makeRes());
    }
    await flushAsync();
    // The route's job is to ASK; compliance/subjectReview.js is what collapses
    // the asks into one run (subjectReview.test.js pins that). What matters
    // here is that every ask names one automation and one organisation — the
    // route never reaches for a full-workspace sweep.
    assert.strictEqual(queued.length, 4);
    assert.deepStrictEqual([...new Set(queued.map(q => q.automationId))], ['auto10']);
    assert.deepStrictEqual([...new Set(queued.map(q => q.orgId))], ['org-acme']);
});
