'use strict';

/**
 * The assets of a public Studio page (routes/studioAppPublicAssets.mts) and the page's own
 * logo in GET /api/public-app/:token (routes/studioAppPublic.js), against the real routers,
 * the real stores on PGlite and the local storage store under a temp folder.
 *
 * Run: cd server && node --test routes/studioAppPublicAssets.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'public-assets-test-secret-0123456789abcdef';
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'public-assets-master-key-0123456789abcdef0123456789';
delete process.env.RUSTFS_ENDPOINT;
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-public-assets-'));
process.env.STORAGE_LOCAL_ROOT = storageRoot;

const { usePglitePool } = require('../testUtils/pglitePool');
const { close: closePg } = usePglitePool();

const OWNER_ID = 'u-public-assets';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let server;
let base;
const ids = {};

function definitionWith({ publicImage, backOfficeImage, appLogo, pageLogo }) {
    const image = (id, src) => ({ id, type: 'image', props: { src, alt: '', fit: 'cover' } });
    return {
        meta: { name: 'Intake' },
        design: appLogo ? { logoUrl: appLogo } : undefined,
        homeScreenId: 'scr_public01',
        screens: [
            { id: 'scr_public01', name: 'Form', sections: [{ id: 'sec_public01', children: [image('cmp_public01', publicImage)] }] },
            { id: 'scr_office01', name: 'Office', sections: [{ id: 'sec_office01', children: [image('cmp_office01', backOfficeImage)] }] },
        ],
        actions: {},
        publicAccess: { entryScreenId: 'scr_public01', screenIds: ['scr_public01'], ...(pageLogo ? { design: { logoUrl: pageLogo } } : {}) },
    };
}

async function publishedApp(name, def) {
    const studioAppStore = require('../stores/studioAppStore');
    const { canonicalizeAppDefinition } = require('../appStudio/canonicalize');
    const app = await studioAppStore.createStudioApp({ userId: OWNER_ID, organizationId: null, name });
    const { storeAsset } = require('../appStudio/appAssetStore.mts');
    const assets = [];
    for (let i = 0; i < 3; i++) {
        // Three different files: the store is content-addressed, identical bytes would share one blob.
        assets.push(await storeAsset(app, Buffer.concat([PNG, Buffer.from([i])]), 'image/png'));
    }
    const definition = canonicalizeAppDefinition(def(assets.map((a) => a.ref))).def;
    await require('../db').run('UPDATE studio_apps SET definition = $1, published_definition = $1, is_published = true WHERE id = $2', [JSON.stringify(definition), app.id]);
    const token = await studioAppStore.createPublicPage(app.id, OWNER_ID);
    return { app, assets, token: typeof token === 'string' ? token : token.token };
}

async function get(url) {
    const res = await fetch(`${base}${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    let json = null;
    try { json = JSON.parse(buf.toString('utf8')); } catch { json = null; }
    return { status: res.status, headers: res.headers, buf, json };
}

before(async () => {
    const userStore = require('../stores/userStore');
    await userStore.initDB();
    await userStore.createUser({ id: OWNER_ID, username: 'owner', email: 'owner@public.test', role: 'user', passwordHash: 'x' });
    await require('../stores/studioAppStore').initDB();
    await require('../stores/storageStore').init();

    const withLogo = await publishedApp('With page logo', ([a, b, c]) => definitionWith({ publicImage: a, backOfficeImage: b, appLogo: c, pageLogo: a }));
    const appLogoOnly = await publishedApp('App logo only', ([a, , c]) => definitionWith({ publicImage: a, backOfficeImage: a, appLogo: c }));
    Object.assign(ids, { withLogo, appLogoOnly });

    const express = require('express');
    const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');
    const app = express();
    app.use(express.json());
    app.use('/api/public-app', require('./studioAppPublic'), require('./studioAppPublicAssets.mts').publicAppAssetsRouter);
    app.use(terminalErrorHandler);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
}, { timeout: 120_000 });

after(async () => {
    await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
    await closePg();
    fs.rmSync(storageRoot, { recursive: true, force: true });
});

test('an asset on a public screen loads without a visitor bearer, with the asset headers', async () => {
    const { token, assets } = ids.withLogo;
    const res = await get(`/api/public-app/${token}/assets/${assets[0].id}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.equal(res.buf.length, PNG.length + 1);
});

test('an asset only a back-office screen uses is a 404, so is an unknown token or asset', async () => {
    const { token, assets } = ids.withLogo;
    assert.equal((await get(`/api/public-app/${token}/assets/${assets[1].id}`)).status, 404);
    assert.equal((await get(`/api/public-app/${'0'.repeat(48)}/assets/${assets[0].id}`)).status, 404);
    assert.equal((await get(`/api/public-app/not-a-token/assets/${assets[0].id}`)).status, 404);
    assert.equal((await get(`/api/public-app/${token}/assets/no-such-asset`)).status, 404);
    // Another app's asset, under this page's token: not in this definition, and not this app's file.
    assert.equal((await get(`/api/public-app/${token}/assets/${ids.appLogoOnly.assets[0].id}`)).status, 404);
});

test("the app's own logo travels in the served design (as before) and is servable, but only the page's own logo is named as the page logo", async () => {
    const own = await get(`/api/public-app/${ids.withLogo.token}`);
    assert.equal(own.status, 200);
    assert.deepEqual(own.json.page, { logoUrl: ids.withLogo.assets[0].ref });
    assert.equal(own.json.definition.design.logoUrl, ids.withLogo.assets[0].ref, 'the page logo merged over the app logo');

    const appOnly = await get(`/api/public-app/${ids.appLogoOnly.token}`);
    assert.deepEqual(appOnly.json.page, { logoUrl: null }, 'no page logo of its own: the header draws none');
    assert.equal(appOnly.json.definition.design.logoUrl, ids.appLogoOnly.assets[2].ref);
    assert.equal((await get(`/api/public-app/${ids.appLogoOnly.token}/assets/${ids.appLogoOnly.assets[2].id}`)).status, 200);
});

test('an unpublished app serves no public asset', async () => {
    const { app, token, assets } = ids.withLogo;
    await require('../db').run('UPDATE studio_apps SET is_published = false WHERE id = $1', [app.id]);
    assert.equal((await get(`/api/public-app/${token}/assets/${assets[0].id}`)).status, 404);
});
