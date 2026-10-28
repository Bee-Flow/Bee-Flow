// @typecheck
'use strict';

/**
 * Regression tests for the two P0 cross-tenant fan-out fail-open bugs in
 * triggerBus/dispatch.js:
 *   - dispatchEvent: a Nextcloud event with no resolved userId used to
 *     fan out to EVERY tenant's subscriptions (no org filter applied).
 *   - dispatchOrgScopedEvent: a null orgId used to skip the org filter
 *     entirely instead of failing closed.
 *
 * Run: node --test automation/triggerBus.dispatch.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('assert');

// Stub automationStore, userStore and the runner before requiring dispatch.js
// (synthetic subscriptions spanning two orgs' users; see triggerBus.testkit.js).
const { installDispatchStubs, tick } = require('./triggerBus.testkit');
const { SUBS, USERS, dispatchedRuns, dispatchedPayloads: runs } = installDispatchStubs();

const { dispatchEvent, dispatchToSubscription, dispatchOrgScopedEvent } = require('./triggerBus/dispatch');

test('dispatchEvent: nextcloud event with no userId AND no orgId is dropped, not fanned out', async () => {
    dispatchedRuns.length = 0;
    const runs = await dispatchEvent({ provider: 'nextcloud', event: 'file.changed', payload: {} });
    await tick();
    assert.deepStrictEqual(runs, [], 'no orgId to scope to → drop, never fan out cross-tenant');
    assert.deepStrictEqual(dispatchedRuns, []);
});

test('dispatchEvent: nextcloud event with no userId but a real orgId only reaches that org\'s subscriptions', async () => {
    dispatchedRuns.length = 0;
    // An unknown actor (guest, bot, federated) fans out across the org, each
    // delivery checked against what the subscriber can see (#191): a checker
    // that says yes to everyone isolates the org test from that check.
    const seeAll = { check: async () => ({ visible: true }), tagNames: async () => [] };
    const runs = await dispatchEvent({ provider: 'nextcloud', event: 'file.changed', payload: {}, orgId: 'org-A', ncVisibility: seeAll });
    await tick();
    assert.deepStrictEqual(dispatchedRuns, ['auto-orgA'], 'only the org-A subscriber\'s automation runs');
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].subId, 'sub-orgA');
});

const supportPayload = { genuineContact: true };

test('dispatchOrgScopedEvent: null orgId fails closed (no cross-tenant fan-out)', async () => {
    dispatchedRuns.length = 0;
    const runs = await dispatchOrgScopedEvent('support', 'ticket.resolved', supportPayload, null);
    await tick();
    assert.deepStrictEqual(runs, [], 'missing orgId must drop the event, not fan out to every org');
    assert.deepStrictEqual(dispatchedRuns, []);
});

test('dispatchOrgScopedEvent: real orgId only reaches that org\'s subscriptions', async () => {
    dispatchedRuns.length = 0;
    const runs = await dispatchOrgScopedEvent('support', 'ticket.resolved', supportPayload, 'org-B');
    await tick();
    assert.deepStrictEqual(dispatchedRuns, ['auto-orgB']);
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].subId, 'sub-orgB');
});

// GitHub (and any other provider that is neither user-scoped nor org-scoped)
// must NOT be collaterally dropped by the nextcloud-motivated orgId gate —
// it has its own (separately tracked, WS1.2) isolation gap, but the P0 fix
// here must not silently kill an unrelated, currently-working feature.
test('dispatchEvent: github event with no userId and no orgId is still dispatched (not collaterally dropped)', async () => {
    dispatchedRuns.length = 0;
    const runs = await dispatchEvent({ provider: 'github', event: 'push', payload: {} });
    await tick();
    assert.strictEqual(runs.length, 2, 'unscoped provider still fans out to matching subs, unchanged from before the orgId gate');
    assert.deepStrictEqual(dispatchedRuns.sort(), ['auto-orgA', 'auto-orgB']);
});

// Regression: polling used to route discovered events through the broad
// dispatchEvent() fan-out, which double-fires automations when a user has
// two sibling subscriptions on the same provider+event (sub A's poll tick
// dispatches to both A and B; sub B's own later poll tick rediscovers the
// same item via its own cursor and dispatches to both again).
test('dispatchToSubscription: only dispatches to the ONE subscription given, not sibling subs on the same provider+event+user', async () => {
    dispatchedRuns.length = 0;
    const siblingSubs = [
        { id: 'sub-1', automationId: 'auto-1', userId: 'user-orgA', filter: null },
        { id: 'sub-2', automationId: 'auto-2', userId: 'user-orgA', filter: null },
    ];
    const runs = dispatchToSubscription(siblingSubs[0], { provider: 'gmail', event: 'mail.new', payload: {} });
    await tick();
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].subId, 'sub-1');
    assert.deepStrictEqual(dispatchedRuns, ['auto-1'], 'sibling sub-2 (same user, same provider+event) must NOT also fire');
});

// A connector install pushes file.new / file.changed AND the activity poller
// owns them (subscriptionSync forces mode='polling'), so a push must not also
// fire a polling-mode subscription. Other events and webhook-mode subs keep
// the push path.
test('dispatchEvent: push file.new / file.changed skips polling-mode subs (the poller is authoritative)', async () => {
    const saved = SUBS.splice(0, SUBS.length,
        { id: 'sub-poll', automationId: 'auto-poll', userId: 'user-orgA', mode: 'polling', lastCursor: 'c1', filter: null },
        { id: 'sub-hook', automationId: 'auto-hook', userId: 'user-orgA', mode: 'webhook', filter: null });
    try {
        for (const event of ['file.new', 'file.changed']) {
            dispatchedRuns.length = 0;
            await dispatchEvent({ provider: 'nextcloud', event, payload: {}, userId: 'user-orgA', orgId: 'org-A' });
            await tick();
            assert.deepStrictEqual(dispatchedRuns, ['auto-hook'], `${event}: only the webhook-mode sub fires from a push`);
        }
        dispatchedRuns.length = 0;
        await dispatchEvent({ provider: 'nextcloud', event: 'file.deleted', payload: {}, userId: 'user-orgA', orgId: 'org-A' });
        await tick();
        assert.deepStrictEqual(dispatchedRuns.sort(), ['auto-hook', 'auto-poll'], 'push-only events are unchanged');
        // A polling sub the poller has not bootstrapped yet (no cursor) still gets the push.
        SUBS[0].lastCursor = null;
        dispatchedRuns.length = 0;
        await dispatchEvent({ provider: 'nextcloud', event: 'file.new', payload: {}, userId: 'user-orgA', orgId: 'org-A' });
        await tick();
        assert.deepStrictEqual(dispatchedRuns.sort(), ['auto-hook', 'auto-poll']);
    } finally {
        SUBS.splice(0, SUBS.length, ...saved);
    }
});

// ── #191: org-scoped Nextcloud fan-out with a per-event visibility check ──
// The actor's own automations receive a pushed event; a colleague's only when
// its trigger opted in (filter.includeColleagues) AND the visibility check
// says the colleague can see the resource; an event whose actor is unknown is
// checked without an opt-in. isOwn / isOwnAction are stamped per subscription.

USERS['bob'] = { id: 'bob', organizationId: 'org-A' };
USERS['alice'] = { id: 'alice', organizationId: 'org-A' };
USERS['eve'] = { id: 'eve', organizationId: 'org-B' };

/**
 * A visibility checker answering from a table: `visible[userId]` is true,
 * false or an overrides object. Records who was asked.
 * @param {Record<string, boolean | Record<string, unknown>>} visible
 */
function checker(visible) {
    /** @type {string[]} */
    const asked = [];
    return {
        asked,
        check: async (userId) => {
            asked.push(userId);
            const v = visible[userId];
            if (v && typeof v === 'object') return { visible: true, overrides: v };
            return { visible: v === true };
        },
        tagNames: async () => ['Invoice'],
    };
}

const sub = (id, userId, filter = null) => ({ id, automationId: `auto-${id}`, userId, filter, mode: 'webhook' });
const fired = () => runs.map(r => r.automationId).sort();
const byAuto = (id) => runs.find(r => r.automationId === id)?.payload;

beforeEach(() => { runs.length = 0; dispatchedRuns.length = 0; });

async function dispatch(event, payload, actorUserId, ncVisibility) {
    const out = await dispatchEvent({ provider: 'nextcloud', event, payload, actorUserId, orgId: 'org-A', ncVisibility });
    await tick();
    return out;
}

test('actor B, subscriber A in the same org: no opt-in, no delivery (and no check is made)', async () => {
    SUBS.splice(0, SUBS.length, sub('alice', 'alice'), sub('bob', 'bob'));
    const vis = checker({ alice: true });
    await dispatch('talk.message.received', { roomToken: 'r1', message: 'hi', actor: 'nc-bob' }, 'bob', vis);
    assert.deepStrictEqual(fired(), ['auto-bob']);
    assert.deepStrictEqual(vis.asked, [], 'the switch is off: Nextcloud is not even asked');
    assert.strictEqual(byAuto('auto-bob').isOwn, true);
    assert.strictEqual(byAuto('auto-bob').isOwnAction, true);
});

test('actor B, subscriber A opted in and can see the room: A fires, stamped as not own', async () => {
    SUBS.splice(0, SUBS.length, sub('alice', 'alice', { includeColleagues: true, roomToken: 'r1' }), sub('bob', 'bob'));
    await dispatch('talk.message.received', { roomToken: 'r1', message: 'hi' }, 'bob', checker({ alice: true }));
    assert.deepStrictEqual(fired(), ['auto-alice', 'auto-bob']);
    assert.strictEqual(byAuto('auto-alice').isOwn, false);
    assert.strictEqual(byAuto('auto-alice').isOwnAction, false);
    assert.strictEqual(byAuto('auto-bob').isOwn, true);
});

test('opted in but NOT visible to A: no delivery', async () => {
    SUBS.splice(0, SUBS.length, sub('alice', 'alice', { includeColleagues: true }));
    const vis = checker({ alice: false });
    await dispatch('deck.card.created', { boardId: 12, cardId: 1 }, 'bob', vis);
    assert.deepStrictEqual(fired(), []);
    assert.deepStrictEqual(vis.asked, ['alice']);
});

test('a subscriber in another organisation never receives it, opted in or not', async () => {
    SUBS.splice(0, SUBS.length, sub('eve', 'eve', { includeColleagues: true }));
    const vis = checker({ eve: true });
    await dispatch('forms.submitted', { formId: 51 }, 'bob', vis);
    assert.deepStrictEqual(fired(), []);
    assert.deepStrictEqual(vis.asked, [], 'the org scope comes first');
});

test('excludeOwnMessages now works per subscription: own event skipped, colleague event kept', async () => {
    SUBS.splice(0, SUBS.length,
        sub('alice', 'alice', { includeColleagues: true, excludeOwnMessages: true }),
        sub('bob', 'bob', { excludeOwnMessages: true }));
    await dispatch('talk.message.received', { roomToken: 'r1', message: 'hi' }, 'bob', checker({ alice: true }));
    assert.deepStrictEqual(fired(), ['auto-alice']);
});

test('excludeOwnUploads on a pushed file event: own skipped, a colleague keeps it with the path in their tree', async () => {
    SUBS.splice(0, SUBS.length,
        sub('alice', 'alice', { includeColleagues: true, excludeOwnUploads: true, inFolder: '/Shared' }),
        sub('bob', 'bob', { excludeOwnUploads: true }));
    await dispatch('file.renamed', { id: 437, path: '/Team/x.pdf', owner: 'nc-bob', actor: 'nc-bob' }, 'bob',
        checker({ alice: { path: '/Shared/Team/x.pdf', name: 'x.pdf', extension: 'pdf', owner: 'nc-alice' } }));
    assert.deepStrictEqual(fired(), ['auto-alice']);
    const p = byAuto('auto-alice');
    assert.strictEqual(p.path, '/Shared/Team/x.pdf', 'the filter matched the subscriber\'s own path');
    assert.strictEqual(p.owner, 'nc-alice');
    assert.strictEqual(p.kind, 'file', 'canonical keys are present on the pushed payload');
    assert.strictEqual(p.activityId, null);
});

test('an unknown actor (guest, bot, public link) needs no opt-in but is checked for everyone', async () => {
    SUBS.splice(0, SUBS.length, sub('alice', 'alice'), sub('bob', 'bob'));
    const vis = checker({ alice: true, bob: false });
    await dispatch('talk.message.received', { roomToken: 'r1', message: 'from a guest' }, null, vis);
    assert.deepStrictEqual(fired(), ['auto-alice']);
    assert.deepStrictEqual(vis.asked.sort(), ['alice', 'bob']);
    assert.strictEqual(byAuto('auto-alice').isOwn, false);
});

test('without a checker nothing but the actor\'s own subscriptions fire (fail closed)', async () => {
    SUBS.splice(0, SUBS.length, sub('alice', 'alice', { includeColleagues: true }), sub('bob', 'bob'));
    await dispatch('talk.message.received', { roomToken: 'r1' }, 'bob', null);
    assert.deepStrictEqual(fired(), ['auto-bob']);
    runs.length = 0;
    await dispatch('talk.message.received', { roomToken: 'r1' }, null, null);
    assert.deepStrictEqual(fired(), []);
});

test('calendar events stay with the actor even when a colleague opted in', async () => {
    SUBS.splice(0, SUBS.length, sub('alice', 'alice', { includeColleagues: true }), sub('bob', 'bob'));
    // The real checker answers "not visible" for an event type it cannot check.
    const { createNcVisibility } = require('./triggerBus/ncVisibility.mts');
    const real = createNcVisibility({
        loadSession: async () => ({}), resolveAuth: async () => { throw new Error('unused'); },
        runTool: async () => ({}), scopeDenied: async () => false,
    });
    await dispatch('calendar.event.created', { calendarId: 4, calendarUri: 'personal', uid: 'e1' }, 'bob', real);
    assert.deepStrictEqual(fired(), ['auto-bob']);
    assert.strictEqual(byAuto('auto-bob').calendarUri, 'personal');
});

test('includeColleagues is a delivery switch, never a payload condition', async () => {
    // tables.row.deleted has its own matcher; an event that falls back to the
    // shallow matchFilter (calendar.event.moved) must not compare it either.
    SUBS.splice(0, SUBS.length, sub('bob', 'bob', { includeColleagues: true }));
    await dispatch('calendar.event.moved', { calendarId: 4 }, 'bob', checker({}));
    assert.deepStrictEqual(fired(), ['auto-bob']);
});

test('file.tagged: a tagId given as a NAME matches once the names are looked up', async () => {
    SUBS.splice(0, SUBS.length, sub('bob', 'bob', { tagId: 'invoice' }), sub('bob2', 'bob', { tagId: 'Paid' }), sub('bob3', 'bob', { tagId: 3 }));
    await dispatch('file.tagged', { fileId: '437', tagIds: [3], tagId: 3 }, 'bob', checker({}));
    assert.deepStrictEqual(fired(), ['auto-bob', 'auto-bob3']);
});

test('a user-scoped dispatch (userId = the subscriber) is unchanged', async () => {
    SUBS.splice(0, SUBS.length, sub('alice', 'alice'), sub('bob', 'bob'));
    await dispatchEvent({ provider: 'nextcloud', event: 'file.deleted', payload: { path: '/x' }, userId: 'alice', orgId: 'org-A' });
    await tick();
    assert.deepStrictEqual(fired(), ['auto-alice']);
});
