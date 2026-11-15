// @typecheck
'use strict';

/**
 * Nextcloud `mail.new`: the owner check (ncMailVisibility.mts), the cursor
 * both producers share (ncMailCursor.mts), the filter (filtersNcMail.mts via
 * pickMatcher) and the canonical payload (ncPayload.mts).
 *
 * Run: node --test automation/triggerBus/ncMail.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { mailOwnerDecision, senderOf, mailboxRoleOf } = require('./ncMailVisibility.mts');
const { advanceMailCursor, alreadyHandedOut, parseMailCursor, MAX_BOXES } = require('./ncMailCursor.mts');
const { pickMatcher } = require('./filters');
const { normaliseNextcloudPayload } = require('./ncPayload.mts');
const { COLLEAGUE_SWITCH_EVENTS, visibilityKind } = require('./ncVisibility.mts');

const PUSHED = { accountId: 3, mailboxId: 12, messageId: 4711, subject: 'Invoice' };

/**
 * A subscriber's Mail as the API answers it.
 * @param {{ accounts?: unknown, mailboxes?: unknown, message?: unknown, status?: number }} [over]
 */
function fakeMail(over = {}) {
    /** @type {string[]} */
    const urls = [];
    const answers = {
        '/accounts': over.accounts ?? [{ accountId: 3, emailAddress: 'alice@example.com' }],
        '/mailboxes?accountId=3': over.mailboxes ?? [{ databaseId: 12, name: 'INBOX', specialRole: 'inbox' }, { databaseId: 13, name: 'Sent', specialUse: ['\\Sent'] }],
        '/messages/4711': over.message ?? { databaseId: 4711, mailboxId: 12, subject: 'Invoice 2026-114', from: [{ label: 'Boss', email: 'boss@example.com' }], flags: { hasAttachments: true } },
    };
    const auth = {
        baseUrl: 'https://cloud.example',
        fetch: async (/** @type {string} */ url) => {
            urls.push(url);
            const path = url.slice('https://cloud.example/index.php/apps/mail/api'.length);
            const body = /** @type {Record<string, unknown>} */ (answers)[path];
            const status = over.status ?? (body === undefined ? 404 : 200);
            return { ok: status < 300, status, text: async () => JSON.stringify(body ?? null) };
        },
    };
    return { auth, urls };
}

const allow = async () => false;

test('the owner sees the event, with sender, attachment flag, mailbox role and Mail\'s subject', async () => {
    const { auth, urls } = fakeMail();
    const d = await mailOwnerDecision(auth, PUSHED, allow);
    assert.deepStrictEqual(d, { visible: true, overrides: { from: 'boss@example.com', hasAttachments: true, mailboxRole: 'inbox', subject: 'Invoice 2026-114' } });
    assert.ok(urls.every((u) => !u.includes('/body')), 'never the body');
});

test('an account that is not in the subscriber\'s own list is not theirs', async () => {
    const { auth } = fakeMail({ accounts: [{ accountId: 9 }] });
    assert.deepStrictEqual(await mailOwnerDecision(auth, PUSHED, allow), { visible: false });
});

test('the Mail scope decides first, and nothing is asked when it refuses', async () => {
    const { auth, urls } = fakeMail();
    /** @type {unknown[]} */
    const seen = [];
    const deny = async (/** @type {string} */ name, /** @type {unknown} */ args) => { seen.push([name, args]); return true; };
    assert.deepStrictEqual(await mailOwnerDecision(auth, PUSHED, deny), { visible: false });
    assert.deepStrictEqual(seen, [['nextcloud_mail_list_mailboxes', { accountId: 3 }]]);
    assert.deepStrictEqual(urls, []);
});

test('fails closed: a message in another mailbox, an error, missing ids', async () => {
    assert.strictEqual((await mailOwnerDecision(fakeMail({ message: { mailboxId: 13 } }).auth, PUSHED, allow)).visible, false);
    assert.strictEqual((await mailOwnerDecision(fakeMail({ status: 500 }).auth, PUSHED, allow)).visible, false);
    assert.strictEqual((await mailOwnerDecision(fakeMail().auth, { ...PUSHED, messageId: null }, allow)).visible, false);
    assert.strictEqual((await mailOwnerDecision(fakeMail().auth, { ...PUSHED, accountId: '3 OR 1' }, allow)).visible, false);
    assert.strictEqual((await mailOwnerDecision(fakeMail({ mailboxes: [] }).auth, PUSHED, allow)).visible, false);
});

test('sender and role helpers', () => {
    assert.strictEqual(senderOf([{ label: 'A', email: 'a@x.test' }, { label: 'Only a name' }]), 'a@x.test, Only a name');
    assert.strictEqual(senderOf([]), null);
    assert.strictEqual(mailboxRoleOf({ specialUse: ['\\Sent'] }), 'sent');
    assert.strictEqual(mailboxRoleOf({ specialRole: 'inbox' }), 'inbox');
    assert.strictEqual(mailboxRoleOf({}), null);
});

test('mail.new reaches the owner only: no colleague switch', () => {
    assert.strictEqual(visibilityKind('mail.new'), 'mail_account');
    assert.strictEqual(COLLEAGUE_SWITCH_EVENTS.has('mail.new'), false);
});

test('the cursor: per mailbox, never lowered, other shapes read as empty', () => {
    let c = advanceMailCursor(null, 12, 100);
    assert.ok(alreadyHandedOut(c, 12, 100));
    assert.ok(alreadyHandedOut(c, '12', '99'));
    assert.ok(!alreadyHandedOut(c, 12, 101));
    assert.ok(!alreadyHandedOut(c, 13, 5), 'another mailbox has its own cursor');
    c = advanceMailCursor(c, 12, 50);
    assert.deepStrictEqual(parseMailCursor(c), { boxes: { 12: 100 } });
    assert.deepStrictEqual(parseMailCursor('{"firedIds":[]}'), { boxes: {} });
    assert.deepStrictEqual(parseMailCursor('9001'), { boxes: {} });
    assert.deepStrictEqual(parseMailCursor('not json'), { boxes: {} });
});

test('the cursor keeps the mailboxes with the most recent messages', () => {
    let c = null;
    for (let box = 1; box <= MAX_BOXES + 5; box++) c = advanceMailCursor(c, box, box * 10);
    const boxes = parseMailCursor(c).boxes;
    assert.strictEqual(Object.keys(boxes).length, MAX_BOXES);
    assert.strictEqual(boxes[1], undefined, 'the quietest dropped');
    assert.strictEqual(boxes[MAX_BOXES + 5], (MAX_BOXES + 5) * 10);
});

test('the filter: account, mailbox (inbox by default), sender, subject, attachments', () => {
    const match = pickMatcher('nextcloud', 'mail.new');
    const p = normaliseNextcloudPayload('mail.new', { ...PUSHED, from: 'Boss@Example.com', hasAttachments: true, mailboxRole: 'inbox' });
    assert.strictEqual(match(p, null), true);
    assert.strictEqual(match(p, { accountId: '3', fromContains: 'boss@', subjectContains: 'INVOICE', hasAttachment: true }), true);
    assert.strictEqual(match(p, { accountId: 4 }), false);
    assert.strictEqual(match(p, { fromContains: 'other' }), false);
    assert.strictEqual(match(p, { hasAttachment: false }), false);
    assert.strictEqual(match({ ...p, mailboxRole: 'sent' }, {}), false, 'Sent is not the inbox');
    assert.strictEqual(match({ ...p, mailboxRole: null }, {}), false, 'an unknown mailbox is not the inbox');
    assert.strictEqual(match({ ...p, mailboxRole: 'sent' }, { mailboxId: 12 }), true, 'a named mailbox, whatever its role');
    assert.strictEqual(match({ ...p, hasAttachments: null }, { hasAttachment: true }), false, 'unknown is not "has"');
});

test('the canonical payload: every field present, unknown ones null', () => {
    const p = normaliseNextcloudPayload('mail.new', { accountId: 3, mailboxId: 12, messageId: 4711, datetime: '2026-11-15T09:00:00.000Z' });
    assert.deepStrictEqual(
        { from: p.from, subject: p.subject, hasAttachments: p.hasAttachments, receivedAt: p.receivedAt, mailboxRole: p.mailboxRole },
        { from: null, subject: '', hasAttachments: null, receivedAt: '2026-11-15T09:00:00.000Z', mailboxRole: null },
    );
});
