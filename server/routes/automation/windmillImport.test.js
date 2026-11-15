/**
 * The Windmill import routes (routes/automation/windmillImport.mts) as a client
 * meets them: a real Express app with the real licence gate, the real upload
 * guard, the real body schemas and the terminal error handler. What needs the
 * database (the commit, the stored reports) is a double here; the commit
 * itself is proven on PGlite in usecases/automation/windmillImport.pg.test.js.
 *
 *   - the importing routes need the `automation_import` licence feature
 *     (Enterprise): a community caller gets 403 feature_locked;
 *   - the report and its acknowledgement are the drain exemption: after a
 *     lapse the drafts already imported can still be read and finished;
 *   - an upload preview converts and writes nothing;
 *   - source W: the token goes out in the Authorization header only, never
 *     comes back in an answer or an error; a refused token, an http:// address
 *     and an unreachable host each get their own fixed sentence;
 *   - the report and its acknowledgement need the automation's access, and an
 *     automation that was not imported has no report.
 *
 * Run: cd server && node --test routes/automation/windmillImport.test.js
 */

'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('node:http');
const path = require('node:path');
const { readFileSync } = require('node:fs');

const license = require('../../license');
const { buildKey } = require('../../utils/buildInfo');
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');
const { registerWindmillImportRoutes } = require('./windmillImport.mts');
const { inputOf } = require('../../automation/importers/windmill/goldenFixtures.mjs');

const FIXTURES = path.join(__dirname, '..', '..', 'automation', 'importers', 'windmill', 'fixtures');
const TOKEN = 'wm-test-token-not-a-secret-1234';
const LIMITS = { maxBytes: 0, maxUnzippedBytes: 0, maxEntries: 0, maxFlows: 0, rpm: 0, briefPerItemChars: 6000, briefTotalChars: 40000 };

let rows = {};
const acks = [];
let fetchCalls = [];
let fetchAnswer = async () => { throw new Error('no answer set'); };
const automation = { id: 'a-imported', version: 3, definition: { steps: [{ id: 'p1', type: 'stop_error', label: 'Windmill: x' }] } };

let server; let baseUrl;
before(async () => {
    const router = express.Router();
    registerWindmillImportRoutes(router, {
        limits: () => LIMITS,
        store: {
            getImportForAutomation: async (id) => rows[id] || null,
            acknowledgeImportItems: async (id, ids) => { acks.push([id, ids]); return { ...rows[id], acknowledged: ids }; },
        },
        load: async (req, res) => {
            if (req.params.id === 'a-elsewhere') { res.status(404).json({ error: 'Not found' }); return null; }
            return { ...automation, id: req.params.id };
        },
        fetchImpl: async (url, init) => { fetchCalls.push({ url, init }); return fetchAnswer(url, init); },
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        const tier = req.get('x-tier') || 'enterprise';
        const userId = 'u1';
        req.session = {
            isAuthenticated: true,
            user: { id: userId, organizationId: null },
            [buildKey(`_lic:${userId}:v${license.getServerLicenseVersion()}`)]: {
                expiresAt: Date.now() + 60_000,
                value: { tier, orgIds: [], userTier: tier, orgTiers: {}, spread: null },
            },
        };
        next();
    });
    app.use('/api/automation', router);
    app.use(terminalErrorHandler);
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { if (server) await new Promise((r) => server.close(r)); });
beforeEach(() => { rows = {}; acks.length = 0; fetchCalls = []; });

async function call(method, p, { body, form, tier } = {}) {
    const headers = { ...(tier ? { 'x-tier': tier } : {}) };
    let payload;
    if (form) payload = form;
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(`${baseUrl}/api/automation${p}`, { method, headers, body: payload });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text };
}

function uploadForm(name, type, mode = 'preview', select) {
    const form = new FormData();
    form.append('mode', mode);
    if (select) form.append('select', JSON.stringify(select));
    form.append('file', new Blob([readFileSync(path.join(FIXTURES, name))], { type }), name);
    return form;
}

const remoteBody = (over = {}) => ({ source: 'windmill_api', baseUrl: 'https://windmill.example.com', workspace: 'main', token: TOKEN, mode: 'preview', ...over });

test('a community caller is refused on the importing routes with feature_locked', async () => {
    const answers = [
        await call('POST', '/import/windmill/upload', { form: uploadForm('expense-claim.flow.json', 'application/json'), tier: 'community' }),
        await call('POST', '/import/windmill/remote', { body: remoteBody(), tier: 'community' }),
    ];
    for (const a of answers) {
        assert.strictEqual(a.status, 403, a.text);
        assert.strictEqual(a.body.error, 'feature_locked');
    }
    assert.strictEqual(fetchCalls.length, 0, 'nothing was fetched for an unlicensed caller');
});

test('drain exemption: after a lapse the report of an imported draft can still be read and its items acknowledged', async () => {
    rows['a-imported'] = { automationId: 'a-imported', acknowledged: [], dryRunVersion: null, clearedAt: null, report: { aiChecklist: [{ wmId: 'p1', stepId: 'p1', placeholder: true, title: 'Convert p1' }] } };
    const read = await call('GET', '/a-imported/import-report', { tier: 'community' });
    assert.strictEqual(read.status, 200, read.text);
    assert.deepStrictEqual(read.body.gate.open.map((o) => o.wmId), ['p1']);
    const ack = await call('POST', '/a-imported/import-report/acknowledge', { body: { wmIds: ['p1'] }, tier: 'community' });
    assert.strictEqual(ack.status, 200, ack.text);
    assert.deepStrictEqual(acks, [['a-imported', ['p1']]]);
    // The automation's own access check still holds.
    assert.strictEqual((await call('GET', '/a-elsewhere/import-report', { tier: 'community' })).status, 404);
});

test('an upload preview converts the flow and writes nothing', async () => {
    const { status, body, text } = await call('POST', '/import/windmill/upload', { form: uploadForm('expense-claim.flow.json', 'application/json') });
    assert.strictEqual(status, 200, text);
    assert.strictEqual(body.mode, 'preview');
    assert.strictEqual(body.flows.length, 1);
    const flow = body.flows[0];
    assert.ok(flow.aiChecklist.length > 0);
    assert.strictEqual(flow.confidence, 'low');
    assert.ok(flow.warnings.some((w) => w.code === 'trigger_switch_off'), 'the duplicate-run warning is there');
    assert.ok(flow.warnings.some((w) => w.code === 'identity_change'));
    assert.strictEqual(body.results, undefined, 'a preview commits nothing');
});

test('the upload refuses a bad mode, a broken select and a file whose bytes lie about their type', async () => {
    assert.strictEqual((await call('POST', '/import/windmill/upload', { form: uploadForm('expense-claim.flow.json', 'application/json', 'nope') })).status, 400);
    const badSelect = uploadForm('expense-claim.flow.json', 'application/json', 'preview');
    badSelect.set('select', '{"not":"a list"}');
    assert.strictEqual((await call('POST', '/import/windmill/upload', { form: badSelect })).status, 400);
    const zipThatIsText = uploadForm('expense-claim.flow.json', 'application/zip');
    assert.strictEqual((await call('POST', '/import/windmill/upload', { form: zipThatIsText })).status, 415);
    const exe = uploadForm('expense-claim.flow.json', 'application/x-msdownload');
    assert.strictEqual((await call('POST', '/import/windmill/upload', { form: exe })).status, 415);
});

test('source W: the archive is read with the token in the header only, and the answer never carries it', async () => {
    const zip = (await inputOf('native-trigger-bundle')).data;
    fetchAnswer = async () => new Response(zip, { status: 200, headers: { 'content-type': 'application/zip' } });
    const { status, body, text } = await call('POST', '/import/windmill/remote', { body: remoteBody() });
    assert.strictEqual(status, 200, text);
    assert.ok(body.flows.length > 0);
    assert.strictEqual(fetchCalls.length, 1);
    assert.ok(fetchCalls[0].url.startsWith('https://windmill.example.com/api/w/main/workspaces/tarball?'));
    assert.ok(fetchCalls[0].url.includes('skip_secrets=true'));
    assert.ok(!fetchCalls[0].url.includes(TOKEN), 'the token is not in the URL');
    assert.strictEqual(fetchCalls[0].init.headers.authorization, `Bearer ${TOKEN}`);
    assert.ok(!text.includes(TOKEN), 'the token is not in the answer');
});

test('source W: refusals are fixed sentences without the token or the upstream body', async () => {
    fetchAnswer = async () => new Response(`denied for ${TOKEN}`, { status: 401 });
    const refused = await call('POST', '/import/windmill/remote', { body: remoteBody() });
    assert.strictEqual(refused.status, 400);
    assert.strictEqual(refused.body.code, 'import.windmill.unauthorized');
    assert.ok(!refused.text.includes(TOKEN) && !refused.text.includes('denied'));

    fetchAnswer = async () => { throw new Error(`connect ECONNREFUSED ${TOKEN}`); };
    const down = await call('POST', '/import/windmill/remote', { body: remoteBody() });
    assert.strictEqual(down.status, 502);
    assert.strictEqual(down.body.code, 'import.windmill.unreachable');
    assert.ok(!down.text.includes(TOKEN) && !down.text.includes('ECONNREFUSED'));

    fetchAnswer = async () => new Response('<html>not windmill</html>', { status: 200 });
    const other = await call('POST', '/import/windmill/remote', { body: remoteBody() });
    assert.strictEqual(other.status, 502);
    assert.strictEqual(other.body.code, 'import.windmill.not_windmill');
    assert.ok(!other.text.includes('html'));
});

test('source W: the address and the body are checked before anything goes out', async () => {
    const before = fetchCalls.length;
    const plain = await call('POST', '/import/windmill/remote', { body: remoteBody({ baseUrl: 'http://windmill.example.com' }) });
    assert.strictEqual(plain.status, 400);
    assert.strictEqual(plain.body.code, 'import.windmill.invalid_address');
    const creds = await call('POST', '/import/windmill/remote', { body: remoteBody({ baseUrl: 'https://user:pw@windmill.example.com' }) });
    assert.strictEqual(creds.body.code, 'import.windmill.invalid_address');
    const ws = await call('POST', '/import/windmill/remote', { body: remoteBody({ workspace: '../admins' }) });
    assert.strictEqual(ws.body.code, 'import.windmill.invalid_workspace');
    const noToken = await call('POST', '/import/windmill/remote', { body: remoteBody({ token: '' }) });
    assert.strictEqual(noToken.status, 400);
    const extra = await call('POST', '/import/windmill/remote', { body: { ...remoteBody(), stored: true } });
    assert.strictEqual(extra.status, 400, 'unknown fields are refused');
    assert.ok(!noToken.text.includes(TOKEN) && !extra.text.includes(TOKEN), 'a schema refusal does not echo the token');
    assert.strictEqual(fetchCalls.length, before, 'nothing went out');
});

test('source W: the comparison is offered while AUTOMATION_IMPORT_WINDMILL_COMPARE_RUNS is above 0, and 0 switches it off', async () => {
    const zip = (await inputOf('native-trigger-bundle')).data;
    fetchAnswer = async () => new Response(zip, { status: 200, headers: { 'content-type': 'application/zip' } });
    const saved = process.env.AUTOMATION_IMPORT_WINDMILL_COMPARE_RUNS;
    try {
        delete process.env.AUTOMATION_IMPORT_WINDMILL_COMPARE_RUNS;
        const on = await call('POST', '/import/windmill/remote', { body: remoteBody({ compare: { saveAsTests: true } }) });
        assert.strictEqual(on.status, 200, on.text);
        assert.deepStrictEqual(on.body.compare, { runs: 5 }, 'the default is the last 5 runs');
        process.env.AUTOMATION_IMPORT_WINDMILL_COMPARE_RUNS = '0';
        const before = fetchCalls.length;
        const off = await call('POST', '/import/windmill/remote', { body: remoteBody({ compare: {} }) });
        assert.strictEqual(off.status, 200, off.text);
        assert.strictEqual(off.body.compare, undefined, 'nothing to offer');
        assert.strictEqual(fetchCalls.length - before, 1, 'only the archive was read');
        const upload = await call('POST', '/import/windmill/upload', { form: uploadForm('expense-claim.flow.json', 'application/json') });
        assert.strictEqual(upload.body.compare, undefined, 'an uploaded export has no runs to compare');
    } finally {
        if (saved === undefined) delete process.env.AUTOMATION_IMPORT_WINDMILL_COMPARE_RUNS; else process.env.AUTOMATION_IMPORT_WINDMILL_COMPARE_RUNS = saved;
    }
    const bad = await call('POST', '/import/windmill/remote', { body: remoteBody({ compare: { saveAsTests: 'yes' } }) });
    assert.strictEqual(bad.status, 400, 'compare.saveAsTests is a boolean');
    const extra = await call('POST', '/import/windmill/remote', { body: remoteBody({ compare: { runs: 99 } }) });
    assert.strictEqual(extra.status, 400, 'the number of runs is the server\'s to set');
});

const ROW = {
    id: 'r1', orgId: null, userId: 'u1', automationId: 'a-imported', sourceKind: 'windmill_upload',
    windmillPath: 'f/x/flow', windmillGeneration: 'standalone', acknowledged: [], dryRunOkAt: null, dryRunVersion: null, clearedAt: null, createdAt: null,
    report: {
        title: 'Flow', flowPath: 'f/x/flow', counts: { mapped: 2 }, warnings: [], connections: [],
        aiChecklist: [
            { wmId: 'p1', stepId: 'p1', placeholder: true, title: 'Convert p1', why: 'Python', language: 'python3', source: 'print(1)' },
            { wmId: 'preprocessor', stepId: null, title: 'Reshape', why: 'x' },
        ],
    },
};

test('the report: the gate state, no source in the list, the briefing with it', async () => {
    rows['a-imported'] = ROW;
    const { status, body } = await call('GET', '/a-imported/import-report');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.gate.applies, true);
    assert.deepStrictEqual(body.gate.open.map((o) => o.wmId), ['p1', 'preprocessor']);
    assert.strictEqual(body.gate.dryRunRequired, true);
    assert.strictEqual(body.report.aiChecklist[0].source, undefined);
    assert.match(body.brief, /print\(1\)/, 'the briefing carries the scrubbed source');

    const none = await call('GET', '/a-other/import-report');
    assert.strictEqual(none.status, 404);
    assert.strictEqual(none.body.code, 'import.report_missing');
    assert.strictEqual((await call('GET', '/a-elsewhere/import-report')).status, 404);
});

test('acknowledging: only items on the checklist, and the answer is the new state', async () => {
    rows['a-imported'] = ROW;
    const unknown = await call('POST', '/a-imported/import-report/acknowledge', { body: { wmIds: ['nope'] } });
    assert.strictEqual(unknown.status, 400);
    assert.strictEqual(acks.length, 0);
    const ok = await call('POST', '/a-imported/import-report/acknowledge', { body: { wmIds: ['preprocessor', 'nope'] } });
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(acks, [['a-imported', ['preprocessor']]]);
    assert.deepStrictEqual(ok.body.gate.open.map((o) => o.wmId), ['p1']);
    assert.strictEqual((await call('POST', '/a-imported/import-report/acknowledge', { body: { wmIds: [] } })).status, 400);
});
