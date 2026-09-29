/**
 * Route tests for routes/compliance/evidence.js (review finding M10).
 *
 * The file had no test at all, and its most important property is an ORDERING
 * its own comment calls load-bearing:
 *
 *   `/evidence` and `/evidence/chain` MUST stay above `/evidence/:checkId` —
 *   otherwise 'chain' is read as a check id.
 *
 * That regression does not throw. `/evidence/chain` would answer `200 []` from
 * `getEvidenceHistory(orgId, 'chain')` — the one endpoint whose job is to say
 * whether the evidence chain is intact, reporting "nothing wrong" without ever
 * having verified anything. So the chain tests below assert BOTH that the
 * verifier ran and that the per-check history did NOT.
 *
 * Also pinned: the three chain outcomes (ok · a break with `first_break` ·
 * `ok: null` + `columns_missing`, which the client must render as "unknown",
 * never as "broken"), the CHAIN_LIMIT_MAX clamp, `?regulation=` + paging on the
 * flat list (with `total` under the SAME filter), and the gate.
 *
 * Run: cd server && node --test --test-force-exit routes/compliance/evidence.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { installResolveStub } = require('../../testUtils/stubRequire');

// ── Doubles ────────────────────────────────────────────────────────────────
const calls = { list: [], count: [], history: [], byId: [], chain: [], evidence: [], uploads: [], streams: [] };
const reset = () => { for (const k of Object.keys(calls)) calls[k].length = 0; };

const ROWS = [
    { id: 11, seq: 3, check_id: 'GDPR-Art33-breach-notification', subject_type: 'check', hash: 'a'.repeat(64), captured_at: '2026-09-14T09:00:00.000Z' },
    { id: 10, seq: 2, check_id: 'GDPR-Art32-dlp-enabled', subject_type: 'check', hash: 'b'.repeat(64), captured_at: '2026-09-13T09:00:00.000Z' },
];

let listImpl = async () => ROWS;
let countImpl = async () => 2;
let historyImpl = async () => [ROWS[0]];
let byIdImpl = async (orgId, id) => (id === '10' ? { id: 10, storage_key: 'iso-evidence/orgA/deadbeef-report.pdf', payload: { filename: 'report.pdf' } } : null);
let chainImpl = async () => ({
    ok: true, rows_total: 2053, chained_rows: 2053, pre_chain_rows: 0, pre_chain_invalid: 0,
    verified_rows: 500, first_break: null, head: 'c'.repeat(64), window: { limit: 500 },
    latest_captured_at: '2026-09-14T09:00:00.000Z', checked_at: '2026-09-14T12:00:00.000Z',
});

const complianceStore = {
    listEvidence: async (orgId, opts) => { calls.list.push({ orgId, opts }); return listImpl(orgId, opts); },
    countEvidence: async (orgId, filters) => { calls.count.push({ orgId, filters }); return countImpl(orgId, filters); },
    getEvidenceHistory: async (orgId, checkId, limit) => { calls.history.push({ orgId, checkId, limit }); return historyImpl(orgId, checkId, limit); },
    getEvidenceById: async (orgId, id) => { calls.byId.push({ orgId, id }); return byIdImpl(orgId, id); },
    addEvidence: async (row) => { calls.evidence.push(row); return { id: 99, seq: 4, hash: row.hash }; },
};

const chainModule = {
    verifyChain: async (orgId, opts) => { calls.chain.push({ orgId, opts }); return chainImpl(orgId, opts); },
};

const storageStore = {
    uploadFile: async (key, buf, type) => { calls.uploads.push({ key, bytes: buf.length, type }); },
    streamFile: async (key) => {
        calls.streams.push(key);
        if (key === 'iso-evidence/orgA/gone') { const e = new Error('gone'); e.name = 'NoSuchKey'; throw e; }
        const { Readable } = require('node:stream');
        return { stream: Readable.from([Buffer.from('PDFBYTES')]), contentType: 'application/pdf', contentLength: 8 };
    },
};

const userStore = { getUser: async (id) => ({ id, organizationId: 'orgA' }) };

const permissionsAsked = [];
let denyPermission = false;
const permissions = {
    requireAuth: (req, res, next) => (req.headers['x-test-user'] ? next() : res.status(401).json({ error: 'Not authenticated' })),
    requirePermission: (name) => {
        permissionsAsked.push(name);
        return (req, res, next) => (denyPermission ? res.status(403).json({ error: 'forbidden' }) : next());
    },
};

const restore = installResolveStub({
    '../../stores/complianceStore': complianceStore,
    '../../stores/userStore': userStore,
    // Same double under the spelling auth/orgScope.js uses — that is where
    // ./shared's org read happens, and installResolveStub keys on the string
    // as written, so without this the real store loads and the org is wrong.
    '../stores/userStore': userStore,
    '../../stores/soaStore': { getStats: async () => null },
    '../../stores/ismsDocStore': { listDocs: async () => [] },
    '../../stores/storageStore': storageStore,
    '../../compliance/evidence/chain': chainModule,
    '../../compliance/registry': { get: () => null, getAll: () => [] },
    '../../auth/permissions': permissions,
});

const router = require('./evidence');
test.after(() => restore());

// ── Harness ────────────────────────────────────────────────────────────────
let server; let baseUrl;
test.before(async () => {
    const app = express();
    app.use((req, _res, next) => {
        req.session = req.headers['x-test-user'] ? { isAuthenticated: true, user: { id: req.headers['x-test-user'] } } : {};
        next();
    });
    app.use('/api/compliance', router);
    app.use(require('../../core/http/terminalErrorHandler').terminalErrorHandler);
    server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) await new Promise(r => server.close(r)); });
test.beforeEach(() => {
    reset();
    denyPermission = false;
    listImpl = async () => ROWS;
    countImpl = async () => 2;
    historyImpl = async () => [ROWS[0]];
    chainImpl = async () => ({ ok: true, rows_total: 2053, verified_rows: 500, first_break: null, window: { limit: 500 } });
});

const api = (p, init) => fetch(`${baseUrl}/api/compliance${p}`, { headers: { 'x-test-user': 'u1' }, ...init });
const getJson = async (p, init) => { const res = await api(p, init); return { res, status: res.status, body: await res.json() }; };

// ── The ordering ───────────────────────────────────────────────────────────

test('GET /evidence/chain reaches the VERIFIER, not the per-check history route', async () => {
    const { status, body } = await getJson('/evidence/chain');
    assert.equal(status, 200);
    // The regression's signature: a 200 with an empty array and no verification.
    assert.equal(Array.isArray(body), false, "'chain' must not be read as a check id");
    assert.deepEqual(calls.history, [], 'getEvidenceHistory was never asked for a check called "chain"');
    assert.equal(calls.chain.length, 1, 'the chain was actually verified');
    assert.equal(body.ok, true);
    assert.equal(body.rows_total, 2053);
    assert.equal(body.verified_rows, 500);
});

test('GET /evidence (the flat list) is not shadowed by /evidence/:checkId either', async () => {
    const { status, body } = await getJson('/evidence');
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body).sort(), ['limit', 'offset', 'rows', 'total']);
    assert.deepEqual(calls.history, [], 'the list route does not go through the per-check history');
    assert.equal(calls.list.length, 1);
});

test('GET /evidence/:checkId still resolves for a real check id', async () => {
    const { status, body } = await getJson('/evidence/GDPR-Art32-dlp-enabled');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
    assert.deepEqual(calls.history, [{ orgId: 'orgA', checkId: 'GDPR-Art32-dlp-enabled', limit: 100 }]);
    assert.deepEqual(calls.chain, [], 'and it does not verify the chain');
});

test('the source keeps the documented order: /evidence and /evidence/chain above /evidence/:checkId', () => {
    const src = fs.readFileSync(path.join(__dirname, 'evidence.js'), 'utf8');
    const at = (needle) => {
        const i = src.indexOf(needle);
        assert.notEqual(i, -1, `${needle} still exists`);
        return i;
    };
    const list = at("router.get('/evidence',");
    const chain = at("router.get('/evidence/chain',");
    const byCheck = at("router.get('/evidence/:checkId',");
    assert.ok(list < byCheck && chain < byCheck,
        'a wildcard declared first swallows both — express matches in declaration order');
});

// ── The chain report's three outcomes ──────────────────────────────────────

test('chain: a BREAK is passed through with first_break, untouched', async () => {
    const report = {
        ok: false, rows_total: 90, chained_rows: 90, verified_rows: 90,
        first_break: { seq: 41, kind: 'link', expected: 'd'.repeat(64), found: 'e'.repeat(64) },
        head: 'f'.repeat(64), window: { limit: 500 }, checked_at: '2026-09-14T12:00:00.000Z',
    };
    chainImpl = async () => report;
    const { status, body } = await getJson('/evidence/chain');
    assert.equal(status, 200, 'a broken chain is a successful REPORT, not a failed request');
    assert.deepEqual(body, report, 'the route adds nothing — the report shape cannot drift from the verifier');
    assert.equal(body.first_break.seq, 41);
});

test('chain: ok:null + columns_missing stays NULL — "not provisioned" is not "broken"', async () => {
    chainImpl = async () => ({ ok: null, reason: 'columns_missing', rows_total: 0, verified_rows: 0 });
    const { status, body } = await getJson('/evidence/chain');
    assert.equal(status, 200);
    assert.equal(body.ok, null, 'the client renders "unknown" for null and "broken" for false — never coerce');
    assert.notEqual(body.ok, false);
    assert.equal(body.reason, 'columns_missing');
});

test('chain: a verifier failure is a 500, never a quiet "ok"', async () => {
    chainImpl = async () => { throw new Error('statement timeout'); };
    const { status, body } = await getJson('/evidence/chain');
    assert.equal(status, 500);
    assert.equal(body.error, 'Internal server error');
    assert.equal(body.ok, undefined);
});

test('chain: ?limit is clamped to CHAIN_LIMIT_MAX (a request-time verify re-hashes the whole window)', async () => {
    const limitOf = async (q) => { await getJson(`/evidence/chain${q}`); return calls.chain.at(-1).opts.limit; };
    assert.equal(await limitOf(''), 500, 'default');
    assert.equal(await limitOf('?limit=25'), 25);
    assert.equal(await limitOf('?limit=999999'), 2000, 'clamped to CHAIN_LIMIT_MAX');
    assert.equal(await limitOf('?limit=0'), 1);
    assert.equal(await limitOf('?limit=-40'), 1);
    assert.equal(await limitOf('?limit=all'), 500, 'garbage falls back to the default, it does not become NaN');
});

test('chain sets private, no-store — a verification verdict is never cached', async () => {
    const { res } = await getJson('/evidence/chain');
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
});

// ── The flat, paged ledger ─────────────────────────────────────────────────

test('GET /evidence: ?regulation= filters, and `total` is counted under the SAME filter', async () => {
    countImpl = async () => 41;
    const { body } = await getJson('/evidence?regulation=GDPR');
    assert.deepEqual(calls.list, [{ orgId: 'orgA', opts: { regulation: 'GDPR', limit: 50, offset: 0 } }]);
    assert.deepEqual(calls.count, [{ orgId: 'orgA', filters: { regulation: 'GDPR' } }],
        'a pager over a filtered list needs the filtered total, not the grand total');
    assert.equal(body.total, 41);
    assert.equal(body.rows.length, 2);
});

test('GET /evidence: subject_type filters too, and an absent filter is absent (not an explicit null)', async () => {
    await getJson('/evidence?subject_type=soa');
    assert.deepEqual(calls.count[0].filters, { subjectType: 'soa' });
    await getJson('/evidence');
    assert.deepEqual(calls.count[1].filters, {}, 'no filter keys at all — the store decides its own defaults');
});

test('GET /evidence: limit/offset paging, clamped and echoed back so the pager can trust them', async () => {
    const page = async (q) => { const { body } = await getJson(`/evidence${q}`); return { sent: calls.list.at(-1).opts, echoed: { limit: body.limit, offset: body.offset } }; };
    let p = await page('');
    assert.deepEqual(p.sent, { limit: 50, offset: 0 });
    assert.deepEqual(p.echoed, { limit: 50, offset: 0 });

    p = await page('?limit=25&offset=75');
    assert.deepEqual(p.sent, { limit: 25, offset: 75 });
    assert.deepEqual(p.echoed, { limit: 25, offset: 75 });

    p = await page('?limit=5000');
    assert.equal(p.sent.limit, 200, 'EVIDENCE_PAGE_MAX');
    p = await page('?limit=0');
    assert.equal(p.sent.limit, 1);
    p = await page('?offset=-10');
    assert.equal(p.sent.offset, 0, 'a negative offset is not an error, it is page one');
    p = await page('?limit=lots&offset=later');
    assert.deepEqual(p.sent, { limit: 50, offset: 0 }, 'garbage → defaults, never NaN into the store');
});

test('GET /evidence: a store that returns nothing yields [], and a store that throws yields 500', async () => {
    listImpl = async () => null;
    countImpl = async () => 0;
    let r = await getJson('/evidence');
    assert.deepEqual(r.body.rows, [], 'null rows render as an empty ledger, not as a crash');

    listImpl = async () => { throw new Error('pool exhausted'); };
    r = await getJson('/evidence');
    assert.equal(r.status, 500);
    assert.equal(r.body.error, 'Internal server error');
    assert.equal(r.body.rows, undefined);
});

test('GET /evidence: the ledger is not cached either', async () => {
    const { res } = await getJson('/evidence');
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
});

// ── Attachments ────────────────────────────────────────────────────────────

test('GET /evidence/file/:id streams the stored object, 404s when the row carries no file', async () => {
    const res = await api('/evidence/file/10');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="report.pdf"');
    assert.equal(await res.text(), 'PDFBYTES');

    const missing = await getJson('/evidence/file/404');
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.body, { error: 'no_file' });
    assert.equal(calls.streams.length, 1, 'no storage call for a row without a storage_key');
});

test('GET /evidence/file/:id: a vanished object is 404 file_gone, not a 500', async () => {
    byIdImpl = async () => ({ id: 7, storage_key: 'iso-evidence/orgA/gone', payload: {} });
    try {
        const { status, body } = await getJson('/evidence/file/7');
        assert.equal(status, 404);
        assert.deepEqual(body, { error: 'file_gone' });
    } finally {
        byIdImpl = async (orgId, id) => (id === '10' ? { id: 10, storage_key: 'iso-evidence/orgA/deadbeef-report.pdf', payload: { filename: 'report.pdf' } } : null);
    }
});

test('POST /iso/evidence/upload: sha256 of the BYTES, a sanitised name, and an allow-listed payload', async () => {
    const bytes = Buffer.from('pentest report body');
    const sha = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'application/pdf' }), 'Pentest/../report 2026;rm.pdf');
    form.append('subject_type', 'attachment');
    form.append('subject_id', 'A.5.7');
    form.append('note', 'annual pentest');

    const res = await fetch(`${baseUrl}/api/compliance/iso/evidence/upload`, { method: 'POST', headers: { 'x-test-user': 'u1' }, body: form });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.uploaded, true);
    assert.equal(body.sha256, sha, 'the hash is over the bytes, so the chain covers the file itself');
    assert.equal(/[/\\;]/.test(body.filename), false, 'path separators and shell characters are scrubbed from the stored name');

    assert.equal(calls.uploads.length, 1);
    assert.equal(calls.uploads[0].bytes, bytes.length);
    assert.ok(calls.uploads[0].key.startsWith(`iso-evidence/orgA/${sha.slice(0, 16)}-`), 'the object key is org-scoped and content-addressed');

    const row = calls.evidence[0];
    assert.equal(row.organization_id, 'orgA');
    assert.equal(row.hash, sha);
    assert.deepEqual(Object.keys(row.payload).sort(),
        ['action', 'at', 'by', 'content_type', 'filename', 'note', 'sha256', 'size'],
        'the evidence payload is an allow-list: metadata about the file, never its bytes and never a person');
    assert.equal(row.payload.by, 'u1', 'an actor ID — not a name, not an address');
    assert.equal(JSON.stringify(row.payload).includes('pentest report body'), false, 'the bytes stay in object storage');
});

test('POST /iso/evidence/upload without a file is 400, and nothing is stored or chained', async () => {
    const res = await fetch(`${baseUrl}/api/compliance/iso/evidence/upload`, { method: 'POST', headers: { 'x-test-user': 'u1' }, body: new FormData() });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'file is required' });
    assert.deepEqual(calls.uploads, []);
    assert.deepEqual(calls.evidence, []);
});

// ── The gate ───────────────────────────────────────────────────────────────

test('every evidence route sits behind requireAuth + admin_compliance', () => {
    assert.equal(permissionsAsked.length, 5, 'five handlers: upload, file stream, list, chain, per-check history');
    assert.deepEqual([...new Set(permissionsAsked)], ['admin_compliance']);
});

test('no session → 401 and nothing is read; permission refused → 403 and nothing is read', async () => {
    for (const p of ['/evidence', '/evidence/chain', '/evidence/GDPR-Art32-dlp-enabled', '/evidence/file/10']) {
        const res = await fetch(`${baseUrl}/api/compliance${p}`);
        assert.equal(res.status, 401, `${p} is gated`);
    }
    denyPermission = true;
    for (const p of ['/evidence', '/evidence/chain', '/evidence/GDPR-Art32-dlp-enabled', '/evidence/file/10']) {
        const { status } = await getJson(p);
        assert.equal(status, 403, `${p} is behind admin_compliance`);
    }
    assert.deepEqual(calls.list, []);
    assert.deepEqual(calls.chain, [], 'a caller who may not see the ledger does not get a chain verdict either');
    assert.deepEqual(calls.history, []);
    assert.deepEqual(calls.byId, []);
});
