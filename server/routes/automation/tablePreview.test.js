'use strict';

/**
 * The builder's live table preview: POST /:id/table-preview.
 *
 * The operation spec and the engine are fakes (the real ones have their own
 * tests); what is proven here is everything around them: the edit role, the
 * journey check on a source run, the input cap, the shape of both answers, and
 * that a preview never writes to storage.
 *
 * Run: cd server && node --test routes/automation/tablePreview.test.js
 */

process.env.NODE_ENV = 'test';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { Readable } = require('node:stream');

const { serve } = require('../../testUtils/routeHarness');
const { makeTablePreviewRouter } = require('./tablePreview');
const { makeTableStore } = require('../../core/automationRunner/tables/tableStore');
const { tableLimits } = require('../../core/automationRunner/tables/limits');

const USERS = {
    owner: { id: 'owner', organizationId: 'org1', groups: [] },
    vic: { id: 'vic', organizationId: 'org1', groups: [] },
    eddie: { id: 'eddie', organizationId: 'org1', groups: [] },
    ron: { id: 'ron', organizationId: 'org1', groups: [] },
    stranger: { id: 'stranger', organizationId: 'org1', groups: [] },
};
const AUTOMATIONS = {
    a1: { id: 'a1', userId: 'owner', organizationId: 'org1', definition: { vars: { salt: 'synthetic-salt-value' } } },
    a2: { id: 'a2', userId: 'owner', organizationId: 'org1' },
};
const SHARES = {
    a1: [
        { principalType: 'user', principalId: 'vic', role: 'view' },
        { principalType: 'user', principalId: 'eddie', role: 'edit' },
        { principalType: 'user', principalId: 'ron', role: 'run' },
    ],
};
const RUNS = {
    r1: { id: 'r1', automationId: 'a1', userId: 'owner', startedByUserId: 'owner' },
    rCaller: { id: 'rCaller', automationId: 'a1', userId: 'owner', startedByUserId: 'ron', connectionsMode: 'caller' },
    r2: { id: 'r2', automationId: 'a2', userId: 'owner', startedByUserId: 'owner' },
};
const COLS = [{ key: 'name', label: 'Name', type: 'text' }, { key: 'score', label: 'Score', type: 'number' }];
const named = (n) => Array.from({ length: n }, (_, i) => ({ name: `row ${i}`, score: i }));

let LEDGER;
let BLOBS;
let limits;
let T;
let uploads;
let engineCalls;
let policyCalls;
let engineThrow;

const fakeStore = {
    getRun: async (id) => (RUNS[id] ? { ...RUNS[id] } : null),
    getAutomation: async (id) => (AUTOMATIONS[id] ? { ...AUTOMATIONS[id] } : null),
    getRunsInChain: async (id) => [{ ...RUNS[id] }],
    listSharesForAutomation: async (id) => SHARES[id] || [],
    getRunTableForRuns: async (id, runIds) => LEDGER.find(t => t.id === id && runIds.includes(t.runId)) || null,
    getRunTableForAutomation: async (id, a) => LEDGER.find(t => t.id === id && t.automationId === a) || null,
    countRunTablesForRun: async () => 0,
    recordRunTable: async (r) => { LEDGER.push({ ...r, expiresAt: new Date(Date.now() + r.ttlMs) }); },
};
const fakeStorage = {
    isAvailable: () => true,
    buildAutomationFileKey: (o, a, n) => `k/${o}/${a}/${n}`,
    uploadFileFromPath: async (key, path) => { BLOBS[key] = fs.readFileSync(path); },
    streamFile: async (key) => ({ stream: Readable.from([BLOBS[key]]) }),
    deleteFile: async () => {},
};
const tableStore = makeTableStore({ store: fakeStore, storage: fakeStorage, limits: () => limits, journeyRunIds: async (s) => [s.runId] });

// A spec in the contract's shape: normalise ids, report what the ops ask for.
const fakeSpec = {
    normalizeTableStep: (step) => ({
        source: step.source ?? null,
        ops: (step.ops || []).map((o, i) => ({ id: 'op' + (i + 1), enabled: true, ...o })),
        name: null,
        expiresInDays: 7,
    }),
    validateTableStep: (step) => {
        const findings = [{ code: 'table.source_required', severity: 'error', path: 'source', message: 'A source is needed.' }];
        step.ops.forEach((op, i) => {
            if (op.op === 'bad') findings.push({ code: 'table.op_invalid', severity: 'error', path: `ops[${i}].by[0]`, message: 'Pick a column.' });
            if (op.op === 'warn') findings.push({ code: 'table.note', severity: 'warning', path: `ops[${i}]`, message: 'Careful with this one.' });
        });
        return findings;
    },
};
const fakeEngine = {
    runTableOps: async (args) => {
        engineCalls.push(args);
        if (engineThrow) throw engineThrow;
        const rows = [];
        for await (const r of args.source.rows()) rows.push(r);
        return {
            columns: args.source.columns,
            rows: async function* out() { for (const r of rows) yield r; },
            opStats: args.ops.map(o => ({ opId: o.id, op: o.op, enabled: true, ok: true, inputRows: rows.length, outputRows: rows.length, columns: args.source.columns.map(c => c.key), warnings: [] })),
            segments: null,
            description: null,
            warnings: ['engine note'],
        };
    },
};
const fakePolicy = { minGroupFloorFor: async (orgId) => { policyCalls.push(orgId); return 12; } };

async function put(label, runId, automationId, rows) {
    const h = await tableStore.writeTable({ ctx: { userId: 'owner', automationId, runId, rootRunId: runId }, name: 'T', columns: COLS, rows });
    T[label] = h.tableId;
}

let api;
before(() => {
    limits = tableLimits({});
    api = serve('/', makeTablePreviewRouter({
        store: fakeStore,
        tableStore,
        spec: fakeSpec,
        engine: fakeEngine,
        groupPolicy: fakePolicy,
        runVarsFor: async (a) => ({ ...(a.definition?.vars || {}) }),
        limits: () => limits,
        getUser: async (id) => USERS[id] || null,
        hasPermission: async () => false,
    }));
});
after(async () => { await api.close(); });

beforeEach(async () => {
    limits = tableLimits({});
    LEDGER = []; BLOBS = {}; T = {}; uploads = []; engineCalls = []; policyCalls = []; engineThrow = null;
    await put('t1', 'r1', 'a1', named(30));
    await put('tA2', 'r2', 'a2', named(3));
    await put('tCaller', 'rCaller', 'a1', named(3));
});

const post = (id, body, as = 'owner') => api.call('POST', `/${id}/table-preview`, { body, user: USERS[as] });
const inline = (n = 5) => ({ rows: named(n) });

// ── access ────────────────────────────────────────────────────────────

test('the edit role is required', async () => {
    assert.strictEqual((await post('a1', { source: inline(), ops: [] }, 'owner')).status, 200);
    assert.strictEqual((await post('a1', { source: inline(), ops: [] }, 'eddie')).status, 200);
    for (const who of ['vic', 'ron']) {
        const res = await post('a1', { source: inline(), ops: [] }, who);
        assert.strictEqual(res.status, 403, who);
        assert.strictEqual(res.body.code, 'automation_forbidden');
    }
    assert.deepStrictEqual(engineCalls.length, 2);
});

test('an automation that does not exist, or that the caller has no role on, is a 404', async () => {
    assert.strictEqual((await post('nope', { source: inline(), ops: [] })).status, 404);
    assert.strictEqual((await post('a1', { source: inline(), ops: [] }, 'stranger')).status, 404);
});

test('a source run of another automation is a 404, however the table id is spelled', async () => {
    const res = await post('a1', { source: { runId: 'r2', tableId: T.tA2 }, ops: [] });
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.code, 'run_not_found');
    assert.strictEqual((await post('a1', { source: { runId: 'r1', tableId: T.tA2 }, ops: [] })).status, 404);
    assert.strictEqual((await post('a1', { source: { runId: 'nope', tableId: T.t1 }, ops: [] })).status, 404);
    assert.strictEqual(engineCalls.length, 0);
});

test('a join source is checked the same way', async () => {
    const res = await post('a1', {
        source: inline(), ops: [{ id: 'j', op: 'join' }],
        joinSources: { j: { runId: 'r2', tableId: T.tA2 } },
    });
    assert.strictEqual(res.status, 404);
    assert.strictEqual(engineCalls.length, 0);
});

test('a caller-private run\'s table cannot be previewed by somebody else', async () => {
    const res = await post('a1', { source: { runId: 'rCaller', tableId: T.tCaller }, ops: [] }, 'owner');
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.code, 'caller_run_private');
    assert.strictEqual(engineCalls.length, 0);
});

test('an unknown or malformed table id is refused', async () => {
    assert.strictEqual((await post('a1', { source: { runId: 'r1', tableId: `rtb_${'0'.repeat(32)}` }, ops: [] })).status, 404);
    assert.strictEqual((await post('a1', { source: { runId: 'r1', tableId: 'nope' }, ops: [] })).status, 400);
});

// ── the answer ────────────────────────────────────────────────────────

test('a run table is the source: the answer has the documented shape', async () => {
    const res = await post('a1', { source: { runId: 'r1', tableId: T.t1 }, ops: [{ op: 'select' }], limit: 5 });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    assert.deepStrictEqual(res.body.columns, COLS);
    assert.strictEqual(res.body.rows.length, 5);
    assert.strictEqual(res.body.rowCount, 30);
    assert.strictEqual(res.body.inputRows, 30);
    assert.strictEqual(res.body.inputCapped, false);
    assert.strictEqual(res.body.description, null);
    assert.strictEqual(res.body.segments, null);
    assert.strictEqual(res.body.opResults.length, 1);
    assert.strictEqual(res.body.opResults[0].opId, 'op1');
    assert.deepStrictEqual(res.body.warnings, ['engine note']);
});

test('the engine is called in preview mode with the limits, the floor and the run variables', async () => {
    await post('a1', { source: inline(), ops: [{ op: 'select' }], upToOpId: 'op1' });
    const call = engineCalls[0];
    assert.strictEqual(call.mode, 'preview');
    assert.strictEqual(call.upToOpId, 'op1');
    assert.strictEqual(call.minGroupFloor, 12);
    assert.deepStrictEqual(policyCalls, ['org1']);
    assert.deepStrictEqual(call.runState, { vars: { salt: 'synthetic-salt-value' } });
    assert.strictEqual(call.limits.maxRows, limits.maxRows);
    assert.strictEqual(call.ops[0].id, 'op1');
});

test('the default sample is previewRows rows and the largest is 50', async () => {
    const res = await post('a1', { source: { rows: named(80) }, ops: [] });
    assert.strictEqual(res.body.rows.length, 20);
    assert.strictEqual(res.body.rowCount, 80);
    assert.strictEqual((await post('a1', { source: { rows: named(80) }, ops: [], limit: 50 })).body.rows.length, 50);
    assert.strictEqual((await post('a1', { source: { rows: named(80) }, ops: [], limit: 51 })).status, 400);
    assert.strictEqual((await post('a1', { source: { rows: named(80) }, ops: [], limit: 0 })).status, 400);
});

test('inline rows: columns are the union of the keys, typed from the values like a run; given columns win', async () => {
    await post('a1', { source: { rows: [{ a: 1 }, { b: 2, a: 3 }] }, ops: [] });
    assert.deepStrictEqual(engineCalls[0].source.columns, [{ key: 'a', label: 'a', type: 'number' }, { key: 'b', label: 'b', type: 'number' }]);
    await post('a1', { source: { rows: [{ a: 1, hidden: 2 }], columns: [{ key: 'a', label: 'A', type: 'number' }] }, ops: [] });
    assert.deepStrictEqual(engineCalls[1].source.columns, [{ key: 'a', label: 'A', type: 'number' }]);
    const seen = [];
    for await (const r of engineCalls[1].source.rows()) seen.push(r);
    assert.deepStrictEqual(seen, [{ a: 1 }]);
});

test('inline cells that are not JSON scalars are stored as text, never passed on as objects', async () => {
    await post('a1', { source: { rows: [{ a: { nested: true }, b: [1, 2] }] }, ops: [] });
    const seen = [];
    for await (const r of engineCalls[0].source.rows()) seen.push(r);
    assert.deepStrictEqual(seen, [{ a: '{"nested":true}', b: '1; 2' }]);
});

test('list sources: rows as lists with columns, a Code step envelope and its { rows } all become tables', async () => {
    const declared = { columns: [{ key: 'name', label: 'Name', type: 'text' }, { key: 'score', label: 'Score', type: 'number' }], rows: [['a', 1], ['b', 2]] };
    const viaLists = await post('a1', { source: declared, ops: [] });
    assert.strictEqual(viaLists.status, 200);
    assert.deepStrictEqual(engineCalls[0].source.columns, declared.columns);
    const seen = [];
    for await (const r of engineCalls[0].source.rows()) seen.push(r);
    assert.deepStrictEqual(seen, [{ name: 'a', score: 1 }, { name: 'b', score: 2 }]);

    const viaEnvelope = await post('a1', { source: { result: [{ x: 'p' }, { x: 'q' }], logs: [], httpCalls: [] }, ops: [] });
    assert.strictEqual(viaEnvelope.status, 200);
    assert.deepStrictEqual(engineCalls[1].source.columns, [{ key: 'x', label: 'x', type: 'text' }]);
    assert.strictEqual(viaEnvelope.body.inputRows, 2);

    const viaEnvelopeRows = await post('a1', { source: { result: { rows: [{ y: 1 }] }, logs: [], httpCalls: [] }, ops: [] });
    assert.strictEqual(viaEnvelopeRows.status, 200);
    assert.strictEqual(engineCalls[2].source.columns[0].key, 'y');
});

test('a list source that cannot be a table is a finding on the source, not an error', async () => {
    const res = await post('a1', { source: { rows: [[1, 2]] }, ops: [] });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, false);
    assert.strictEqual(res.body.findings[0].code, 'table_source_invalid');
    assert.strictEqual(res.body.findings[0].path, 'source');
    assert.strictEqual(engineCalls.length, 0);
});

test('a join sample may be any list shape too', async () => {
    const res = await post('a1', {
        source: inline(), ops: [{ id: 'j1', op: 'join' }],
        joinSources: { j1: { result: [{ name: 'row 0', boss: 'Person One' }], logs: [], httpCalls: [] } },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
});

test('the input is capped, and inputCapped says so', async () => {
    limits = { ...limits, previewInputRows: 10 };
    const fromRows = await post('a1', { source: { rows: named(25) }, ops: [] });
    assert.strictEqual(fromRows.body.inputRows, 10);
    assert.strictEqual(fromRows.body.inputCapped, true);
    const fromRun = await post('a1', { source: { runId: 'r1', tableId: T.t1 }, ops: [] });
    assert.strictEqual(fromRun.body.inputRows, 10);
    assert.strictEqual(fromRun.body.inputCapped, true);
    const exact = await post('a1', { source: { rows: named(10) }, ops: [] });
    assert.strictEqual(exact.body.inputCapped, false);
    limits = { ...limits, previewInputRows: 0 };
    assert.strictEqual((await post('a1', { source: { runId: 'r1', tableId: T.t1 }, ops: [] })).body.inputRows, 30);
});

test('a join takes its sample from joinSources, by operation id', async () => {
    let asked;
    const joined = makeTablePreviewRouter({
        store: fakeStore, tableStore, spec: fakeSpec, groupPolicy: fakePolicy, runVarsFor: async () => ({}), limits: () => limits,
        getUser: async (id) => USERS[id] || null, hasPermission: async () => false,
        engine: { runTableOps: async (args) => {
            asked = await args.resolveTable({ some: 'binding' }, 'j1');
            const lone = await args.resolveTable([{ k: 1 }], 'other');
            return { columns: [], rows: async function* r() { yield lone; }, opStats: [], warnings: [], segments: null, description: null };
        } },
    });
    const own = serve('/', joined);
    try {
        const res = await own.call('POST', '/a1/table-preview', {
            user: USERS.owner,
            body: { source: inline(), ops: [{ id: 'j1', op: 'join' }], joinSources: { j1: { runId: 'r1', tableId: T.t1 } } },
        });
        assert.strictEqual(res.status, 200, res.text);
        assert.deepStrictEqual(asked.columns, COLS);
        assert.strictEqual(asked.rows.length, 30);
        assert.strictEqual(res.body.rows[0].rows.length, 1);
    } finally {
        await own.close();
    }
});

test('two joins in one step each get their own sample; a lone source never stands in for the second', async () => {
    const seen = [];
    const joined = makeTablePreviewRouter({
        store: fakeStore, tableStore, spec: fakeSpec, groupPolicy: fakePolicy, runVarsFor: async () => ({}), limits: () => limits,
        getUser: async (id) => USERS[id] || null, hasPermission: async () => false,
        engine: { runTableOps: async (args) => {
            seen.push(await args.resolveTable({ some: 'binding' }, 'j1'));
            try { seen.push(await args.resolveTable({ some: 'binding' }, 'j2')); } catch (e) { seen.push(e.errorClass); }
            seen.push(await args.resolveTable([{ k: 1 }], 'j2'));
            return { columns: [], rows: async function* r() { /* none */ }, opStats: [], warnings: [], segments: null, description: null };
        } },
    });
    const own = serve('/', joined);
    try {
        const res = await own.call('POST', '/a1/table-preview', {
            user: USERS.owner,
            body: { source: inline(), ops: [{ id: 'j1', op: 'join' }, { id: 'j2', op: 'join' }], joinSources: { j1: { runId: 'r1', tableId: T.t1 } } },
        });
        assert.strictEqual(res.status, 200, res.text);
        assert.strictEqual(seen[0].rows.length, 30);
        assert.strictEqual(seen[1], 'table_op_invalid');
        assert.strictEqual(seen[2].rows.length, 1);
    } finally {
        await own.close();
    }
});

// ── findings and errors ───────────────────────────────────────────────

test('error findings from the spec answer ok:false and never reach the engine', async () => {
    const res = await post('a1', { source: inline(), ops: [{ op: 'select' }, { op: 'bad' }] });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, false);
    assert.deepStrictEqual(res.body.findings, [{ code: 'table.op_invalid', severity: 'error', path: 'ops[1].by[0]', message: 'Pick a column.' }]);
    assert.deepStrictEqual(res.body.opResults, []);
    assert.strictEqual(engineCalls.length, 0);
});

test('a finding about the missing step-level source is not a finding here', async () => {
    const res = await post('a1', { source: inline(), ops: [] });
    assert.strictEqual(res.body.ok, true);
});

test('warning findings travel as warnings', async () => {
    const res = await post('a1', { source: inline(), ops: [{ op: 'warn' }] });
    assert.strictEqual(res.body.ok, true);
    assert.deepStrictEqual(res.body.warnings, ['engine note', 'Careful with this one.']);
});

test('an engine error with an errorClass becomes a finding on the operation', async () => {
    engineThrow = Object.assign(new Error('No column called "x".'), { errorClass: 'table_op_invalid', opId: 'op2', field: 'by[0]', hint: 'Check the spelling.' });
    const res = await post('a1', { source: inline(), ops: [{ op: 'select' }, { op: 'group' }] });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, false);
    assert.deepStrictEqual(res.body.findings, [{ code: 'table_op_invalid', severity: 'error', path: 'ops[1].by[0]', message: 'No column called "x".', hint: 'Check the spelling.' }]);
    assert.deepStrictEqual(res.body.opResults, []);
});

test('an engine error without an errorClass is a server error, not a finding', async () => {
    engineThrow = new Error('boom with row values');
    const res = await post('a1', { source: inline(), ops: [] });
    assert.strictEqual(res.status, 500);
    assert.ok(!res.text.includes('boom'));
});

test('more operations than maxOps is a finding, and 0 lifts the cap', async () => {
    limits = { ...limits, maxOps: 2 };
    const ops = [{ op: 'select' }, { op: 'select' }, { op: 'select' }];
    const res = await post('a1', { source: inline(), ops });
    assert.strictEqual(res.body.ok, false);
    assert.strictEqual(res.body.findings[0].code, 'table.too_many_ops');
    limits = { ...limits, maxOps: 0 };
    assert.strictEqual((await post('a1', { source: inline(), ops })).body.ok, true);
});

// ── the request ───────────────────────────────────────────────────────

test('the body is strict', async () => {
    for (const body of [
        { source: inline(), ops: [], extra: 1 },
        { source: { rows: [], extra: 1 }, ops: [] },
        { source: inline() },
        { ops: [] },
        { source: { runId: 'r1' }, ops: [] },
        { source: inline(), ops: 'x' },
    ]) {
        const res = await post('a1', body);
        assert.strictEqual(res.status, 400, JSON.stringify(body));
        assert.strictEqual(res.body.code, 'invalid_request');
    }
    assert.strictEqual(engineCalls.length, 0);
});

// ── side effects ──────────────────────────────────────────────────────

test('a preview never writes to storage or the ledger', async () => {
    const before = { ledger: LEDGER.length, blobs: Object.keys(BLOBS).length };
    const throwing = {
        ...fakeStorage,
        uploadFileFromPath: async () => { uploads.push('upload'); throw new Error('a preview must not upload'); },
        deleteFile: async () => { uploads.push('delete'); throw new Error('a preview must not delete'); },
    };
    const guardedStore = { ...fakeStore, recordRunTable: async () => { uploads.push('record'); throw new Error('a preview must not record'); } };
    const own = serve('/', makeTablePreviewRouter({
        store: guardedStore,
        tableStore: makeTableStore({ store: guardedStore, storage: throwing, limits: () => limits, journeyRunIds: async (s) => [s.runId] }),
        spec: fakeSpec, engine: fakeEngine, groupPolicy: fakePolicy, runVarsFor: async () => ({}), limits: () => limits,
        getUser: async (id) => USERS[id] || null, hasPermission: async () => false,
    }));
    try {
        const res = await own.call('POST', '/a1/table-preview', {
            user: USERS.owner,
            body: { source: { runId: 'r1', tableId: T.t1 }, ops: [{ op: 'select' }], joinSources: { op1: inline(2) } },
        });
        assert.strictEqual(res.status, 200, res.text);
        assert.deepStrictEqual(uploads, []);
        assert.deepStrictEqual(before, { ledger: LEDGER.length, blobs: Object.keys(BLOBS).length });
    } finally {
        await own.close();
    }
});

test('the preview is rate limited per user, and 0 turns the limit off', async () => {
    limits = { ...limits, previewRpm: 2 };
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await post('a1', { source: inline(), ops: [] }, 'eddie')).status);
    assert.deepStrictEqual(statuses, [200, 200, 429, 429]);
    limits = { ...limits, previewRpm: 0 };
    for (let i = 0; i < 4; i++) assert.strictEqual((await post('a1', { source: inline(), ops: [] }, 'eddie')).status, 200);
});
