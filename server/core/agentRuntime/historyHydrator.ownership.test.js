/**
 * The history hydrator signs a storage key only for its owner: a key under the
 * caller's users/<id>/ prefix, or a sidecar read from the stored conversation.
 *
 * Run: node --test core/agentRuntime/historyHydrator.ownership.test.js
 */
'use strict';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'x'.repeat(48);

const { test } = require('node:test');
const assert = require('node:assert');

const { hydrateHistoryAttachments } = require('./historyHydrator');
const { markPersistedSidecars, mergeAttachmentSidecars } = require('../conversation/historyMerge');
const { generateTempDownloadUrl, resolveTempDownloadKey } = require('../../utils/tempDownloadUrl');

const OWN = 'users/u1/attachments/own.png';
const OTHER = 'users/u2/attachments/theirs.png';

/** @param {any[]} attachments */
async function hydrateOne(attachments, userId = 'u1') {
    const messages = [{ role: 'user', content: 'look', attachments }];
    await hydrateHistoryAttachments(messages, { skipLast: false, userId });
    return messages[0].content;
}

const signedKeys = (content) => content
    .filter((b) => b.type === 'image_url')
    .map((b) => resolveTempDownloadKey(b.image_url.url));

test('the caller\'s own storage key is signed', async () => {
    const content = await hydrateOne([{ name: 'own.png', type: 'image/png', storageKey: OWN }]);
    assert.deepStrictEqual(signedKeys(content), [OWN]);
});

test('another user\'s storage key from a request body is not signed', async () => {
    const content = await hydrateOne([{ name: 'theirs.png', type: 'image/png', storageKey: OTHER }]);
    assert.deepStrictEqual(signedKeys(content), []);
    assert.ok(content.some((b) => b.type === 'text' && b.text.includes('theirs.png')), 'placeholder instead');
});

test('a guest (no user id) gets no key signed from a request body', async () => {
    const messages = [{ role: 'user', content: 'x', attachments: [{ name: 'a.png', type: 'image/png', storageKey: OTHER }] }];
    await hydrateHistoryAttachments(messages, { skipLast: false });
    assert.deepStrictEqual(signedKeys(messages[0].content), []);
});

test('a sidecar from the stored conversation is signed, also for another member\'s key', async () => {
    const stored = [{ role: 'user', content: 'look', attachments: [{ name: 'theirs.png', type: 'image/png', storageKey: OTHER }] }];
    markPersistedSidecars(stored);
    const content = await hydrateOne(stored[0].attachments);
    assert.deepStrictEqual(signedKeys(content), [OTHER]);
});

test('edit/retry: the stored sidecar grafted by mergeAttachmentSidecars is signed', async () => {
    const db = [{ role: 'user', content: 'look', attachments: [{ name: 'theirs.png', type: 'image/png', storageKey: OTHER }] }];
    const merged = mergeAttachmentSidecars([{ role: 'user', content: 'look', attachments: [{ name: 'theirs.png', type: 'image/png' }] }], db);
    await hydrateHistoryAttachments(merged, { skipLast: false, userId: 'u1' });
    assert.deepStrictEqual(signedKeys(merged[0].content), [OTHER]);
});

test('a temp URL with a forged signature for another user\'s key is not re-signed', async () => {
    const forged = `https://h/api/storage/tmp/${'0'.repeat(64)}?key=${encodeURIComponent(OTHER)}&expires=1`;
    const content = await hydrateOne([{ name: 'theirs.png', type: 'image/png', url: forged }]);
    assert.deepStrictEqual(signedKeys(content), []);

    const messages = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: forged } }] }];
    await hydrateHistoryAttachments(messages, { skipLast: false, userId: 'u1' });
    assert.deepStrictEqual(signedKeys(messages[0].content), []);
});

test('an expired temp URL for the caller\'s own key is refreshed; a valid one for any key too', async () => {
    const expiredOwn = generateTempDownloadUrl(OWN, -10);
    const validOther = generateTempDownloadUrl(OTHER, 600);
    const messages = [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: expiredOwn } },
        { type: 'image_url', image_url: { url: validOther } },
    ] }];
    await hydrateHistoryAttachments(messages, { skipLast: false, userId: 'u1' });
    assert.deepStrictEqual(signedKeys(messages[0].content), [OWN, OTHER]);
});
