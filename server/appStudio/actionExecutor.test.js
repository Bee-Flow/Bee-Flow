/**
 * App Studio v2 — action executor (server data-mutation steps).
 *
 * Exercises executeDataStep with the real queryCompiler + rlsGateway + shared
 * expr engine, but stubbed stores (studioAppDbStore / studioAppDataStore /
 * automationStore / automationRunner) via the require-cache trick — no SQLite,
 * no Postgres, no runner graph.
 *
 * Run: cd server && node --test appStudio/actionExecutor.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

// ── Require-cache stubs (before the executor loads) ────────────────────────
function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const execCalls = [];
let execResult = { changes: 1, lastInsertRowid: 0 };
const bumpCalls = [];
const rowBumps = [];
let rowCountsState = {};   // studioAppQuota.assertRowQuota reads this
let dbSizeState = 0;       // studioAppQuota.assertDbByteQuota reads this
const automations = new Map();
const runnerCalls = [];
let runnerImpl = async () => ({ id: 'run-1', status: 'success', output: { ok: true }, error: null });

stub('../stores/studioAppDbStore', {
    exec: async (ownerId, appId, sql, params) => {
        execCalls.push({ ownerId, appId, sql, params });
        return execResult;
    },
    sizeBytes: async () => dbSizeState,
});
const attachments = new Map(); // fileId → ledger row (app-trigger file inputs)
stub('../stores/studioAppDataStore', {
    bumpDataVersion: async (appId, tableKey, ownerId) => { bumpCalls.push({ appId, tableKey, ownerId }); return 1; },
    bumpRowCount: async (appId, tableKey, delta, ownerId) => { rowBumps.push({ appId, tableKey, delta, ownerId }); return {}; },
    getRowCounts: async () => rowCountsState,
    // rlsGateway.resolveViewerRole references getMemberRole (not used here).
    getMemberRole: async () => null,
    // Owner-scoped like the real store: wrong app/owner resolves null.
    getAttachment: async (id, appId, ownerId) => {
        const a = attachments.get(id);
        return (a && a.appId === appId && a.ownerUserId === ownerId) ? a : null;
    },
});
stub('../stores/storageStore', {
    buildStudioAppAttachmentKey: (ownerId, appId, sha256) => `studio-apps/${ownerId}/${appId}/attachments/${sha256}`,
});
const tmpUrlCalls = [];
stub('../utils/tempDownloadUrl', {
    generateTempDownloadUrl: (key, ttl) => { tmpUrlCalls.push({ key, ttl }); return `https://host/api/storage/tmp/tok?key=${encodeURIComponent(key)}`; },
});
stub('../stores/automationStore', {
    getAutomation: async (id) => automations.get(id) || null,
    getRunSteps: async () => [],
});
stub('../core/automationRunner', {
    executeAutomation: async (automation, opts) => { runnerCalls.push({ automation, opts }); return runnerImpl(automation, opts); },
});

const actionExecutor = require('./actionExecutor');
const { DATA_LIMITS } = require('./dataModel');

// ── Fixtures ────────────────────────────────────────────────────────────────
const OWNER = 'owner-1';
const app = { id: 'app-1', userId: OWNER, organizationId: 'org-1' };

function tableWith(access) {
    return {
        id: 'tbl_aaa111', key: 'tasks', name: 'Tasks',
        fields: [
            { id: 'fld_t', key: 'title', type: 'text' },
            { id: 'fld_d', key: 'done', type: 'bool' },
            { id: 'fld_s', key: 'score', type: 'number', subtype: 'integer' },
        ],
        access: access || { default: 'app', roles: {}, rowFilters: {} },
    };
}
function modelWith(table) {
    return { modelVersion: 1, tables: [table], roles: [], roleMapping: { default: 'app', byGroup: {} } };
}

function ownerCtx(extra = {}) {
    return { viewerId: OWNER, role: 'owner', orgId: 'org-1', formValues: {}, vars: {}, viewer: { id: OWNER }, ...extra };
}

test.beforeEach(() => {
    execCalls.length = 0;
    bumpCalls.length = 0;
    rowBumps.length = 0;
    rowCountsState = {};
    dbSizeState = 0;
    runnerCalls.length = 0;
    tmpUrlCalls.length = 0;
    execResult = { changes: 1, lastInsertRowid: 0 };
    runnerImpl = async () => ({ id: 'run-1', status: 'success', output: { ok: true }, error: null });
    automations.clear();
    attachments.clear();
});

// ── create_record ────────────────────────────────────────────────────────────

test('create_record: stamps system columns, runs acts-as-owner, bumps version', async () => {
    const table = tableWith();
    const step = { kind: 'create_record', tableId: 'tbl_aaa111', values: { title: { kind: 'static', value: 'Hi' } } };
    const r = await actionExecutor.executeDataStep(app, modelWith(table), step, ownerCtx());

    assert.strictEqual(r.ok, true);
    assert.ok(r.result.id.startsWith('rec_'), 'a fresh record id is returned');
    assert.strictEqual(execCalls.length, 1);
    const call = execCalls[0];
    assert.strictEqual(call.ownerId, OWNER, 'exec runs under the app owner');
    assert.strictEqual(call.appId, app.id);
    assert.match(call.sql, /INSERT INTO "tasks"/);
    // created_by / org_id are stamped from the ctx (positions 4,5 after id, ts, ts).
    assert.strictEqual(call.params[3], OWNER, 'created_by stamped server-side');
    assert.strictEqual(call.params[4], 'org-1', 'org_id stamped server-side');
    assert.ok(call.params.includes('Hi'));
    assert.deepStrictEqual(bumpCalls[0], { appId: app.id, tableKey: 'tasks', ownerId: OWNER });
});

test('create_record: formulas are RE-EVALUATED server-side (client-computed values never trusted)', async () => {
    const table = tableWith();
    // The author bound `score` to a formula over form inputs. Even if a client
    // tried to pre-compute it, only the authored expr + formValues drive it.
    const step = {
        kind: 'create_record', tableId: 'tbl_aaa111',
        values: { score: { kind: 'formula', expr: 'form.a * form.b' } },
    };
    const ctx = ownerCtx({ formValues: { a: 6, b: 7 } });
    const r = await actionExecutor.executeDataStep(app, modelWith(table), step, ctx);

    assert.strictEqual(r.ok, true);
    assert.ok(execCalls[0].params.includes(42), 'score computed server-side to 42');
});

test('create_record: a field mapping pulls from formValues', async () => {
    const table = tableWith();
    const step = { kind: 'create_record', tableId: 'tbl_aaa111', values: { title: { kind: 'field', name: 'subject' } } };
    const r = await actionExecutor.executeDataStep(app, modelWith(table), step, ownerCtx({ formValues: { subject: 'From form' } }));
    assert.strictEqual(r.ok, true);
    assert.ok(execCalls[0].params.includes('From form'));
});

test('create_record: an unknown field is rejected (422) and nothing is written', async () => {
    const table = tableWith();
    const step = { kind: 'create_record', tableId: 'tbl_aaa111', values: { nope: { kind: 'static', value: 'x' } } };
    const r = await actionExecutor.executeDataStep(app, modelWith(table), step, ownerCtx());
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /unknown field/i);
    assert.strictEqual(execCalls.length, 0);
});

test('create_record: a role without create permission is forbidden (403), nothing written', async () => {
    const table = tableWith({ default: 'none', roles: {}, rowFilters: {} });
    const step = { kind: 'create_record', tableId: 'tbl_aaa111', values: { title: { kind: 'static', value: 'x' } } };
    const ctx = ownerCtx({ viewerId: 'viewer-2', role: 'member' });
    const r = await actionExecutor.executeDataStep(app, modelWith(table), step, ctx);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /permission/i);
    assert.strictEqual(execCalls.length, 0);
});

// ── Quotas through the writeRecord choke point ────────────────────────────────

test('create_record: bumps the table row count (+1) after the insert', async () => {
    const step = { kind: 'create_record', tableId: 'tbl_aaa111', values: { title: { kind: 'static', value: 'x' } } };
    const r = await actionExecutor.executeDataStep(app, modelWith(tableWith()), step, ownerCtx());
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(rowBumps, [{ appId: app.id, tableKey: 'tasks', delta: 1, ownerId: OWNER }]);
});

test('create_record at the per-table row cap → step error code quota_exceeded, nothing written', async () => {
    rowCountsState = { tasks: DATA_LIMITS.MAX_ROWS_PER_TABLE };
    const step = { kind: 'create_record', tableId: 'tbl_aaa111', values: { title: { kind: 'static', value: 'x' } } };
    const r = await actionExecutor.executeDataStep(app, modelWith(tableWith()), step, ownerCtx());
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'quota_exceeded');
    assert.strictEqual(r.limit, DATA_LIMITS.MAX_ROWS_PER_TABLE);
    assert.strictEqual(r.used, DATA_LIMITS.MAX_ROWS_PER_TABLE);
    assert.strictEqual(execCalls.length, 0, 'no insert at the cap');
    assert.strictEqual(rowBumps.length, 0);
});

test('update_record at the DB byte cap → quota_exceeded, nothing written', async () => {
    dbSizeState = DATA_LIMITS.MAX_DB_BYTES;
    const step = {
        kind: 'update_record', tableId: 'tbl_aaa111',
        recordId: { kind: 'static', value: 'rec_x' },
        values: { title: { kind: 'static', value: 'edited' } },
    };
    const r = await actionExecutor.executeDataStep(app, modelWith(tableWith()), step, ownerCtx());
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'quota_exceeded');
    assert.strictEqual(r.limit, DATA_LIMITS.MAX_DB_BYTES);
    assert.strictEqual(execCalls.length, 0);
});

test('delete_record still succeeds at every cap and bumps the row count (-1)', async () => {
    rowCountsState = { tasks: DATA_LIMITS.MAX_ROWS_PER_TABLE };
    dbSizeState = DATA_LIMITS.MAX_DB_BYTES;
    execResult = { changes: 1 };
    const step = { kind: 'delete_record', tableId: 'tbl_aaa111', recordId: { kind: 'static', value: 'rec_1' } };
    const r = await actionExecutor.executeDataStep(app, modelWith(tableWith()), step, ownerCtx());
    assert.strictEqual(r.ok, true, 'deletes are quota-free (the escape hatch)');
    assert.deepStrictEqual(rowBumps, [{ appId: app.id, tableKey: 'tasks', delta: -1, ownerId: OWNER }]);
});

test('writeRecord: a quota failure propagates the frozen 409 shape to direct callers', async () => {
    rowCountsState = { other: DATA_LIMITS.MAX_ROWS_PER_APP }; // app-wide cap via another table
    const table = tableWith();
    await assert.rejects(
        () => actionExecutor.writeRecord(app, modelWith(table), table, { title: 'x' }, { viewer: { id: OWNER, role: 'owner' } }),
        (e) => e.status === 409 && e.code === 'quota_exceeded'
            && e.limit === DATA_LIMITS.MAX_ROWS_PER_APP && e.used === DATA_LIMITS.MAX_ROWS_PER_APP,
    );
    assert.strictEqual(execCalls.length, 0);
});

// ── update_record (RLS-scoped) ────────────────────────────────────────────────

test('update_record: access filter is ANDed in; 0 rows changed reads back as "not found"', async () => {
    // 'owner' access mode → non-owner viewers get an 'own' scope (created_by = ?).
    const table = tableWith({ default: 'owner', roles: {}, rowFilters: {} });
    execResult = { changes: 0 }; // the row exists but isn't the viewer's → 0 rows
    const step = {
        kind: 'update_record', tableId: 'tbl_aaa111',
        recordId: { kind: 'static', value: 'rec_x' },
        values: { title: { kind: 'static', value: 'edited' } },
    };
    const ctx = ownerCtx({ viewerId: 'viewer-2', role: 'member' });
    const r = await actionExecutor.executeDataStep(app, modelWith(table), step, ctx);

    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'Record not found', 'forbidden and missing are indistinguishable');
    assert.strictEqual(execCalls.length, 1, 'the scoped UPDATE ran but changed nothing');
    assert.match(execCalls[0].sql, /created_by/i, 'the own-scope predicate is in the WHERE');
    assert.strictEqual(bumpCalls.length, 0, 'no version bump on a no-op update');
});

test('update_record: an owner update that changes a row succeeds and bumps version', async () => {
    const table = tableWith();
    execResult = { changes: 1 };
    const step = {
        kind: 'update_record', tableId: 'tbl_aaa111',
        recordId: { kind: 'static', value: 'rec_x' },
        values: { done: { kind: 'static', value: true } },
    };
    const r = await actionExecutor.executeDataStep(app, modelWith(table), step, ownerCtx());
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.result.id, 'rec_x');
    assert.strictEqual(bumpCalls.length, 1);
    // bool coerced to 1 by the compiler.
    assert.ok(execCalls[0].params.includes(1));
});

test('update_record: a missing recordId is "not found", nothing written', async () => {
    const table = tableWith();
    const step = { kind: 'update_record', tableId: 'tbl_aaa111', recordId: { kind: 'static', value: null }, values: {} };
    const r = await actionExecutor.executeDataStep(app, modelWith(table), step, ownerCtx());
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'Record not found');
    assert.strictEqual(execCalls.length, 0);
});

// ── delete_record ─────────────────────────────────────────────────────────────

test('delete_record: scoped DELETE; 0 rows → "not found"', async () => {
    const table = tableWith();
    execResult = { changes: 0 };
    const step = { kind: 'delete_record', tableId: 'tbl_aaa111', recordId: { kind: 'static', value: 'rec_gone' } };
    const r = await actionExecutor.executeDataStep(app, modelWith(table), step, ownerCtx());
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'Record not found');
    assert.match(execCalls[0].sql, /DELETE FROM "tasks"/);
});

test('delete_record: a real delete succeeds and bumps version', async () => {
    const table = tableWith();
    execResult = { changes: 1 };
    const step = { kind: 'delete_record', tableId: 'tbl_aaa111', recordId: { kind: 'static', value: 'rec_1' } };
    const r = await actionExecutor.executeDataStep(app, modelWith(table), step, ownerCtx());
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.result.deleted, true);
    assert.strictEqual(bumpCalls.length, 1);
});

test('delete_record: the access filter sees the viewer ROLE, like create/update', async () => {
    // The run route sends viewer:{id} with the role alongside; a row rule keyed
    // on viewer.role must still bind the real role, not null.
    const table = tableWith({ default: 'app', roles: {}, rowFilters: { member: 'record.title == viewer.role' } });
    execResult = { changes: 1 };
    const step = { kind: 'delete_record', tableId: 'tbl_aaa111', recordId: { kind: 'static', value: 'rec_1' } };
    const ctx = ownerCtx({ viewerId: 'viewer-2', role: 'member', viewer: { id: 'viewer-2' } });
    const r = await actionExecutor.executeDataStep(app, modelWith(table), step, ctx);

    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(execCalls[0].params, ['rec_1', 'member'], 'viewer.role bound into the DELETE predicate');
});

// ── run_automation (owner-scoped) ─────────────────────────────────────────────

test('run_automation: owner-owned automation runs acts-as-owner and returns output', async () => {
    automations.set('auto-1', { id: 'auto-1', userId: OWNER });
    const step = { kind: 'run_automation', automationId: 'auto-1', inputMapping: { name: { kind: 'field', name: 'name' } } };
    const r = await actionExecutor.executeDataStep(app, modelWith(tableWith()), step, ownerCtx({ formValues: { name: 'Tom' } }));

    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.result.output, { ok: true });
    assert.strictEqual(runnerCalls.length, 1);
    assert.strictEqual(runnerCalls[0].automation.id, 'auto-1');
    assert.deepStrictEqual(runnerCalls[0].opts.triggerPayload.inputs, { name: 'Tom' });
    assert.strictEqual(runnerCalls[0].opts.triggerPayload._viewerUserId, OWNER);
    assert.strictEqual(runnerCalls[0].opts.mode, 'live');
});

test('run_automation: an automation owned by someone else is rejected, runner never called', async () => {
    automations.set('auto-2', { id: 'auto-2', userId: 'someone-else' });
    const step = { kind: 'run_automation', automationId: 'auto-2' };
    const r = await actionExecutor.executeDataStep(app, modelWith(tableWith()), step, ownerCtx());
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /does not belong to the app owner/i);
    assert.strictEqual(runnerCalls.length, 0);
});

test('run_automation: a missing automation is "not found"', async () => {
    const step = { kind: 'run_automation', automationId: 'auto-gone' };
    const r = await actionExecutor.executeDataStep(app, modelWith(tableWith()), step, ownerCtx());
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /not found/i);
    assert.strictEqual(runnerCalls.length, 0);
});

test('run_automation: a failed run surfaces the error (ok:false)', async () => {
    automations.set('auto-3', { id: 'auto-3', userId: OWNER });
    runnerImpl = async () => ({ id: 'run-x', status: 'error', error: 'boom', output: null });
    const step = { kind: 'run_automation', automationId: 'auto-3' };
    const r = await actionExecutor.executeDataStep(app, modelWith(tableWith()), step, ownerCtx());
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /boom/);
});

// ── Shared helpers (deduped with routes/studioAppsRun.js) ────────────────────

test('resolveInputs: static + field mapping; unmapped/overlong keys dropped; strings capped', () => {
    const { LIMITS } = require('./componentSpecs');
    const longKey = 'k'.repeat(101);
    const inputs = actionExecutor.resolveInputs(
        {
            fixed: { kind: 'static', value: 42 },
            email: { kind: 'field', name: 'email' },
            missing: { kind: 'field', name: 'notSent' },
            weird: { kind: 'wat', name: 'email' },
            [longKey]: { kind: 'static', value: 'dropped' },
        },
        { email: 'a@b.nl', sneaky: 'dropped', big: 'x'.repeat(LIMITS.MAX_STRING + 10) },
    );
    assert.deepStrictEqual(inputs, { fixed: 42, email: 'a@b.nl' });

    const mapped = actionExecutor.resolveInputs(
        { big: { kind: 'field', name: 'big' } },
        { big: 'x'.repeat(LIMITS.MAX_STRING + 10) },
    );
    assert.strictEqual(mapped.big.length, LIMITS.MAX_STRING, 'mapped strings capped to LIMITS.MAX_STRING');
});

test('resolveInputs: a non-primitive mapped field throws the 400 contract', () => {
    for (const bad of [{ nested: true }, ['a', 'b']]) {
        assert.throws(
            () => actionExecutor.resolveInputs({ email: { kind: 'field', name: 'email' } }, { email: bad }),
            (e) => e.status === 400 && /email.*must be a string, number or boolean/.test(e.message),
        );
    }
});

test('resolveInputs: omitted mapping passes all primitive fields, capped + capped-length keys only', () => {
    const many = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`f${String(i).padStart(3, '0')}`, i]));
    const out = actionExecutor.resolveInputs(null, {
        ...many,
        obj: { a: 1 }, arr: [1], nil: null, ['k'.repeat(101)]: 'dropped',
    });
    assert.ok(!('obj' in out) && !('arr' in out) && !('nil' in out), 'non-primitives dropped silently');
    assert.strictEqual(Object.keys(out).length, 100, 'all-fields path capped at 100 entries');
});

test('run_automation: a non-primitive mapped field surfaces as ok:false (400 path)', async () => {
    automations.set('auto-4', { id: 'auto-4', userId: OWNER });
    const step = { kind: 'run_automation', automationId: 'auto-4', inputMapping: { email: { kind: 'field', name: 'email' } } };
    const r = await actionExecutor.executeDataStep(app, modelWith(tableWith()), step, ownerCtx({ formValues: { email: { nested: 1 } } }));
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /email.*must be a string, number or boolean/);
    assert.strictEqual(runnerCalls.length, 0, 'runner never called on a bad mapping value');
});

// ── run_automation → app_trigger targets (typed bridge) ──────────────────────

const SHA = 'c'.repeat(64);
function appTriggerAutomation(id, params) {
    return { id, userId: OWNER, definition: { trigger: { id: 'trg', kind: 'app_trigger', params }, steps: [], edges: [] } };
}
function seedAttachment(fileId, extra = {}) {
    attachments.set(fileId, {
        id: fileId, appId: app.id, ownerUserId: OWNER,
        mimeType: 'application/pdf', sha256: SHA, size: 1234,
        scanned: true, quarantined: false, ...extra,
    });
}

test('app_trigger: typed inputs validate/coerce and land FLAT next to the audit keys', async () => {
    automations.set('auto-t1', appTriggerAutomation('auto-t1', [
        { name: 'title', type: 'string', required: true },
        { name: 'amount', type: 'number' },
        { name: 'tags', type: 'array' },
        { name: 'meta', type: 'object' },
    ]));
    const step = {
        kind: 'run_automation', automationId: 'auto-t1',
        inputMapping: { title: { kind: 'field', name: 'name' }, meta: { kind: 'static', value: '{"src":"app"}' } },
    };
    const r = await actionExecutor.executeDataStep(app, modelWith(tableWith()), step, ownerCtx({
        formValues: { name: 'Report', amount: '42', tags: ['a', 'b'], sneaky: 'never-forwarded' },
    }));
    assert.strictEqual(r.ok, true, r.error);
    const payload = runnerCalls[0].opts.triggerPayload;
    // FLAT: no `inputs` nesting; declared params only; coercions applied.
    assert.ok(!('inputs' in payload), 'app_trigger payload is flat');
    assert.strictEqual(payload.title, 'Report');
    assert.strictEqual(payload.amount, 42, 'numeric string coerced (identity mapping by name)');
    assert.deepStrictEqual(payload.tags, ['a', 'b']);
    assert.deepStrictEqual(payload.meta, { src: 'app' }, 'static JSON string parsed for object param');
    assert.ok(!('sneaky' in payload), 'undeclared form fields never forwarded');
    assert.strictEqual(payload._viewerUserId, OWNER);
    assert.strictEqual(payload._studioAppId, app.id);
    assert.strictEqual(payload._stepKind, 'run_automation');
});

test('app_trigger: missing required params → ok:false listing ALL names, runner never called', async () => {
    automations.set('auto-t2', appTriggerAutomation('auto-t2', [
        { name: 'a', type: 'string', required: true },
        { name: 'b', type: 'number', required: true },
        { name: 'c', type: 'string' },
    ]));
    const step = { kind: 'run_automation', automationId: 'auto-t2' };
    const r = await actionExecutor.executeDataStep(app, modelWith(tableWith()), step, ownerCtx({ formValues: {} }));
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /Missing required inputs: a, b/);
    assert.strictEqual(runnerCalls.length, 0);
});

test('app_trigger: a type violation names the param', async () => {
    automations.set('auto-t3', appTriggerAutomation('auto-t3', [{ name: 'amount', type: 'number', required: true }]));
    const step = { kind: 'run_automation', automationId: 'auto-t3' };
    const r = await actionExecutor.executeDataStep(app, modelWith(tableWith()), step, ownerCtx({ formValues: { amount: 'not-a-number' } }));
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /Input "amount" expects a number/);
    assert.strictEqual(runnerCalls.length, 0);
});

test('app_trigger file: descriptor verified in the ledger and expanded with a signed url', async () => {
    automations.set('auto-f1', appTriggerAutomation('auto-f1', [{ name: 'doc', type: 'file', required: true }]));
    seedAttachment('att-1');
    const step = { kind: 'run_automation', automationId: 'auto-f1' };
    const r = await actionExecutor.executeDataStep(app, modelWith(tableWith()), step, ownerCtx({
        formValues: { doc: { kind: 'studio_attachment', fileId: 'att-1', name: '  Quarterly report.pdf  ', mime: 'text/evil', size: 9 } },
    }));
    assert.strictEqual(r.ok, true, r.error);
    const doc = runnerCalls[0].opts.triggerPayload.doc;
    assert.strictEqual(doc.fileId, 'att-1');
    assert.strictEqual(doc.name, 'Quarterly report.pdf', 'client display name trimmed');
    assert.strictEqual(doc.mime, 'application/pdf', 'mime ALWAYS from the ledger, never the client');
    assert.strictEqual(doc.size, 1234, 'size ALWAYS from the ledger');
    assert.ok(doc.url.includes('/api/storage/tmp/'), 'signed tmp url minted');
    assert.strictEqual(tmpUrlCalls[0].key, `studio-apps/${OWNER}/${app.id}/attachments/${SHA}`);
});

test('app_trigger file: foreign, unscanned or quarantined attachments are refused', async () => {
    automations.set('auto-f2', appTriggerAutomation('auto-f2', [{ name: 'doc', type: 'file', required: true }]));
    const step = { kind: 'run_automation', automationId: 'auto-f2' };
    const runWith = (fileId) => actionExecutor.executeDataStep(app, modelWith(tableWith()), step, ownerCtx({
        formValues: { doc: { kind: 'studio_attachment', fileId } },
    }));

    // Unknown id / another app's attachment → owner-scoped lookup misses.
    let r = await runWith('att-foreign');
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /not uploaded to this app/);

    seedAttachment('att-unscanned', { scanned: false });
    r = await runWith('att-unscanned');
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /malware scan/);

    seedAttachment('att-bad', { quarantined: true });
    r = await runWith('att-bad');
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /malware scan/);
    assert.strictEqual(runnerCalls.length, 0, 'runner never called for refused files');
});

test('app_trigger file: a single-element array unwraps; multiple files are refused', async () => {
    automations.set('auto-f3', appTriggerAutomation('auto-f3', [{ name: 'doc', type: 'file' }]));
    seedAttachment('att-2');
    const step = { kind: 'run_automation', automationId: 'auto-f3' };
    const desc = { kind: 'studio_attachment', fileId: 'att-2' };

    let r = await actionExecutor.executeDataStep(app, modelWith(tableWith()), step, ownerCtx({ formValues: { doc: [desc] } }));
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(runnerCalls[0].opts.triggerPayload.doc.fileId, 'att-2');

    r = await actionExecutor.executeDataStep(app, modelWith(tableWith()), step, ownerCtx({ formValues: { doc: [desc, desc] } }));
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /one file/);
});

test('app_trigger: legacy non-app_trigger targets keep the nested-inputs payload byte-identical', async () => {
    // Same call as the legacy test above, but explicitly with a manual-trigger
    // definition attached — the branch must key on trigger.kind, not on the
    // presence of a definition.
    automations.set('auto-legacy', { id: 'auto-legacy', userId: OWNER, definition: { trigger: { id: 'trg', kind: 'manual' }, steps: [], edges: [] } });
    const step = { kind: 'run_automation', automationId: 'auto-legacy', inputMapping: { name: { kind: 'field', name: 'name' } } };
    const r = await actionExecutor.executeDataStep(app, modelWith(tableWith()), step, ownerCtx({ formValues: { name: 'Tom' } }));
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(runnerCalls[0].opts.triggerPayload, {
        inputs: { name: 'Tom' },
        _viewerUserId: OWNER,
        _studioAppId: app.id,
        _stepKind: 'run_automation',
    });
});

test('deriveFinalOutput: run.output wins; else the last executed TOP-LEVEL step (children, trigger and wait skipped)', async () => {
    assert.strictEqual(await actionExecutor.deriveFinalOutput(null), null);
    assert.deepStrictEqual(await actionExecutor.deriveFinalOutput({ id: 'r', status: 'success', output: { n: 7 } }), { n: 7 });
    assert.strictEqual(await actionExecutor.deriveFinalOutput({ id: 'r', status: 'error' }), null, 'failed run → null');

    // No output column → derive from steps via the (stubbed) automationStore.
    const automationStore = require('../stores/automationStore');
    const orig = automationStore.getRunSteps;
    automationStore.getRunSteps = async () => [
        { stepId: 'trig', stepType: 'trigger', parentStepId: null, output: { ignore: true } },
        { stepId: 's1', stepType: 'integration_action', parentStepId: null, output: { rows: [1] } },
        { stepId: 's1.child', stepType: 'integration_action', parentStepId: 's1', output: { child: true } },
        { stepId: 's2', stepType: 'integration_action', parentStepId: null, output: { rows: [{ name: 'A' }], count: 1 } },
        // BFSF-371: runDag now takes a Wait LAST in a fan-out, so the final
        // row is often the sleep. `{ waitedSeconds }` is bookkeeping, never the
        // automation’s answer — a screen bound to actionResult must still see s2.
        { stepId: 'w', stepType: 'wait', parentStepId: null, output: { waitedSeconds: 120 } },
    ];
    try {
        const out = await actionExecutor.deriveFinalOutput({ id: 'run-steps', status: 'success' });
        assert.deepStrictEqual(out, { rows: [{ name: 'A' }], count: 1 }, 'the trailing wait is not the result');

        // An automation whose only top-level step IS a wait has no answer to give.
        automationStore.getRunSteps = async () => [
            { stepId: 'trig', stepType: 'trigger', parentStepId: null, output: { ignore: true } },
            { stepId: 'w', stepType: 'wait', parentStepId: null, output: { waitedSeconds: 5 } },
        ];
        assert.strictEqual(await actionExecutor.deriveFinalOutput({ id: 'run-waits', status: 'success' }), null,
            'an automation that only waited produced nothing');
    } finally {
        automationStore.getRunSteps = orig;
    }
});

// ── Defense in depth ──────────────────────────────────────────────────────────

test('a client-only step kind is rejected here too', async () => {
    for (const kind of ['toast', 'navigate', 'confirm', 'set_variable', 'condition', 'open_modal']) {
        const r = await actionExecutor.executeDataStep(app, modelWith(tableWith()), { kind, message: 'x' }, ownerCtx());
        assert.strictEqual(r.ok, false, `${kind} must not execute on the server`);
        assert.match(r.error, /not a server step/i);
    }
    assert.strictEqual(execCalls.length, 0);
});

test('an unknown table is "not found"', async () => {
    const step = { kind: 'create_record', tableId: 'tbl_missing', values: {} };
    const r = await actionExecutor.executeDataStep(app, modelWith(tableWith()), step, ownerCtx());
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /table not found/i);
    assert.strictEqual(execCalls.length, 0);
});
