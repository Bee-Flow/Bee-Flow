/**
 * stampExport(kind) — an export that succeeded leaves one evidence row; a
 * failed one, an anonymous one or a broken evidence table leaves nothing and
 * never touches the response. The payload is allow-listed: kind, format,
 * status, method, timestamp, actor id — no path, no query, no e-mail.
 *
 * Run: cd server && node --test --test-force-exit compliance/dataPortability/stampExport.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { installResolveStub } = require('../../testUtils/stubRequire');

const state = { evidence: [], addError: null, users: {} };

const fakeComplianceStore = {
    async addEvidence(row) {
        if (state.addError) throw state.addError;
        state.evidence.push(row);
    },
};
const fakeUserStore = {
    async getUser(id) { return state.users[id] || null; },
};

const restore = installResolveStub({
    '../../stores/complianceStore': fakeComplianceStore,
    '../../stores/userStore': fakeUserStore,
});
const stampExport = require('./stampExport');
test.after(() => restore());

function fakeRes(statusCode, headers = {}) {
    const res = new EventEmitter();
    res.statusCode = statusCode;
    res.getHeader = (name) => headers[String(name).toLowerCase()];
    return res;
}
function fakeReq(over = {}) {
    return {
        method: 'GET',
        originalUrl: '/api/automation/abc-123/export?format=json&email=someone@example.org',
        path: '/abc-123/export',
        params: { id: 'abc-123' },
        query: { email: 'someone@example.org' },
        session: { user: { id: 'user-1', organizationId: 'org-1', email: 'admin@example.org' } },
        ...over,
    };
}
/** Run the middleware, finish the response, wait for the async stamp. */
async function drive(mw, req, res) {
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true, 'the export handler always runs');
    res.emit('finish');
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
}

test.beforeEach(() => { state.evidence = []; state.addError = null; state.users = {}; });

test('factory validates its argument and exposes the constants the check reads', () => {
    assert.throws(() => stampExport(), /kind is required/);
    assert.throws(() => stampExport(42), /kind is required/);
    assert.equal(stampExport.CHECK_ID, 'DATA_ACT-Art25-exit-procedure');
    assert.equal(stampExport.ACTION, 'data_export_performed');
    assert.equal(stampExport.SUBJECT_TYPE, 'export');
    assert.equal(typeof stampExport('x'), 'function');
    assert.equal(stampExport.stampExport, stampExport);
});

test('a 2xx export writes one evidence row with the allow-listed payload and the kind as subject', async () => {
    const res = fakeRes(200, { 'content-type': 'application/json; charset=utf-8' });
    await drive(stampExport('automations'), fakeReq(), res);
    assert.equal(state.evidence.length, 1);
    const row = state.evidence[0];
    assert.equal(row.organization_id, 'org-1');
    assert.equal(row.check_id, 'DATA_ACT-Art25-exit-procedure');
    assert.equal(row.subject_type, 'export');
    assert.equal(row.subject_id, 'automations');
    assert.match(row.hash, /^[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(row.payload).sort(), ['action', 'at', 'by', 'format', 'kind', 'method', 'status']);
    assert.equal(row.payload.action, 'data_export_performed');
    assert.equal(row.payload.kind, 'automations');
    assert.equal(row.payload.format, 'json');
    assert.equal(row.payload.status, 200);
    assert.equal(row.payload.method, 'GET');
    assert.equal(row.payload.by, 'user-1');
    assert.ok(!Number.isNaN(Date.parse(row.payload.at)));
});

test('the payload carries no path, query, item id or e-mail address (BFSF-441)', async () => {
    const res = fakeRes(200, { 'content-type': 'text/csv' });
    await drive(stampExport('datatables'), fakeReq(), res);
    const blob = JSON.stringify(state.evidence[0]);
    assert.ok(!/@/.test(blob), `no e-mail address in the evidence row: ${blob}`);
    assert.ok(!/abc-123/.test(blob), 'no exported item id');
    assert.ok(!/export\?/.test(blob) && !/originalUrl|format=json/.test(blob), 'no URL or query string');
});

test('format: read from the content-type, or fixed by the route when the header does not say', async () => {
    const cases = [
        ['application/zip', 'zip'], ['application/pdf', 'pdf'], ['text/markdown; charset=utf-8', 'md'],
        ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
        ['text/plain', 'txt'], ['text/html', 'html'], ['application/octet-stream', null], ['', null],
    ];
    for (const [ct, expected] of cases) {
        state.evidence = [];
        await drive(stampExport('k'), fakeReq(), fakeRes(200, { 'content-type': ct }));
        assert.equal(state.evidence[0].payload.format, expected, `content-type ${ct}`);
    }
    state.evidence = [];
    await drive(stampExport('datatables', { format: 'csv' }), fakeReq(), fakeRes(200, { 'content-type': 'application/octet-stream' }));
    assert.equal(state.evidence[0].payload.format, 'csv');
    // A response whose getHeader throws (headers torn down) still stamps, format unknown.
    const torn = fakeRes(200);
    torn.getHeader = () => { throw new Error('gone'); };
    state.evidence = [];
    await drive(stampExport('k'), fakeReq(), torn);
    assert.equal(state.evidence[0].payload.format, null);
});

test('non-2xx responses are not an export: 403, 404, 500 and 304 leave no row', async () => {
    for (const code of [304, 403, 404, 500]) {
        await drive(stampExport('automations'), fakeReq(), fakeRes(code, { 'content-type': 'application/json' }));
    }
    assert.equal(state.evidence.length, 0);
    await drive(stampExport('automations'), fakeReq(), fakeRes(201, {}));
    assert.equal(state.evidence.length, 1, '2xx other than 200 does count');
});

test('no organisation can be resolved → nothing is recorded (anonymous request, unknown user)', async () => {
    await drive(stampExport('memories'), fakeReq({ session: undefined, user: undefined }), fakeRes(200));
    await drive(stampExport('memories'), fakeReq({ session: { user: { id: 'ghost' } } }), fakeRes(200));
    assert.equal(state.evidence.length, 0);
});

test('an org id missing from the session is looked up through userStore, and req.user is honoured too', async () => {
    state.users['user-2'] = { id: 'user-2', organizationId: 'org-2', email: 'x@example.org' };
    await drive(stampExport('meeting_notes'), fakeReq({ session: { user: { id: 'user-2' } } }), fakeRes(200, { 'content-type': 'text/markdown' }));
    assert.equal(state.evidence[0].organization_id, 'org-2');
    assert.equal(state.evidence[0].payload.by, 'user-2');
    await drive(stampExport('solutions'), fakeReq({ session: undefined, user: { id: 'u3', organizationId: 'org-3' }, method: 'post' }), fakeRes(200, { 'content-type': 'application/json' }));
    assert.equal(state.evidence[1].organization_id, 'org-3');
    assert.equal(state.evidence[1].payload.method, 'POST');
    assert.ok(!/@/.test(JSON.stringify(state.evidence)));
});

test('a failing evidence store is swallowed — the export already succeeded', async () => {
    state.addError = new Error('relation "compliance_evidence" does not exist');
    await assert.doesNotReject(async () => {
        await drive(stampExport('automations'), fakeReq(), fakeRes(200, { 'content-type': 'application/json' }));
    });
    assert.equal(state.evidence.length, 0);
});

test('a response double without an event emitter (route unit tests) just passes through', () => {
    let nextCalled = false;
    const bare = { statusCode: 200, status() { return this; }, json() { return this; } };
    assert.doesNotThrow(() => stampExport('datatables')(fakeReq(), bare, () => { nextCalled = true; }));
    assert.equal(nextCalled, true);
    assert.doesNotThrow(() => stampExport('datatables')(fakeReq(), null, () => {}));
});

test('record() is exported for callers that stamp outside a middleware and returns the payload or null', async () => {
    const payload = await stampExport.record(fakeReq(), fakeRes(200, { 'content-type': 'application/zip' }), 'cms_sites', null);
    assert.equal(payload.kind, 'cms_sites');
    assert.equal(payload.format, 'zip');
    assert.equal(await stampExport.record(fakeReq(), fakeRes(500), 'cms_sites', null), null);
});
