'use strict';

/**
 * The asset store of an App Studio app (routes/studioAppAssets.mts), end to end: the real
 * router behind its real gates, the real stores on PGlite and the real storage store in its
 * local-disk mode under a temp folder. Next to it the attachment router, mounted together as
 * in index.js, so the asset rows are proven out of its reach.
 *
 * Run: cd server && node --test routes/studioAppAssets.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'assets-test-session-secret-0123456789abcdef';
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'assets-test-master-key-0123456789abcdef0123456789';
delete process.env.RUSTFS_ENDPOINT;
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-assets-'));
process.env.STORAGE_LOCAL_ROOT = storageRoot;

const { usePglitePool } = require('../testUtils/pglitePool');
const { close: closePg } = usePglitePool();

const ORG = 'org-assets';
const OWNER = { id: 'u-assets-owner', username: 'owner', email: 'owner@assets.test', organizationId: ORG, role: 'user', orgRole: 'org_admin', groups: [] };
const STRANGER = { id: 'u-assets-stranger', username: 'stranger', email: 'stranger@other.test', organizationId: 'org-other', role: 'user', orgRole: 'org_admin', groups: [] };

/** A real 1x1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
/** The 48-byte WOFF2 header shape: the tag, a flavour and the file's own total length. */
function woff2(size = 64) {
    const b = Buffer.alloc(size);
    b.write('wOF2', 0, 'latin1');
    b.writeUInt32BE(0x00010000, 4);
    b.writeUInt32BE(size, 8);
    return b;
}

let server;
let base;
let appId;

function serveRouters() {
    const express = require('express');
    const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        const who = req.headers['x-test-user'];
        const user = who ? JSON.parse(String(who)) : null;
        req.session = user
            ? { isAuthenticated: true, user, save: (cb) => cb && cb(), destroy: (cb) => cb && cb() }
            : { save: (cb) => cb && cb(), destroy: (cb) => cb && cb() };
        next();
    });
    app.use('/api/studio-apps', require('./studioAppFiles'), require('./studioAppAssets.mts').studioAppAssetsRouter);
    app.use(terminalErrorHandler);
    return http.createServer(app);
}

async function call(method, url, { user = OWNER, file, type, name = 'logo.png' } = {}) {
    const headers = user ? { 'x-test-user': JSON.stringify(user) } : {};
    let body;
    if (file) {
        body = new FormData();
        body.append('file', new Blob([file], { type }), name);
    }
    const res = await fetch(`${base}${url}`, { method, headers, body });
    const buf = Buffer.from(await res.arrayBuffer());
    let json = null;
    try { json = JSON.parse(buf.toString('utf8')); } catch { json = null; }
    return { status: res.status, headers: res.headers, json, buf };
}

before(async () => {
    const userStore = require('../stores/userStore');
    await userStore.initDB();
    await userStore.createOrganization({ id: ORG, name: 'Assets org' }, { autoGrantTrial: false });
    await userStore.createOrganization({ id: 'org-other', name: 'Other org' }, { autoGrantTrial: false });
    for (const u of [OWNER, STRANGER]) await userStore.createUser({ ...u, passwordHash: 'x' });
    const studioAppStore = require('../stores/studioAppStore');
    await studioAppStore.initDB();
    await require('../stores/studioAppDataStore').initDB?.();
    await require('../stores/storageStore').init();
    appId = (await studioAppStore.createStudioApp({ userId: OWNER.id, organizationId: ORG, name: 'Assets app' })).id;
    server = serveRouters();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
}, { timeout: 120_000 });

after(async () => {
    await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
    await closePg();
    fs.rmSync(storageRoot, { recursive: true, force: true });
});

test('the owner uploads a PNG, lists it and reads the bytes back with the asset headers', async () => {
    const up = await call('POST', `/api/studio-apps/${appId}/assets`, { file: PNG, type: 'image/png' });
    assert.equal(up.status, 201, up.buf.toString());
    const { asset } = up.json;
    assert.equal(asset.mime, 'image/png');
    assert.equal(asset.ref, `asset:${asset.id}`);

    const list = await call('GET', `/api/studio-apps/${appId}/assets`);
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.assets.map((a) => a.id), [asset.id]);
    assert.deepEqual(list.json.assets[0].usedBy, { draft: [], published: [] });
    assert.ok(list.json.limits.types.includes('font/woff2'));
    assert.ok(!list.json.limits.types.includes('image/svg+xml'));

    const got = await call('GET', `/api/studio-apps/${appId}/assets/${asset.id}`);
    assert.equal(got.status, 200);
    assert.deepEqual(got.buf, PNG);
    assert.equal(got.headers.get('content-type'), 'image/png');
    assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(got.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.match(got.headers.get('cache-control'), /immutable/);
});

test('a WOFF2 font is accepted and served as font/woff2', async () => {
    const up = await call('POST', `/api/studio-apps/${appId}/assets`, { file: woff2(), type: 'font/woff2', name: 'brand.woff2' });
    assert.equal(up.status, 201, up.buf.toString());
    assert.equal(up.json.asset.mime, 'font/woff2');
    const got = await call('GET', `/api/studio-apps/${appId}/assets/${up.json.asset.id}`);
    assert.equal(got.headers.get('content-type'), 'font/woff2');
});

test('SVG, a type outside the list and bytes that contradict the declared type are refused', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    assert.equal((await call('POST', `/api/studio-apps/${appId}/assets`, { file: svg, type: 'image/svg+xml', name: 'x.svg' })).status, 415);
    assert.equal((await call('POST', `/api/studio-apps/${appId}/assets`, { file: Buffer.from('%PDF-1.4'), type: 'application/pdf', name: 'x.pdf' })).status, 415);
    assert.equal((await call('POST', `/api/studio-apps/${appId}/assets`, { file: Buffer.from('not an image'), type: 'image/png' })).status, 415);
});

test('someone who cannot edit the app gets 404 on every asset route, the upload before its file is read', async () => {
    const list = await call('GET', `/api/studio-apps/${appId}/assets`);
    const id = list.json.assets[0].id;
    for (const [method, url] of [
        ['GET', `/api/studio-apps/${appId}/assets`],
        ['GET', `/api/studio-apps/${appId}/assets/${id}`],
        ['DELETE', `/api/studio-apps/${appId}/assets/${id}`],
    ]) {
        assert.equal((await call(method, url, { user: STRANGER })).status, 404, `${method} ${url}`);
    }
    assert.equal((await call('POST', `/api/studio-apps/${appId}/assets`, { user: STRANGER, file: PNG, type: 'image/png' })).status, 404);
    assert.equal((await call('GET', `/api/studio-apps/${appId}/assets`, { user: null })).status, 401);
});

test('the attachment routes cannot delete an asset, and an asset id with a stray character is refused', async () => {
    const list = await call('GET', `/api/studio-apps/${appId}/assets`);
    const id = list.json.assets[0].id;
    assert.equal((await call('DELETE', `/api/studio-apps/${appId}/data/attachments/${id}`)).status, 404);
    assert.equal((await call('GET', `/api/studio-apps/${appId}/assets/${id}`)).status, 200, 'still there');
    assert.equal((await call('GET', `/api/studio-apps/${appId}/assets/a.b`)).status, 400);
});

test('the list says where the draft and the published app use an asset; delete removes it', async () => {
    const studioAppStore = require('../stores/studioAppStore');
    const { id } = (await call('GET', `/api/studio-apps/${appId}/assets`)).json.assets[0];
    const app = await studioAppStore.getStudioApp(appId);
    const definition = { ...app.definition, design: { logoUrl: `asset:${id}` } };
    const db = require('../db');
    await db.run('UPDATE studio_apps SET definition = $1, published_definition = $1, is_published = true WHERE id = $2', [JSON.stringify(definition), appId]);
    const listed = (await call('GET', `/api/studio-apps/${appId}/assets`)).json.assets.find((a) => a.id === id);
    assert.deepEqual(listed.usedBy, { draft: ['design.logoUrl'], published: ['design.logoUrl'] });

    assert.equal((await call('DELETE', `/api/studio-apps/${appId}/assets/${id}`)).status, 200);
    assert.equal((await call('GET', `/api/studio-apps/${appId}/assets/${id}`)).status, 404);
    assert.equal((await call('DELETE', `/api/studio-apps/${appId}/assets/${id}`)).status, 404);
});

test('the save-time data references carry the asset ids, so a missing asset is a validator warning', async () => {
    const { loadDataRefs } = require('./studioApps/appHelpers');
    const { validateAppDefinition } = require('../appStudio/validate');
    const { canonicalizeAppDefinition } = require('../appStudio/canonicalize');
    const refs = await loadDataRefs(appId, OWNER.id);
    assert.ok(Array.isArray(refs.assetIds));
    const app = await require('../stores/studioAppStore').getStudioApp(appId);
    const { def } = canonicalizeAppDefinition({ ...app.definition, design: { logoUrl: 'asset:gone-1' } });
    const { warnings } = validateAppDefinition(def, { ...refs, dataRefsAsWarnings: true });
    assert.deepEqual(warnings.filter((w) => w.code === 'asset.missing').map((w) => w.path), ['design.logoUrl']);
});

test('app_list_assets lists the owner\'s uploaded files by ref, and nothing for anyone else', async () => {
    const { applyListAssets } = require('../appStudio/builderTools/assetTools.mts');
    const out = await applyListAssets({ appId, userId: OWNER.id });
    assert.ok(out.assets.length >= 1);
    for (const a of out.assets) {
        assert.deepEqual(Object.keys(a).sort(), ['kind', 'mime', 'ref', 'size', 'usedBy']);
        assert.match(a.ref, /^asset:/);
    }
    assert.ok(out.assets.every((a) => (a.mime.startsWith('font/') ? a.kind === 'font' : a.kind === 'image')));
    assert.ok((await applyListAssets({ appId, userId: STRANGER.id })).error);
    assert.deepEqual((await applyListAssets({ appId: null, userId: OWNER.id })).assets, []);
});
