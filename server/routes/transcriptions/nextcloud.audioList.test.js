'use strict';

/**
 * GET /nextcloud-audio-files: the names in a WebDAV listing are percent-encoded
 * once, so they are decoded once. A recording called `100% final.mp3` used to
 * fail the whole folder with a URIError.
 *
 * Run: cd server && node --test routes/transcriptions/nextcloud.audioList.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

// The real requireAuth looks the user up (and loads the user store); this
// route test only needs a session.
const permissionsFile = require.resolve('../../auth/permissions');
require.cache[permissionsFile] = {
    id: permissionsFile, filename: permissionsFile, loaded: true,
    exports: { requireAuth: (req, res, next) => (req.session?.user ? next() : res.status(401).json({ error: 'unauth' })) },
};
const ncClient = require('../../integrations/nextcloudClient');
const router = require('./nextcloud');

const entry = (href, extra = '') => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${extra}<d:resourcetype/></d:prop></d:propstat></d:response>`;
const XML = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${[
    '<d:response><d:href>/remote.php/dav/files/ada/Recordings/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>',
    entry('/remote.php/dav/files/ada/Recordings/100%25%20final.mp3', '<d:getcontentlength>12</d:getcontentlength>'),
    entry('/remote.php/dav/files/ada/Recordings/a%2541.wav'),
].join('')}</d:multistatus>`;

test('a recording with a percent sign in its name is listed under that name', async (t) => {
    const original = { resolveAuth: ncClient.resolveAuth, webdavRoot: ncClient.webdavRoot };
    ncClient.resolveAuth = async () => ({
        baseUrl: 'https://nc.example', uid: 'ada',
        fetch: async () => ({ status: 207, ok: true, text: async () => XML }),
    });
    ncClient.webdavRoot = (base, uid) => `${base}/remote.php/dav/files/${uid}`;
    t.after(() => Object.assign(ncClient, original));

    const app = express();
    app.use((req, _res, next) => { req.session = { user: { id: 'u1' } }; next(); });
    app.use(router);
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    t.after(() => server.close());

    const res = await fetch(`http://127.0.0.1:${server.address().port}/nextcloud-audio-files`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.items.map((i) => [i.name, i.path]).sort(), [
        ['100% final.mp3', '/Recordings/100% final.mp3'],
        ['a%41.wav', '/Recordings/a%41.wav'],
    ]);
});
