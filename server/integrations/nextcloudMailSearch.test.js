// @typecheck strict
'use strict';
/**
 * nextcloud_mail_search reads the Mail cache (GET /api/messages) so parallel
 * searches no longer lock each other out with 409, retries a mailbox that a
 * running sync holds, and falls back to a full sync for an uncached mailbox.
 * Run: cd server && node --test integrations/nextcloudMailSearch.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

const { fetchMailSearch, toMailFilter } = require('./nextcloudMailSearch.mts');
const { executeNextcloudMailTool } = require('./nextcloudMailTools');
const { json, run } = require('./nextcloudToolTestHarness');

const BASE = 'https://nc.example.test';
const noWait = async () => {};
const NOT_CACHED = { status: 'fail', data: { message: 'mailbox 5 is not cached', type: 'OCA\\Mail\\Exception\\MailboxNotCachedException' } };
const LOCKED = { status: 'fail', data: { message: '5 is already being synced', type: 'OCA\\Mail\\Exception\\MailboxLockedException' } };

/** @param {(url: string, init: Record<string, unknown>) => unknown} handler */
function fakeFetch(handler) {
    /** @type {{ url: string, method: string, body?: unknown }[]} */
    const calls = [];
    const fetch = async (/** @type {string} */ url, /** @type {Record<string, unknown>} */ init = {}) => {
        calls.push({ url, method: String(init.method || 'GET'), body: init.body });
        return /** @type {any} */ (handler(url, init));
    };
    return { calls, fetch };
}

test('the tool searches the message cache with the filter, not the locking /sync endpoint', async () => {
    const { out, calls } = await run(executeNextcloudMailTool, 'nextcloud_mail_search', { mailboxId: 85, query: 'Azure AD', limit: 10 },
        async () => json(200, [{ databaseId: 9, subject: 'Azure AD sign-in' }]));
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, 'GET');
    const url = new URL(calls[0].url);
    assert.strictEqual(url.pathname, '/index.php/apps/mail/api/messages');
    assert.strictEqual(url.searchParams.get('mailboxId'), '85');
    assert.strictEqual(url.searchParams.get('filter'), 'subject:Azure%20AD from:Azure%20AD to:Azure%20AD match:anyof');
    assert.strictEqual(url.searchParams.get('limit'), '10');
    assert.strictEqual(url.searchParams.get('view'), 'singleton');
    assert.deepStrictEqual(out.messages.map((/** @type {{ id: number }} */ m) => m.id), [9]);
});

test('no query (the newest messages, as the mail trigger asks) syncs first, so new mail is there', async () => {
    const { calls, fetch } = fakeFetch(() => json(200, { newMessages: [{ databaseId: 2 }] }));
    const res = await fetchMailSearch({ mailboxId: 1, limit: 25 }, { baseUrl: BASE, fetch }, { wait: noWait });
    assert.deepStrictEqual(calls.map(c => [c.method, new URL(c.url).pathname]), [['POST', '/index.php/apps/mail/api/mailboxes/1/sync']]);
    assert.deepStrictEqual(JSON.parse(String(calls[0].body)), { ids: [], lastMessageTimestamp: null, init: true, sortOrder: 'newest' });
    assert.strictEqual(res.status, 200);
});

test('the newest-messages sync is retried too when the mailbox is locked', async () => {
    let n = 0;
    const { calls, fetch } = fakeFetch(() => (++n < 2 ? json(409, LOCKED) : json(200, { newMessages: [] })));
    const res = await fetchMailSearch({ mailboxId: 1, limit: 25 }, { baseUrl: BASE, fetch }, { delays: [1], wait: noWait });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(calls.length, 2);
});

test('a mailbox locked by a running sync is retried after a wait, then answers', async () => {
    let n = 0;
    const { calls, fetch } = fakeFetch(() => (++n < 3 ? json(409, LOCKED) : json(200, [{ databaseId: 1 }])));
    /** @type {number[]} */
    const waits = [];
    const res = await fetchMailSearch({ mailboxId: 5, query: 'x', limit: 5 }, { baseUrl: BASE, fetch },
        { delays: [10, 20, 30], wait: async (ms) => { waits.push(ms); } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(calls.length, 3);
    assert.deepStrictEqual(waits, [10, 20]);
});

test('a mailbox that stays locked gives up after the last retry with the 409', async () => {
    const { calls, fetch } = fakeFetch(() => json(409, LOCKED));
    const res = await fetchMailSearch({ mailboxId: 5, query: 'x', limit: 5 }, { baseUrl: BASE, fetch }, { delays: [1, 1], wait: noWait });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(calls.length, 3);
});

test('an uncached mailbox falls back to one full sync with the query', async () => {
    const { calls, fetch } = fakeFetch((url) => (url.includes('/sync') ? json(200, { newMessages: [{ databaseId: 4 }] }) : json(400, NOT_CACHED)));
    const res = await fetchMailSearch({ mailboxId: 5, query: 'Entra', limit: 5 }, { baseUrl: BASE, fetch }, { wait: noWait });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(calls.map(c => c.method), ['GET', 'POST']);
    assert.match(calls[1].url, /\/mailboxes\/5\/sync$/);
    assert.deepStrictEqual(JSON.parse(String(calls[1].body)), { ids: [], lastMessageTimestamp: null, init: true, sortOrder: 'newest', query: 'subject:Entra from:Entra to:Entra match:anyof' });
});

test('another 400 is not mistaken for an uncached mailbox and keeps the id advice', async () => {
    const { calls, fetch } = fakeFetch(() => json(400, { status: 'fail', data: { message: 'bad', type: 'OCA\\Mail\\Exception\\ClientException' } }));
    const res = await fetchMailSearch({ mailboxId: 5, query: 'x', limit: 5 }, { baseUrl: BASE, fetch }, { wait: noWait });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(calls.length, 1);
    const { out } = await run(executeNextcloudMailTool, 'nextcloud_mail_search', { mailboxId: 5, query: 'x' }, async () => json(400, {}));
    assert.match(out.error, /Check the accountId/);
});

test('free text becomes the Mail UI search (Mail ignores words without key:)', () => {
    assert.strictEqual(toMailFilter('Entra'), 'subject:Entra from:Entra to:Entra match:anyof');
    assert.strictEqual(toMailFilter('single sign-on'), 'subject:single%20sign-on from:single%20sign-on to:single%20sign-on match:anyof');
    assert.strictEqual(toMailFilter(''), '');
    assert.strictEqual(toMailFilter(undefined), '');
});

test('operators pass through encoded; free text next to them narrows the subject', () => {
    assert.strictEqual(toMailFilter('from:pim@example.test'), 'from:pim%40example.test');
    assert.strictEqual(toMailFilter('subject:"single sign-on" is:unread'), 'subject:single%20sign-on is:unread');
    assert.strictEqual(toMailFilter('from:pim azure'), 'from:pim subject:azure match:allof');
    assert.strictEqual(toMailFilter('has:attachment invoice'), 'flags:attachments subject:invoice from:invoice to:invoice match:anyof');
    assert.strictEqual(toMailFilter('Re: offerte'), 'subject:Re%3A%20offerte from:Re%3A%20offerte to:Re%3A%20offerte match:anyof');
    assert.strictEqual(toMailFilter('azure match:allof'), 'match:allof subject:azure from:azure to:azure');
});
