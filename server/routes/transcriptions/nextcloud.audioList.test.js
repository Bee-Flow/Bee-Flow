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
const h = require('../../testUtils/routeHarness');

// The real requireAuth looks the user up; this route test only needs a
// session, and the listing itself reads no table.
const { api } = h.routeUnderTest(test, '/', () => require('./nextcloud'));
const ncClient = require('../../integrations/nextcloudClient');

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

    const res = await api.call('GET', '/nextcloud-audio-files');
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(res.body.items.map((i) => [i.name, i.path]).sort(), [
        ['100% final.mp3', '/Recordings/100% final.mp3'],
        ['a%41.wav', '/Recordings/a%41.wav'],
    ]);
});

test('an ampersand in a name arrives as the XML entity and is listed as the character; a malformed href costs one odd name, not the folder', async (t) => {
    const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${[
        entry('/remote.php/dav/files/ada/Recordings/Q&amp;A%20session.mp3'),
        entry('/remote.php/dav/files/ada/Recordings/bad%ZZname.mp3'),
        entry('/remote.php/dav/files/ada/Recordings/caf%C3%A9.wav'),
    ].join('')}</d:multistatus>`;
    const original = { resolveAuth: ncClient.resolveAuth, webdavRoot: ncClient.webdavRoot };
    ncClient.resolveAuth = async () => ({ baseUrl: 'https://nc.example', uid: 'ada', fetch: async () => ({ status: 207, ok: true, text: async () => xml }) });
    ncClient.webdavRoot = (base, uid) => `${base}/remote.php/dav/files/${uid}`;
    t.after(() => Object.assign(ncClient, original));

    const res = await api.call('GET', '/nextcloud-audio-files');
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(res.body.items.map((i) => i.name).sort(), ['Q&A session.mp3', 'bad%ZZname.mp3', 'café.wav']);
    assert.strictEqual(res.body.items.find((i) => i.name === 'Q&A session.mp3').path, '/Recordings/Q&A session.mp3');
});
