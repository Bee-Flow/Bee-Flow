// @typecheck
'use strict';

/**
 * A pushed Nextcloud `mail.new` (connector 2.1.0+) names no user: Mail's
 * background sync sends it. dispatch.js hands it to a subscription only when
 * the Mail account is that subscriber's own (the visibility check, asked as
 * them), whoever the actor was and whatever the filter says; never twice for
 * the same message (the cursor the poller shares), and a delivery moves that
 * cursor and stamps lastPushAt.
 *
 * Run: node --test automation/triggerBus.dispatch.mail.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const { installDispatchStubs, tick } = require('./triggerBus.testkit');
const { SUBS, USERS, dispatchedPayloads, storePath } = installDispatchStubs();

/** @type {{ id: string, patch: Record<string, unknown> }[]} */
const updates = [];
const store = /** @type {Record<string, any>} */ (require.cache[storePath]?.exports);
store.getSubscription = async (/** @type {string} */ id) => SUBS.find((s) => s.id === id) || null;
store.updateSubscription = async (/** @type {string} */ id, /** @type {Record<string, unknown>} */ patch) => {
    updates.push({ id, patch });
    const sub = /** @type {Record<string, unknown> | undefined} */ (SUBS.find((s) => s.id === id));
    if (sub && typeof patch.lastCursor === 'string') sub.lastCursor = patch.lastCursor;
};

const { dispatchEvent } = require('./triggerBus/dispatch');

const PUSHED = { accountId: 3, mailboxId: 12, messageId: 4711, subject: 'Invoice 2026-114', receivedAt: '2026-11-15T09:00:00.000Z', actor: null, actorName: null, datetime: '2026-11-15T09:00:00.000Z' };

// Two subscribers in org A: alice owns account 3, bob does not.
beforeEach(() => {
    SUBS.length = 0;
    SUBS.push(
        /** @type {any} */ ({ id: 'sub-alice', automationId: 'auto-alice', userId: 'alice', filter: null, lastCursor: null }),
        /** @type {any} */ ({ id: 'sub-bob', automationId: 'auto-bob', userId: 'bob', filter: { includeColleagues: true }, lastCursor: null }),
    );
    USERS.alice = { id: 'alice', organizationId: 'org-A' };
    USERS.bob = { id: 'bob', organizationId: 'org-A' };
    updates.length = 0;
    dispatchedPayloads.length = 0;
});

/** A checker where only alice owns account 3, and what it was asked. */
function aliceOwnsAccount3() {
    /** @type {string[]} */
    const asked = [];
    return {
        asked,
        check: async (/** @type {string} */ userId, /** @type {string} */ event, /** @type {Record<string, unknown>} */ payload) => {
            asked.push(`${userId}:${event}`);
            return userId === 'alice' && payload.accountId === 3
                ? { visible: true, overrides: { from: 'boss@example.com', hasAttachments: true, mailboxRole: 'inbox' } }
                : { visible: false };
        },
        tagNames: async () => [],
    };
}

test('only the account owner\'s automation runs, enriched with sender, attachments and mailbox role', async () => {
    const vis = aliceOwnsAccount3();
    const runs = await dispatchEvent({ provider: 'nextcloud', event: 'mail.new', payload: PUSHED, orgId: 'org-A', ncVisibility: vis });
    await tick();
    assert.deepStrictEqual(runs.map((r) => r.subId), ['sub-alice']);
    assert.deepStrictEqual(vis.asked.sort(), ['alice:mail.new', 'bob:mail.new'], 'every subscriber is asked, the colleague switch grants nothing');
    const payload = dispatchedPayloads[0].payload;
    assert.strictEqual(payload.from, 'boss@example.com');
    assert.strictEqual(payload.hasAttachments, true);
    assert.strictEqual(payload.mailboxRole, 'inbox');
    assert.strictEqual(payload.messageId, 4711);
});

test('a known actor is no shortcut: the owner check still decides', async () => {
    const vis = aliceOwnsAccount3();
    const runs = await dispatchEvent({ provider: 'nextcloud', event: 'mail.new', payload: PUSHED, orgId: 'org-A', actorUserId: 'bob', ncVisibility: vis });
    await tick();
    assert.deepStrictEqual(runs.map((r) => r.subId), ['sub-alice']);
});

test('a delivery moves the subscription cursor and stamps lastPushAt; the same message is not delivered twice', async () => {
    const vis = aliceOwnsAccount3();
    await dispatchEvent({ provider: 'nextcloud', event: 'mail.new', payload: PUSHED, orgId: 'org-A', ncVisibility: vis });
    await tick();
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0].id, 'sub-alice');
    assert.deepStrictEqual(JSON.parse(String(updates[0].patch.lastCursor)), { boxes: { 12: 4711 } });
    assert.ok(typeof updates[0].patch.lastPushAt === 'string');

    const again = await dispatchEvent({ provider: 'nextcloud', event: 'mail.new', payload: PUSHED, orgId: 'org-A', ncVisibility: vis });
    await tick();
    assert.deepStrictEqual(again, [], 'already handed out (by a push or the poller)');
});

test('no visibility checker means no delivery (fail closed)', async () => {
    const runs = await dispatchEvent({ provider: 'nextcloud', event: 'mail.new', payload: PUSHED, orgId: 'org-A', ncVisibility: null });
    await tick();
    assert.deepStrictEqual(runs, []);
});

test('the filter still applies to the owner: without a mailboxId only the inbox fires', async () => {
    const vis = aliceOwnsAccount3();
    vis.check = async () => ({ visible: true, overrides: { from: 'x@example.com', hasAttachments: false, mailboxRole: 'sent' } });
    SUBS.splice(1);
    const runs = await dispatchEvent({ provider: 'nextcloud', event: 'mail.new', payload: PUSHED, orgId: 'org-A', ncVisibility: vis });
    await tick();
    assert.deepStrictEqual(runs, []);
});
