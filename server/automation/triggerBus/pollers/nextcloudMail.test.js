// @typecheck
'use strict';

/**
 * The Nextcloud Mail poller (nextcloudMail.mts): the backstop and the
 * no-connector path of `mail.new`. First sight anchors, later ticks hand out
 * what is above the cursor, oldest first, and a message the push already
 * handed out is not handed out again.
 *
 * Run: node --test automation/triggerBus/pollers/nextcloudMail.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { pollNextcloudMail } = require('./nextcloudMail.mts');

/**
 * @param {{ messages?: Record<string, unknown>[], accounts?: Record<string, unknown>[], cursorAfterPush?: string | null }} [opts]
 */
function world(opts = {}) {
    /** @type {{ name: string, args: Record<string, unknown> }[]} */
    const calls = [];
    /** @type {Record<string, unknown>[]} */
    const writes = [];
    const sub = { id: 'sub-1', userId: 'alice', filter: /** @type {Record<string, unknown> | null} */ (null), lastCursor: /** @type {string | null} */ (null) };
    const results = /** @type {Record<string, unknown>} */ ({
        nextcloud_mail_list_accounts: { accounts: opts.accounts ?? [{ id: 3 }, { id: 4 }] },
        nextcloud_mail_list_mailboxes: { mailboxes: [{ id: 12, specialRole: 'inbox' }, { id: 13, specialRole: 'sent' }] },
        nextcloud_mail_search: { messages: opts.messages ?? [] },
    });
    const ctx = {
        store: () => ({
            getSubscription: async () => ({ lastCursor: opts.cursorAfterPush !== undefined ? opts.cursorAfterPush : sub.lastCursor }),
            updateSubscription: async (/** @type {string} */ _id, /** @type {Record<string, unknown>} */ patch) => { writes.push(patch); sub.lastCursor = /** @type {string} */ (patch.lastCursor); },
        }),
        nextcloudMailTools: () => ({
            executeNextcloudMailTool: async (/** @type {string} */ name, /** @type {Record<string, unknown>} */ args) => { calls.push({ name, args }); return /** @type {any} */ (results[name]); },
        }),
        ncScopeGuard: () => ({ guardedNcCall: async (/** @type {string} */ _n, /** @type {unknown} */ _a, /** @type {unknown} */ _w, /** @type {() => Promise<any>} */ run) => run() }),
    };
    return { ctx, sub, calls, writes, results };
}

const msg = (/** @type {number} */ id, extra = {}) => ({ id, from: 'boss@example.com', subject: `m${id}`, dateInt: 1763200000 + id, hasAttachments: false, ...extra });

test('first sight anchors at the newest message and hands out nothing', async () => {
    const w = world({ accounts: [{ id: 3 }], messages: [msg(10), msg(11)] });
    assert.deepStrictEqual(await pollNextcloudMail(w.ctx, w.sub, {}), []);
    assert.deepStrictEqual(JSON.parse(String(w.sub.lastCursor)), { boxes: { 12: 11 } });
    assert.deepStrictEqual(w.calls.map((c) => c.name), ['nextcloud_mail_list_accounts', 'nextcloud_mail_list_mailboxes', 'nextcloud_mail_search']);
    assert.deepStrictEqual(w.calls[2].args, { mailboxId: 12, limit: 25 }, 'the inbox');
});

test('later ticks hand out what is above the cursor, oldest first, in the push\'s shape', async () => {
    const w = world({ accounts: [{ id: 3 }], messages: [msg(13, { hasAttachments: true }), msg(11), msg(12)] });
    w.sub.lastCursor = JSON.stringify({ boxes: { 12: 11 } });
    const events = await pollNextcloudMail(w.ctx, w.sub, {});
    assert.deepStrictEqual(events.map((e) => e.messageId), [12, 13]);
    assert.deepStrictEqual(events[1], {
        accountId: 3, mailboxId: 12, messageId: 13, from: 'boss@example.com', subject: 'm13', hasAttachments: true,
        receivedAt: new Date((1763200000 + 13) * 1000).toISOString(), datetime: new Date((1763200000 + 13) * 1000).toISOString(), mailboxRole: 'inbox',
    });
    assert.deepStrictEqual(JSON.parse(String(w.sub.lastCursor)), { boxes: { 12: 13 } });
});

test('a message a push handed out meanwhile is not handed out again', async () => {
    const w = world({ accounts: [{ id: 3 }], messages: [msg(12), msg(13)], cursorAfterPush: JSON.stringify({ boxes: { 12: 12 } }) });
    w.sub.lastCursor = JSON.stringify({ boxes: { 12: 11 } });
    const events = await pollNextcloudMail(w.ctx, w.sub, {});
    assert.deepStrictEqual(events.map((e) => e.messageId), [13]);
});

test('filter.accountId and filter.mailboxId narrow what is read', async () => {
    const w = world({ messages: [] });
    w.sub.filter = { accountId: 4, mailboxId: 13 };
    await pollNextcloudMail(w.ctx, w.sub, {});
    assert.deepStrictEqual(w.calls.filter((c) => c.name !== 'nextcloud_mail_list_accounts').map((c) => c.args), [{ accountId: 4 }, { mailboxId: 13, limit: 25 }]);
});

test('accounts that cannot be read are a failure (the polling pass escalates it)', async () => {
    const w = world();
    w.results.nextcloud_mail_list_accounts = { error: 'Nextcloud Mail is not installed' };
    await assert.rejects(pollNextcloudMail(w.ctx, w.sub, {}), /Mail is not installed/);
});
