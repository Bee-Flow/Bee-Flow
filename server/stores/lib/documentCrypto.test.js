'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const content = require('./documentCrypto');

const ROOT = crypto.randomBytes(32);
const resource = { type: 'document', id: 'd1', userId: 'u1', organizationId: 'o1' };
const original = { ...content.keySources };
const withPolicy = (policy) => { content.keySources.policy = async () => policy; };
test.afterEach(() => { Object.assign(content.keySources, original); });

test('without a policy, content is stored and read as plain text', async () => {
    withPolicy({ enabled: false, tier: 'none' });
    const stored = await content.sealFields({ body_html: '<p>a</p>', css: '', settings: { a: 1 } }, resource, content.DOCUMENT_FIELDS);
    assert.deepStrictEqual(stored, { body_html: '<p>a</p>', css: '', settings: { a: 1 } });
});

test('a document written before encryption was switched on stays readable', async () => {
    withPolicy({ enabled: true, tier: 'zk' });
    // No key at all: plaintext rows are still opened.
    assert.strictEqual(await content.open('<p>old</p>', 'document', 'd1', 'body_html'), '<p>old</p>');
    const row = await content.openRow({ id: 'd1', body_html: '<p>old</p>', settings: { x: 1 } });
    assert.deepStrictEqual(row.settings, { x: 1 });
});

test('managed tier: seals with the escrow key and opens again, no session needed', async () => {
    withPolicy({ enabled: true, tier: 'managed' });
    content.keySources.userKey = async () => ROOT;
    const stored = await content.sealFields({ body_html: '<p>secret</p>', css: 'p{}', settings: { k: 'v' } }, resource, content.DOCUMENT_FIELDS);
    assert.ok(!String(stored.body_html).includes('secret'));
    const opened = await content.openRow({ id: 'd1', ...stored, settings: stored.settings });
    assert.strictEqual(opened.body_html, '<p>secret</p>');
    assert.deepStrictEqual(opened.settings, { k: 'v' });
});

test('an envelope cannot be opened as another document', async () => {
    withPolicy({ enabled: true, tier: 'managed' });
    content.keySources.userKey = async () => ROOT;
    const stored = await content.sealFields({ body_html: 'x' }, resource, { body_html: false });
    await assert.rejects(content.open(stored.body_html, 'document', 'other', 'body_html'), { status: 423 });
});

test('zk tier without a key in the session: a coded, actionable 423, never a half write', async () => {
    withPolicy({ enabled: true, tier: 'zk' });
    await assert.rejects(
        content.sealFields({ body_html: 'x' }, resource, { body_html: false }),
        (e) => e.status === 423 && e.code === 'document_encryption_key_unavailable' && /Sign in again/.test(e.message),
    );
});

test('zk tier with the session key: seals and opens inside that session', async () => {
    withPolicy({ enabled: true, tier: 'zk' });
    const req = { session: { user: { id: 'u1' }, encryptionKey: ROOT.toString('base64') } };
    await new Promise((resolve, reject) => content.withDocumentEncryptionSession(req, null, () => {
        (async () => {
            const stored = await content.sealFields({ body_html: 'hello' }, resource, { body_html: false });
            assert.notStrictEqual(stored.body_html, 'hello');
            assert.strictEqual((await content.openRow({ id: 'd1', ...stored })).body_html, 'hello');
        })().then(resolve, reject);
    }));
});
