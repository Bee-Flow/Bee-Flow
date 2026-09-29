/**
 * routes/compliance/sbom — streams the located artefact with the right
 * content type and an attachment filename; 404 when none ships.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { installResolveStub } = require('../../testUtils/stubRequire');

const state = { found: null, locateOpts: null };
const locatorStub = { locate: async (opts) => { state.locateOpts = opts; return state.found; } };
const permissionsStub = {
    requireAuth: (req, res, next) => (req.session?.user ? next() : res.status(401).json({ error: 'Not authenticated' })),
    requirePermission: () => (req, res, next) => (req.session?.user?.canCompliance ? next() : res.status(403).json({ error: 'forbidden' })),
};
const restore = installResolveStub({
    '../../compliance/lib/sbomLocator': locatorStub,
    '../../auth/permissions': permissionsStub,
});
const router = require('./sbom');
test.after(() => restore());

let currentSession = null;
const app = express();
app.use((req, _res, next) => { req.session = currentSession; next(); });
app.use('/api/compliance', router);
let server; let base;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbom-route-'));
test.before(async () => {
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}/api/compliance`;
});
test.after(async () => {
    if (server) await new Promise((r) => server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
});

async function get(p, session) {
    currentSession = session;
    const res = await fetch(base + p);
    return { status: res.status, headers: res.headers, text: await res.text() };
}
const ADMIN = { user: { id: 'u_a', canCompliance: true } };
const NO_PERM = { user: { id: 'u_b' } };

function artefact(name, content, format) {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, content);
    return { path: p, format, parsed: {}, size: Buffer.byteLength(content), mtime: new Date().toISOString(), tried: [], sha256: crypto.createHash('sha256').update(content).digest('hex') };
}

test.beforeEach(() => { state.found = null; state.locateOpts = null; });

test('gates: 401 anonymous, 403 without admin_compliance', async () => {
    state.found = artefact('sbom.cdx.json', '{"bomFormat":"CycloneDX"}', 'cyclonedx');
    assert.equal((await get('/sbom', null)).status, 401);
    assert.equal((await get('/sbom', NO_PERM)).status, 403);
    assert.equal(state.locateOpts, null);
});

test('GET /sbom streams a CycloneDX artefact with its media type, attachment filename and hash header', async () => {
    const body = JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.5', components: [{ name: 'express' }] });
    state.found = artefact('sbom.cdx.json', body, 'cyclonedx');
    const res = await get('/sbom', ADMIN);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/vnd.cyclonedx+json');
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="sbom.cdx.json"');
    assert.equal(res.headers.get('content-length'), String(Buffer.byteLength(body)));
    assert.equal(res.headers.get('x-content-sha256'), state.found.sha256);
    assert.equal(res.headers.get('x-sbom-format'), 'cyclonedx');
    assert.equal(res.text, body);
    assert.equal(state.locateOpts.hash, true);
});

test('SPDX and the licences markdown get their own content types and extensions', async () => {
    state.found = artefact('sbom.spdx', '{"spdxVersion":"SPDX-2.3"}', 'spdx');
    let res = await get('/sbom', ADMIN);
    assert.equal(res.headers.get('content-type'), 'application/spdx+json');
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="sbom.spdx.json"');

    state.found = artefact('THIRD-PARTY-LICENSES.md', '# Licences\n', 'licenses-md');
    res = await get('/sbom', ADMIN);
    assert.equal(res.headers.get('content-type'), 'text/markdown; charset=utf-8');
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="THIRD-PARTY-LICENSES.md"');
});

test('GET /sbom → 404 sbom_not_found when the locator finds nothing (tried list passed through)', async () => {
    state.found = { path: null, format: null, parsed: null, size: 0, mtime: null, tried: [{ path: '/app/sbom.json', reason: 'not found' }] };
    const res = await get('/sbom', ADMIN);
    assert.equal(res.status, 404);
    const body = JSON.parse(res.text);
    assert.equal(body.error, 'sbom_not_found');
    assert.equal(body.tried.length, 1);
});

test('GET /sbom → 404 when the located file vanished between locate and stream', async () => {
    state.found = artefact('gone.json', '{"bomFormat":"CycloneDX"}', 'cyclonedx');
    fs.unlinkSync(state.found.path);
    assert.equal((await get('/sbom', ADMIN)).status, 404);
});

test('GET /sbom/meta describes the artefact without streaming it', async () => {
    state.found = { ...artefact('sbom.cdx.json', '{}', 'cyclonedx'), parsed: { components: [{}, {}, {}] } };
    const res = await get('/sbom/meta', ADMIN);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.text);
    assert.deepEqual({ format: body.format, filename: body.filename, components: body.components, sha256: body.sha256 }, { format: 'cyclonedx', filename: 'sbom.cdx.json', components: 3, sha256: state.found.sha256 });
});

test('helpers: contentTypeFor falls back to application/json; filenameFor sanitises', () => {
    assert.equal(router.contentTypeFor('unknown'), 'application/json');
    assert.equal(router.filenameFor({ path: '/x/my sbom (1)', format: 'cyclonedx' }), 'my_sbom__1_.json');
    assert.equal(router.filenameFor(null), 'sbom.json');
});
