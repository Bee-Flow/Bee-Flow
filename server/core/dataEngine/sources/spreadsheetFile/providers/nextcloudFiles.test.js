/**
 * Nextcloud Files as a mirror storage, against a recording WebDAV fetch
 * (pattern: integrations/nextcloudFiles/officeDocuments.test.js) and a
 * recording scope guard: the PROPFIND Depth 0 body asks for the etag, the
 * etag is kept verbatim (quotes included), owned/writable come from
 * oc:owner-id and oc:permissions, browsing goes through guardedNcCall
 * ('nextcloud_list_files'), search through 'nextcloud_search_files', a PUT
 * carries If-Match + OC-Total-Length + a Buffer body and NEVER a MKCOL,
 * 412 → conflict, 423 → locked, 403 → forbidden, a scope denial refuses
 * before any fetch, the deep link comes from the org's PUBLIC URL (never
 * the connector proxy route) and a refusal names the file by its path.
 *
 * Run: cd server && node --test core/dataEngine/sources/spreadsheetFile/providers/nextcloudFiles.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../../../../testUtils/stubRequire');

const BASE = 'https://nc.example.test';
const ROOT = `${BASE}/remote.php/dav/files/alice`;
const calls = { fetch: [], checks: [], guarded: [], orgs: [] };
const world = { denial: null, propfindStatus: 207, putStatus: 204, putEtag: '"after"', getStatus: 200, ncConnected: true, org: { id: 'org_1', nc_base_url: 'https://nc.example.test/' } };

const fakeNcClient = {
    webdavRoot: (baseUrl, uid) => `${baseUrl}/remote.php/dav/files/${encodeURIComponent(uid)}`,
    isConnected: async () => world.ncConnected,
    REQUEST_TIMEOUT_MS: 20000,
};
const restore = installResolveStub({
    '../nextcloudClient': fakeNcClient,                          // what webdav.js loads
    '../../../../../integrations/nextcloudClient': fakeNcClient,  // what the provider loads
    '../../../../../stores/userStore': { getOrganization: async (id) => { calls.orgs.push(id); return world.org; } },
    '../../../../integrations/ncScopeGuard': {
        checkToolCall: async (args) => { calls.checks.push(args); return world.denial; },
        guardedNcCall: async (toolName, toolArgs, ctx, run) => {
            calls.guarded.push({ toolName, toolArgs, ctx });
            if (world.denial) return world.denial;
            return run();
        },
    },
});
const nextcloudFiles = require('./nextcloudFiles');
test.after(() => restore());

function multistatus(entries) {
    const resp = entries.map((e) => `<d:response><d:href>${e.href}</d:href><d:propstat><d:prop>`
        + (e.folder ? '<d:resourcetype><d:collection/></d:resourcetype>' : '<d:resourcetype/>')
        + (e.size != null ? `<d:getcontentlength>${e.size}</d:getcontentlength>` : '')
        + (e.type ? `<d:getcontenttype>${e.type}</d:getcontenttype>` : '')
        + `<d:getlastmodified>Tue, 01 Sep 2026 10:00:00 GMT</d:getlastmodified>`
        + (e.fileId ? `<oc:fileid>${e.fileId}</oc:fileid>` : '')
        + (e.etag ? `<d:getetag>${e.etag.replace(/"/g, '&quot;')}</d:getetag>` : '')
        + (e.permissions ? `<oc:permissions>${e.permissions}</oc:permissions>` : '')
        + (e.owner ? `<oc:owner-id>${e.owner}</oc:owner-id>` : '')
        + `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join('');
    return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">${resp}</d:multistatus>`;
}

const FILE = { href: '/remote.php/dav/files/alice/Documents/Facturen.xlsx', size: 4096, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileId: 42, etag: '"abc123"', permissions: 'RGDNVW', owner: 'alice' };

function response({ status, body = '', headers = {} }) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(headers),
        text: async () => (Buffer.isBuffer(body) ? body.toString('utf8') : body),
        json: async () => JSON.parse(body),
        arrayBuffer: async () => { const b = Buffer.isBuffer(body) ? body : Buffer.from(body); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
    };
}

function makeAuth({ listing = [FILE], statEntry = FILE, bytes = Buffer.from('a;b\n1;2\n'), search = [] } = {}) {
    const fetch = async (url, opts = {}) => {
        const method = opts.method || 'GET';
        calls.fetch.push({ url, method, headers: opts.headers || {}, body: opts.body, signal: opts.signal });
        if (method === 'PROPFIND') {
            if (world.propfindStatus !== 207) return response({ status: world.propfindStatus, body: 'nope' });
            const depth = opts.headers.Depth;
            return response({ status: 207, body: multistatus(depth === '0' ? [statEntry] : [{ href: '/remote.php/dav/files/alice/Documents/', folder: true, fileId: 1, owner: 'alice', permissions: 'RGDNVCK' }, ...listing]) });
        }
        if (method === 'GET' && url.includes('/ocs/v2.php/search/')) {
            return response({ status: 200, body: JSON.stringify({ ocs: { data: { entries: search } } }) });
        }
        if (method === 'GET') return response({ status: world.getStatus, body: world.getStatus === 200 ? bytes : 'gone' });
        if (method === 'PUT') return response({ status: world.putStatus, body: world.putStatus >= 400 ? 'refused' : '', headers: world.putEtag ? { 'OC-ETag': world.putEtag } : {} });
        throw new Error(`unexpected method ${method}`);
    };
    return { mode: 'basic', baseUrl: BASE, uid: 'alice', fetch, authError: 'Reconnect Nextcloud' };
}

const ctx = { userId: 'u1', orgId: 'org_1', session: { user: { id: 'u1', organizationId: 'org_1' } } };
const api = (opts) => nextcloudFiles.forLinker(makeAuth(opts), ctx);
const file = { path: '/Documents/Facturen.xlsx', fileId: '42', name: 'Facturen.xlsx', format: 'xlsx' };

test.beforeEach(() => {
    calls.fetch.length = 0; calls.checks.length = 0; calls.guarded.length = 0; calls.orgs.length = 0;
    Object.assign(world, { denial: null, propfindStatus: 207, putStatus: 204, putEtag: '"after"', getStatus: 200, ncConnected: true, org: { id: 'org_1', nc_base_url: 'https://nc.example.test/' } });
});

test('module shape; no cells API on Nextcloud, but resolveByPath', async () => {
    assert.equal(nextcloudFiles.provider, 'nextcloud_files');
    assert.equal(nextcloudFiles.oauthProvider, 'nextcloud');
    assert.deepEqual(nextcloudFiles.integrationAppIds, ['nextcloud']);
    const a = api();
    assert.equal(a.cells, undefined);
    assert.equal(typeof a.resolveByPath, 'function');
    assert.deepEqual(await nextcloudFiles.isConnected({ userId: 'u1', session: {} }), { connected: true, reason: null });
    world.ncConnected = false;
    assert.deepEqual(await nextcloudFiles.isConnected({ userId: 'u1', session: {} }), { connected: false, reason: 'not_connected' });
});

test('probe: PROPFIND Depth 0 under the read scope, the body asks for getetag/permissions/owner-id, the etag stays quoted', async () => {
    const p = await api().probe(file);
    assert.deepEqual(calls.checks, [{ toolName: 'nextcloud_read_file', toolArgs: { path: '/Documents/Facturen.xlsx' }, userId: 'u1', orgId: 'org_1' }]);
    assert.equal(calls.fetch.length, 1);
    const pf = calls.fetch[0];
    assert.equal(pf.method, 'PROPFIND');
    assert.equal(pf.url, `${ROOT}/Documents/Facturen.xlsx`);
    assert.equal(pf.headers.Depth, '0');
    assert.match(pf.body, /<d:getetag\/>/);
    assert.match(pf.body, /<oc:permissions\/>/);
    assert.match(pf.body, /<oc:owner-id\/>/);
    assert.deepEqual(p.marker, { etag: '"abc123"', modified: '2026-09-01T10:00:00.000Z', size: 4096, fileId: '42' });
    assert.equal(p.name, 'Facturen.xlsx');
    assert.equal(p.format, 'xlsx');
    assert.equal(p.path, '/Documents/Facturen.xlsx');
    assert.equal(p.webUrl, `${BASE}/f/42`);
    assert.equal(p.owned, true);
    assert.equal(p.writable, true);
    assert.equal(p.file.fileId, '42');
    assert.equal(nextcloudFiles.markerEquals(p.marker, { etag: '"abc123"' }), true);
    assert.equal(nextcloudFiles.markerEquals(p.marker, { etag: '"other"' }), false);
});

test('probe: a shared file owned by someone else, read-only permissions; 404 → spreadsheet_not_found naming the file by its PATH (the wire id)', async () => {
    const p = await api({ statEntry: { ...FILE, owner: 'bob', permissions: 'G' } }).probe(file);
    assert.equal(p.owned, false);
    assert.equal(p.writable, false);
    world.propfindStatus = 404;
    await assert.rejects(() => api().probe(file), (e) => e.code === 'spreadsheet_not_found' && e.status === 404 && e.ref.path === '/Documents/Facturen.xlsx' && e.ref.fileId === '/Documents/Facturen.xlsx');
    // the download path too — the probe's ref (fileId 42) must not leak in as the id a wizard cannot match
    world.propfindStatus = 207; world.getStatus = 404;
    await assert.rejects(() => api().download(file), (e) => e.code === 'spreadsheet_not_found' && e.ref.fileId === '/Documents/Facturen.xlsx');
    world.getStatus = 200; world.propfindStatus = 404;
    assert.equal(await api().resolveByPath('/Documents/Facturen.xlsx'), null);
    world.propfindStatus = 207;
    const ref = await api().resolveByPath('/Documents/Facturen.xlsx');
    assert.equal(ref.fileId, '42');
});

test('a scope denial refuses with nc_scope_denied before any fetch', async () => {
    world.denial = { error: 'outside', nc_scope_denied: true };
    await assert.rejects(() => api().probe(file), (e) => e.code === 'nc_scope_denied' && e.status === 403);
    await assert.rejects(() => api().download(file), (e) => e.code === 'nc_scope_denied');
    await assert.rejects(() => api().upload(file, Buffer.from('x'), { ifMatch: { etag: '"abc123"' } }), (e) => e.code === 'nc_scope_denied' && /writing/.test(e.message));
    await assert.rejects(() => api().list({ path: '/Documents' }), (e) => e.code === 'nc_scope_denied');
    assert.equal(calls.fetch.length, 0);
    assert.deepEqual(calls.checks.map((c) => c.toolName), ['nextcloud_read_file', 'nextcloud_read_file', 'nextcloud_upload_file']);
});

test('list: PROPFIND Depth 1 through guardedNcCall(nextcloud_list_files) in the list tool\'s shape; folders first, spreadsheets only', async () => {
    const { items, nextPageToken } = await api({ listing: [
        FILE,
        { href: '/remote.php/dav/files/alice/Documents/klanten.csv', size: 10, type: 'text/plain', fileId: 43, etag: '"c"', permissions: 'RG', owner: 'bob' },
        { href: '/remote.php/dav/files/alice/Documents/notes.md', size: 5, type: 'text/markdown', fileId: 44 },
        { href: '/remote.php/dav/files/alice/Documents/Sub/', folder: true, fileId: 45, permissions: 'RGDNVCK', owner: 'alice' },
    ] }).list({ view: 'mine', path: '/Documents/' });
    assert.equal(nextPageToken, null);
    assert.equal(calls.guarded.length, 1);
    assert.equal(calls.guarded[0].toolName, 'nextcloud_list_files');
    assert.deepEqual(calls.guarded[0].toolArgs, { path: '/Documents' });
    assert.equal(calls.guarded[0].ctx.userId, 'u1');
    assert.equal(calls.fetch[0].method, 'PROPFIND');
    assert.equal(calls.fetch[0].headers.Depth, '1');
    assert.equal(calls.fetch[0].url, `${ROOT}/Documents/`);
    assert.deepEqual(items.map((i) => [i.path, i.isFolder, i.format, i.owned, i.writable]), [
        ['/Documents/Sub', true, null, true, true],
        ['/Documents/Facturen.xlsx', false, 'xlsx', true, true],
        ['/Documents/klanten.csv', false, 'csv', false, false],
    ]);
    assert.equal(items[1].fileId, '42');
    assert.equal(items[1].etag, '"abc123"');
    assert.equal(items[1].parentId, '/Documents');
    assert.equal(items[1].webUrl, `${BASE}/f/42`);
    assert.equal(items[1].modifiedAt, '2026-09-01T10:00:00.000Z');
    await assert.rejects(() => api().list({ view: 'shared' }), (e) => e.code === 'no_shared_root' && e.status === 400);
});

test('list search: the OCS files provider under guardedNcCall(nextcloud_search_files), spreadsheet names only', async () => {
    const { items } = await api({ search: [
        { title: 'Facturen.xlsx', resourceUrl: `${BASE}/f/42`, attributes: { path: '/Documents/Facturen.xlsx', fileId: '42' } },
        { title: 'notes.md', attributes: { path: '/notes.md', fileId: '9' } },
    ] }).list({ view: 'search', q: 'fact' });
    assert.equal(calls.guarded[0].toolName, 'nextcloud_search_files');
    assert.deepEqual(calls.guarded[0].toolArgs, { query: 'fact' });
    assert.match(calls.fetch[0].url, /\/ocs\/v2\.php\/search\/providers\/files\/search\?term=fact&limit=50&format=json$/);
    assert.equal(calls.fetch[0].headers['OCS-APIRequest'], 'true');
    assert.deepEqual(items.map((i) => [i.fileId, i.path, i.format]), [['42', '/Documents/Facturen.xlsx', 'xlsx']]);
    assert.deepEqual(await api().list({ view: 'search', q: '' }), { items: [], nextPageToken: null });
});

test('download: probe first (size cap), then a GET with a timeout signal; the marker is the probed etag', async () => {
    const { buffer, marker } = await api().download(file, { maxBytes: 20e6 });
    assert.equal(buffer.toString(), 'a;b\n1;2\n');
    assert.equal(marker.etag, '"abc123"');
    const get = calls.fetch.find((c) => c.method === 'GET');
    assert.equal(get.url, `${ROOT}/Documents/Facturen.xlsx`);
    assert.ok(get.signal instanceof AbortSignal);
    calls.fetch.length = 0;
    await assert.rejects(() => api().download(file, { maxBytes: 100 }), (e) => e.code === 'spreadsheet_too_large' && e.status === 413);
    assert.equal(calls.fetch.filter((c) => c.method === 'GET').length, 0);
    world.getStatus = 404;
    await assert.rejects(() => api().download(file), (e) => e.code === 'spreadsheet_not_found');
});

test('upload: PUT with If-Match, OC-Total-Length, the format\'s content type and a Buffer body — and no MKCOL; the new etag from the response', async () => {
    const buf = Buffer.from('new bytes');
    const r = await api().upload(file, buf, { ifMatch: { etag: '"abc123"', fileId: '42' } });
    assert.equal(calls.checks.at(-1).toolName, 'nextcloud_upload_file');
    assert.deepEqual(calls.checks.at(-1).toolArgs, { path: '/Documents/Facturen.xlsx' });
    assert.equal(calls.fetch.filter((c) => c.method === 'MKCOL').length, 0);
    const put = calls.fetch.find((c) => c.method === 'PUT');
    assert.equal(put.url, `${ROOT}/Documents/Facturen.xlsx`);
    assert.equal(put.headers['If-Match'], '"abc123"');
    assert.equal(put.headers['OC-Total-Length'], String(buf.length));
    assert.equal(put.headers['Content-Type'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.ok(Buffer.isBuffer(put.body));
    assert.ok(put.signal instanceof AbortSignal);
    assert.equal(r.marker.etag, '"after"');
    assert.equal(r.marker.size, buf.length);
    assert.equal(r.marker.fileId, '42');
    // csv gets text/csv; a caller's content type wins
    await api().upload({ path: '/k.csv' }, buf, {});
    assert.equal(calls.fetch.at(-1).headers['Content-Type'], 'text/csv');
    assert.equal(calls.fetch.at(-1).headers['If-Match'], undefined);
    await api().upload({ path: '/k.csv' }, buf, { contentType: 'text/plain' });
    assert.equal(calls.fetch.at(-1).headers['Content-Type'], 'text/plain');
});

test('upload without an ETag response header re-PROPFINDs for the marker', async () => {
    world.putEtag = null;
    const r = await api().upload(file, Buffer.from('x'), { ifMatch: { etag: '"abc123"' } });
    assert.equal(r.marker.etag, '"abc123"');
    assert.equal(calls.fetch.map((c) => c.method).join(','), 'PUT,PROPFIND');
});

test('upload: 412 → spreadsheet_conflict, 423 → spreadsheet_locked, 403 → spreadsheet_forbidden, 401 → linker_unavailable', async () => {
    world.putStatus = 412;
    await assert.rejects(() => api().upload(file, Buffer.from('x'), { ifMatch: { etag: '"old"' } }), (e) => e.code === 'spreadsheet_conflict' && e.status === 409);
    world.putStatus = 423;
    await assert.rejects(() => api().upload(file, Buffer.from('x'), {}), (e) => e.code === 'spreadsheet_locked' && e.status === 409);
    world.putStatus = 403;
    await assert.rejects(() => api().upload(file, Buffer.from('x'), {}), (e) => e.code === 'spreadsheet_forbidden' && e.status === 403);
    world.putStatus = 401;
    await assert.rejects(() => api().upload(file, Buffer.from('x'), {}), (e) => e.code === 'linker_unavailable' && e.status === 503);
});

test('the deep link: a bearer/app-password auth links under its own baseUrl; a connector auth links under the org\'s PUBLIC URL, or not at all', async () => {
    // basic/bearer: baseUrl IS the public URL (the existing assertions above)
    assert.equal((await api().probe(file)).webUrl, `${BASE}/f/42`);
    assert.deepEqual(calls.orgs, [], 'no org lookup needed');
    // connector: baseUrl is the AppAPI proxy route, which forwards no /f/ link — 404 for every viewer
    const PROXY = `${BASE}/index.php/apps/app_api/proxy/bee_flow/nc`;
    const connector = (over = {}) => nextcloudFiles.forLinker({ ...makeAuth(), mode: 'connector', baseUrl: PROXY, session: { connectorOrgId: 'org_1', user: { id: 'u1', organizationId: 'org_1' } }, ...over }, { userId: 'u1', session: { connectorOrgId: 'org_1', user: { id: 'u1' } } });
    let p = await connector().probe(file);
    assert.equal(p.webUrl, 'https://nc.example.test/f/42', 'the org\'s nc_base_url, trailing slash trimmed');
    assert.deepEqual(calls.orgs, ['org_1']);
    assert.ok(!p.webUrl.includes('app_api'), 'never the proxy route');
    // the listing and the search hits follow the same rule, and the org is read once per api
    const a = connector();
    const { items } = await a.list({ path: '/Documents' });
    assert.equal(items[0].webUrl, 'https://nc.example.test/f/42');
    await a.probe(file);
    assert.equal(calls.orgs.length, 2, 'one lookup per api instance');
    const search = await nextcloudFiles.forLinker({ ...makeAuth({ search: [{ title: 'Facturen.xlsx', resourceUrl: `${PROXY}/f/42`, attributes: { path: '/Documents/Facturen.xlsx', fileId: '42' } }] }), mode: 'connector', baseUrl: PROXY, session: { connectorOrgId: 'org_1' } }, { userId: 'u1' }).list({ view: 'search', q: 'fact' });
    assert.equal(search.items[0].webUrl, 'https://nc.example.test/f/42');
    // no public URL known → no link (the card renders a plain name), never a guess
    world.org = { id: 'org_1' };
    p = await connector().probe(file);
    assert.equal(p.webUrl, null);
    world.org = null;
    assert.equal((await connector().probe(file)).webUrl, null);
    // an auth that says its public URL outright wins over any lookup
    world.org = { id: 'org_1', nc_base_url: 'https://wrong.example' };
    calls.orgs.length = 0;
    assert.equal((await connector({ publicBaseUrl: 'https://cloud.example.org/' }).probe(file)).webUrl, 'https://cloud.example.org/f/42');
    assert.deepEqual(calls.orgs, []);
    // a proxy-shaped baseUrl without the mode flag is treated as proxied too
    assert.equal((await nextcloudFiles.forLinker({ ...makeAuth(), baseUrl: PROXY, session: { connectorOrgId: 'org_1' } }, { userId: 'u1' }).probe(file)).webUrl, 'https://wrong.example/f/42');
    // a proxied auth without any org to ask: null
    assert.equal((await nextcloudFiles.forLinker({ ...makeAuth(), mode: 'connector', baseUrl: PROXY }, { userId: 'u1' }).probe(file)).webUrl, null);
});

test('helpers: paths normalised, RFC1123 → ISO', () => {
    assert.equal(nextcloudFiles.normalizePath('Documents//x.xlsx/'), '/Documents/x.xlsx');
    assert.equal(nextcloudFiles.normalizePath(''), '/');
    assert.equal(nextcloudFiles.isoOf('Tue, 01 Sep 2026 10:00:00 GMT'), '2026-09-01T10:00:00.000Z');
    assert.equal(nextcloudFiles.isoOf('garbage'), null);
});
