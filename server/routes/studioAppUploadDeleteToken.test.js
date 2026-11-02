/**
 * Discarding an unlinked public App Studio upload requires the delete token
 * the upload answer carried (routes/studioAppUploadDeleteToken.mts), so a
 * visitor who only knows the attachment id cannot discard it.
 *
 * Run: cd server && node --test routes/studioAppUploadDeleteToken.test.js
 */
'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'x'.repeat(48);

const test = require('node:test');
const assert = require('node:assert');
const h = require('../testUtils/routeHarness');
const { issueVisitorToken } = require('../auth/publicShareToken');
const { uploadDeleteToken, isValidUploadDeleteToken, DELETE_TOKEN_HEADER } = require('./studioAppUploadDeleteToken.mts');

const PAGE = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6';
const APP = 'app1';
const FILE = '11111111-2222-4333-8444-555555555555';
const definition = {
    screens: [{ id: 's1' }],
    publicAccess: { screenIds: ['s1'], entryScreenId: 's1' },
};
const model = { tables: [{ id: 't1', key: 't', fields: [], access: { default: 'app', roles: { public: { create: true, read: 'own', update: 'none', delete: 'none' } } } }] };

const answer = (sql) => {
    if (/FROM studio_app_public_pages/.test(sql)) return { rows: [{ id: PAGE, app_id: APP }] };
    if (/FROM studio_apps WHERE id/.test(sql)) return { rows: [{ id: APP, user_id: 'owner1', is_published: true, definition: '{}', published_definition: JSON.stringify(definition) }] };
    if (/FROM studio_app_data_meta/.test(sql)) return { rows: [{ app_id: APP, owner_user_id: 'owner1', model: JSON.stringify(model) }] };
    if (/SELECT (\*|id) FROM studio_app_attachments WHERE id/.test(sql)) return { rows: [{ id: FILE, app_id: APP, owner_user_id: 'owner1', record_id: null, sha256: '' }] };
    return undefined;
};

const { db, api } = h.routeUnderTest(test, '/api/public-app', () => require('./studioAppPublic'), { gates: false, user: null, answer });
const visitor = `Bearer ${issueVisitorToken({ pageToken: PAGE, appId: APP, viewerId: 'anon-1' })}`;
const del = (headers) => api.call('DELETE', `/api/public-app/${PAGE}/data/attachments/${FILE}`, { headers: { authorization: visitor, ...headers } });
const deleted = () => db.queries.some((q) => /DELETE FROM studio_app_attachments/i.test(q));

test('the token is bound to the app and the attachment', () => {
    const tok = uploadDeleteToken(APP, FILE);
    assert.ok(isValidUploadDeleteToken(APP, FILE, tok));
    assert.ok(!isValidUploadDeleteToken(APP, 'other-file', tok));
    assert.ok(!isValidUploadDeleteToken('app2', FILE, tok));
    assert.ok(!isValidUploadDeleteToken(APP, FILE, undefined));
    assert.ok(!isValidUploadDeleteToken(APP, FILE, tok.slice(1)));
});

test('a delete without the token is refused and deletes nothing', async () => {
    const res = await del({});
    assert.strictEqual(res.status, 404, res.text);
    assert.ok(!deleted(), db.queries.join(' | '));
});

test('a delete with a wrong token is refused and deletes nothing', async () => {
    const res = await del({ [DELETE_TOKEN_HEADER]: uploadDeleteToken(APP, 'another-upload') });
    assert.strictEqual(res.status, 404, res.text);
    assert.ok(!deleted());
});

test('the uploader\'s token discards the upload', async () => {
    const res = await del({ [DELETE_TOKEN_HEADER]: uploadDeleteToken(APP, FILE) });
    assert.strictEqual(res.status, 200, res.text);
    assert.ok(deleted(), db.queries.join(' | '));
});
