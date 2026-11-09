// AppAPI's PHP proxy has four routes for an ExApp: ExAppGet, ExAppPost,
// ExAppPut and ExAppDelete (app_api appinfo/routes.php, ExAppProxyController).
// PROPFIND, REPORT, MKCOL, MOVE, COPY and PATCH have none, whatever info.xml
// lists for `^/?nc\/.*`. The Bee Flow server therefore sends every verb but GET
// and POST as POST + X-HTTP-Method-Override, signed over the REAL method
// (server/integrations/nextcloudClient.js). This pins the connector's half:
// each of those verbs must reach Nextcloud as itself, with its body intact and
// without the tunnel header.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

process.env.APP_SECRET = 'test-secret';
process.env.BEEFLOW_TENANT_KEY = 'tenant-key';
process.env.APP_ID = 'bee_flow';

/** @type {Array<{method: string, url: string, body: string, override: unknown, auth: unknown}>} */
const upstreamSeen = [];
const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
        upstreamSeen.push({
            method: req.method,
            url: req.url,
            body: Buffer.concat(chunks).toString('utf8'),
            override: req.headers['x-http-method-override'],
            auth: req.headers['authorization-app-api'],
        });
        res.statusCode = 207;
        res.end();
    });
});

let proxyServer;
let config;

test.before(async () => {
    await new Promise(r => upstream.listen(0, '127.0.0.1', r));
    process.env.NEXTCLOUD_URL = `http://127.0.0.1:${upstream.address().port}`;
    config = require('../src/config');
    const app = express();
    require('../src/ncProxy').mount(app);
    proxyServer = http.createServer(app);
    await new Promise(r => proxyServer.listen(0, '127.0.0.1', r));
});

test.after(() => {
    proxyServer?.close();
    upstream.close();
});

/**
 * Send `realMethod` the way the server does: as POST with the override header,
 * signed over the real method and the body hash.
 */
function tunnel(realMethod, path, body, { signedMethod = realMethod } = {}) {
    const ts = Math.floor(Date.now() / 1000);
    const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
    const sig = crypto.createHmac('sha256', config.tenantKey)
        .update(`${ts}\n${signedMethod}\n${path}\nalice\n${bodyHash}`).digest('hex');
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port: proxyServer.address().port, method: 'POST', path,
            headers: {
                'x-beeflow-sig': `${ts}.${sig}`,
                'x-beeflow-nc-uid': 'alice',
                'x-http-method-override': realMethod,
                'content-length': Buffer.byteLength(body),
            },
        }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
        req.on('error', reject);
        req.end(body);
    });
}

const lastUpstream = () => upstreamSeen[upstreamSeen.length - 1];

for (const [verb, path, body] of [
    ['PROPFIND', '/nc/remote.php/dav/files/alice/', '<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>'],
    ['REPORT', '/nc/remote.php/dav/calendars/alice/personal/', '<c:calendar-query xmlns:c="urn:ietf:params:xml:ns:caldav"/>'],
    ['MKCOL', '/nc/remote.php/dav/files/alice/New%20folder', ''],
    ['PUT', '/nc/remote.php/dav/files/alice/a.json', '{ "kept":   "byte for byte" }'],
    ['DELETE', '/nc/remote.php/dav/files/alice/a.json', ''],
    ['PATCH', '/nc/ocs/v2.php/apps/forms/api/v3/forms/1', '{"keyValuePairs":{"title":"x"}}'],
    ['PROPPATCH', '/nc/remote.php/dav/files/alice/a.json', '<d:propertyupdate xmlns:d="DAV:"/>'],
]) {
    test(`a tunnelled ${verb} reaches Nextcloud as ${verb}`, async () => {
        const status = await tunnel(verb, path, body);
        assert.equal(status, 207);
        const seen = lastUpstream();
        assert.equal(seen.method, verb);
        assert.equal(seen.url, path.slice('/nc'.length));
        assert.equal(seen.body, body);
        assert.equal(seen.override, undefined, 'the tunnel header is ours, not Nextcloud\'s');
        assert.equal(seen.auth, Buffer.from('alice:test-secret').toString('base64'));
    });
}

test('a tunnelled verb signed as another verb is refused before Nextcloud sees it', async () => {
    const before = upstreamSeen.length;
    const status = await tunnel('DELETE', '/nc/remote.php/dav/files/alice/a.json', '', { signedMethod: 'PROPFIND' });
    assert.equal(status, 401);
    assert.equal(upstreamSeen.length, before);
});
