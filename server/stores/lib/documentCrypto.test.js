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

test('which key a write uses: the organisation key for anything shared, the owner key otherwise', async () => {
    withPolicy({ enabled: true, tier: 'managed' });
    const scopeOf = async (extra) => (await content.writeContext({ ...resource, ...extra })).scope;
    assert.strictEqual(await scopeOf({}), 'user');
    // Each sign of sharing on its own is enough.
    assert.strictEqual(await scopeOf({ cryptoContext: { scope: 'organisation' } }), 'organisation');
    assert.strictEqual(await scopeOf({ projectId: 'p1' }), 'organisation');
    assert.strictEqual(await scopeOf({ visibility: 'team' }), 'organisation');
    assert.strictEqual(await scopeOf({ sharingAudience: 'organisation' }), 'organisation');
    assert.strictEqual(await scopeOf({ sharingAudience: 'restricted' }), 'organisation');
    assert.strictEqual(await scopeOf({ visibility: 'private', sharingAudience: 'private', cryptoContext: { scope: 'user' } }), 'user');
    assert.deepStrictEqual(await content.writeContext(resource), { scope: 'user', tier: 'managed', orgId: 'o1', userId: 'u1' });
});

test('a row becomes the resource its key is derived for', () => {
    const row = { id: 'd9', user_id: 'u9', organization_id: 'o9', project_id: 'p9', visibility: 'team', sharing_audience: 'restricted' };
    assert.deepStrictEqual(content.resourceOf(row), { type: 'document', id: 'd9', userId: 'u9', organizationId: 'o9',
        projectId: 'p9', visibility: 'team', sharingAudience: 'restricted', cryptoContext: undefined });
    assert.strictEqual(content.resourceOf(row, 'notebook').type, 'notebook');
    const ctx = { scope: 'organisation', tier: 'managed', orgId: 'o9' };
    assert.deepStrictEqual(content.resourceOf({ ...row, _contentCryptoContext: ctx }).cryptoContext, ctx);
});

test('a notebook\'s text columns are sealed as text, its settings as a JSON object, and all open again', async () => {
    withPolicy({ enabled: true, tier: 'managed' });
    content.keySources.userKey = async () => ROOT;
    const notebook = { type: 'notebook', id: 'n1', userId: 'u1', organizationId: 'o1' };
    const row = { document_content: '{"doc":1}', document_md: '# title', instructions: 'be brief', preview: 'first lines', settings: { a: 1 } };
    const stored = await content.sealFields(row, notebook, content.NOTEBOOK_FIELDS);
    for (const field of ['document_content', 'document_md', 'instructions', 'preview']) {
        assert.strictEqual(typeof stored[field], 'string', `${field} stays a text column`);
        assert.ok(!stored[field].includes(row[field]), `${field} is sealed`);
    }
    assert.strictEqual(typeof stored.settings, 'object');
    assert.deepStrictEqual(await content.openFields({ id: 'n1', ...stored }, 'notebook', content.NOTEBOOK_FIELDS), { id: 'n1', ...row });
});

test('a row that is not there stays the null the query answered', async () => {
    assert.strictEqual(await content.openRow(null), null);
    assert.strictEqual(await content.openFields(null, 'notebook', content.NOTEBOOK_FIELDS), null);
    const db = content.readingDb({ getOne: async () => null, getAll: async () => [], withTransaction: async () => undefined });
    assert.strictEqual(await db.getOne('any query'), null);
    assert.deepStrictEqual(await db.getAll('any query'), []);
});
