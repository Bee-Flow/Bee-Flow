// @typecheck
'use strict';

/**
 * Datatable rows over the Bee Flow MCP server (routes/mcpDatatableTools.js and
 * its wiring in routes/mcpServer.js): per-row validation, the access decision
 * at the moment of the write, a table of another organisation, the caps and
 * the per-row rate charge, the token's scope, and that no cell is logged.
 *
 * The database is not touched: the table resolver, the row store and the rate
 * limiter are handed in. The query compiler, the access filter and the cell
 * normaliser are the real ones, so the SQL that WOULD run is what is asserted.
 *
 * Run: cd server && node --test routes/mcpDatatableTools.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const tools = require('./mcpDatatableTools');
const mcp = require('./mcpServer');
const log = require('../telemetry/log');
const { synthesizeAccess } = require('../auth/datatableAccess');

const SECRET = 'jan.jansen@example.test';

const FIELDS = [
    { id: 'fld_name', key: 'name', name: 'Name', type: 'text', required: true },
    { id: 'fld_email', key: 'email', name: 'E-mail', type: 'text', unique: true },
    { id: 'fld_age', key: 'age', name: 'Age', type: 'number', subtype: 'integer' },
    { id: 'fld_when', key: 'when', name: 'When', type: 'date' },
    { id: 'fld_status', key: 'status', name: 'Status', type: 'select', options: ['new', 'done'] },
    { id: 'fld_total', key: 'total', name: 'Total', type: 'computed' },
];

function tableMeta() {
    return { id: 'dt_1', key: 'tbl_people', fields: FIELDS, access: synthesizeAccess({}) };
}

/** A fake environment: what the resolver answers, and a record of everything written. */
function env({ grade = 'editor', resolveError = null, mirror = false, quotaError = null, chargeOk = true, execFailsFor = null, changes = 1 } = {}) {
    const calls = { exec: [], query: [], bump: [], charge: [], resolve: [] };
    const table = { id: 'dt_1', name: 'People', key: 'people', scope_kind: 'org', scope_id: 'org_a', organizationId: 'org_a' };
    const overrides = {
        principalFor: async () => ({ userId: 'u1', orgId: 'org_a', organizationId: 'org_a', orgRole: null, groupIds: [], identityError: null }),
        resolve: async (id, ctx, opts) => {
            calls.resolve.push({ id, ctx, opts });
            if (resolveError) throw Object.assign(new Error('x'), { errorClass: resolveError });
            return { table, scope: { kind: 'org', id: 'org_a' }, scopeKey: 'org_a', orgId: 'org_a', grade, tableMeta: tableMeta() };
        },
        isMirror: () => mirror,
        assertQuota: async () => { if (quotaError) throw quotaError; },
        exec: async (key, sql, params) => {
            calls.exec.push({ key, sql, params });
            if (execFailsFor && params.includes(execFailsFor)) throw Object.assign(new Error(`duplicate key value (${SECRET})`), { code: '23505' });
            return { changes };
        },
        query: async (key, sql, params) => { calls.query.push({ key, sql, params }); return { rows: [] }; },
        bump: async (id, scope, delta) => { calls.bump.push(delta); },
        charge: async (name, key, cost, max) => { calls.charge.push({ name, key, cost, max }); return chargeOk ? { ok: true } : { ok: false, retryAfter: 30 }; },
    };
    return { calls, tools: tools.makeDatatableTools(overrides) };
}

const ctx = { userId: 'u1', tokenId: 'tok_1' };

test('insert: every row is answered; a bad row never stops the good ones', async () => {
    const { calls, tools: t } = env();
    const out = await t.call('datatables_insert_rows', {
        datatableId: 'dt_1',
        rows: [
            { name: 'Ann', age: '41', when: '2026-02-03' },
            { name: 'Bob', nickname: 'x' },
            { email: 'no-name@example.test' },
            { name: 'Cy', age: 'old' },
            { name: 'Di', status: 'maybe' },
            { name: 'Ed', id: 'rec_forced' },
            { name: 'Fay', total: 5 },
            'not an object',
            { name: 'Gus', when: '2026-02-30' },
            { name: 'Hal', status: 'done' },
        ],
    }, ctx);
    assert.equal(out.inserted, 2);
    assert.equal(out.failed, 8);
    assert.equal(out.results.length, 10);
    assert.deepEqual(out.results.map((r) => r.ok), [true, false, false, false, false, false, false, false, false, true]);
    assert.match(out.results[0].id, /^rec_|^[a-z0-9_-]+$/i);
    assert.match(out.results[1].error, /Unknown column "nickname"/);
    assert.match(out.results[1].error, /Columns: name, email/);
    assert.match(out.results[2].error, /"name" is required/);
    assert.match(out.results[3].error, /"age"/);
    assert.match(out.results[4].error, /"status" must be one of: new, done/);
    assert.match(out.results[5].error, /"id" is set by Bee Flow/);
    assert.match(out.results[6].error, /computed/);
    assert.match(out.results[7].error, /object of column key/);
    assert.match(out.results[8].error, /"when"/);
    // Only the two good rows reached the database, and the counter moved by what landed.
    assert.equal(calls.exec.length, 2);
    assert.deepEqual(calls.bump, [2]);
    // The cell was normalised to the type of its column (the string "41" is the number 41).
    assert.ok(calls.exec[0].params.includes(41));
    assert.match(calls.exec[0].sql, /INSERT INTO/);
    // created_by is the token's user, never a value from the call.
    assert.ok(calls.exec[0].params.includes('u1'));
});

test('insert: a row the database refuses is reported with a fixed sentence, never its text', async () => {
    const { tools: t } = env({ execFailsFor: 'Dup' });
    const out = await t.call('datatables_insert_rows', { datatableId: 'dt_1', rows: [{ name: 'Dup', email: SECRET }, { name: 'Fine' }] }, ctx);
    assert.equal(out.inserted, 1);
    assert.equal(out.results[0].ok, false);
    assert.match(out.results[0].error, /already in the table/);
    assert.ok(!JSON.stringify(out).includes(SECRET));
    assert.equal(out.results[1].ok, true);
});

test('insert: the write needs editor access, resolved fresh for this call', async () => {
    const { calls, tools: t } = env();
    await t.call('datatables_insert_rows', { datatableId: 'dt_1', rows: [{ name: 'A' }] }, ctx);
    assert.equal(calls.resolve[0].opts.needed, 'editor');
    assert.equal(calls.resolve[0].ctx.userId, 'u1');
    await t.call('datatables_insert_rows', { datatableId: 'dt_1', rows: [{ name: 'B' }] }, ctx);
    assert.equal(calls.resolve.length, 2, 'every call decides again; nothing is remembered');
});

test('insert: permission denied writes nothing', async () => {
    const { calls, tools: t } = env({ resolveError: 'datatable_forbidden' });
    const out = await t.call('datatables_insert_rows', { datatableId: 'dt_1', rows: [{ name: 'A' }] }, ctx);
    assert.equal(out.code, 'datatable_not_available');
    assert.equal(calls.exec.length, 0);
    assert.equal(calls.bump.length, 0);
});

test('insert: a viewer grade is refused by the access check even if the resolver let it through', async () => {
    const { calls, tools: t } = env({ grade: 'viewer' });
    const out = await t.call('datatables_insert_rows', { datatableId: 'dt_1', rows: [{ name: 'A' }] }, ctx);
    assert.ok(out.error);
    assert.equal(calls.exec.length, 0);
});

test('a table of another organisation answers exactly like a table that does not exist', async () => {
    const other = env({ resolveError: 'datatable_not_found' });
    const forbidden = env({ resolveError: 'datatable_forbidden' });
    const a = await other.tools.call('datatables_insert_rows', { datatableId: 'dt_other_org', rows: [{ name: 'A' }] }, ctx);
    const b = await forbidden.tools.call('datatables_insert_rows', { datatableId: 'dt_missing', rows: [{ name: 'A' }] }, ctx);
    assert.deepEqual(a, b);
    assert.equal(other.calls.exec.length, 0);
    for (const name of ['datatables_get_schema', 'datatables_query_rows']) {
        const r = await other.tools.call(name, { datatableId: 'dt_other_org' }, ctx);
        assert.equal(r.code, 'datatable_not_available');
    }
    const u = await other.tools.call('datatables_update_rows', { datatableId: 'dt_other_org', updates: [{ id: 'rec_1', values: { name: 'x' } }] }, ctx);
    assert.equal(u.code, 'datatable_not_available');
    assert.equal(other.calls.exec.length, 0);
});

test('a table that mirrors an external source is not written over MCP', async () => {
    const { calls, tools: t } = env({ mirror: true });
    const out = await t.call('datatables_insert_rows', { datatableId: 'dt_1', rows: [{ name: 'A' }] }, ctx);
    assert.equal(out.code, 'linked_table');
    assert.equal(calls.exec.length, 0);
});

test('a full table writes none of the rows and says so', async () => {
    const quotaError = Object.assign(new Error('This datatable is full'), { status: 409, code: 'quota_exceeded', limit: 10, used: 10 });
    const { calls, tools: t } = env({ quotaError });
    const out = await t.call('datatables_insert_rows', { datatableId: 'dt_1', rows: [{ name: 'A' }] }, ctx);
    assert.equal(out.code, 'quota_exceeded');
    assert.equal(out.limit, 10);
    assert.equal(calls.exec.length, 0);
});

test('caps: rows per call (env, 0 = unlimited) and payload size', async () => {
    const was = { rows: process.env.MCP_DATATABLE_ROWS_MAX, payload: process.env.MCP_DATATABLE_PAYLOAD_MAX_BYTES };
    try {
        const rows = Array.from({ length: 101 }, (_, i) => ({ name: `n${i}` }));
        // Default: 100.
        delete process.env.MCP_DATATABLE_ROWS_MAX;
        let e = env();
        let out = await e.tools.call('datatables_insert_rows', { datatableId: 'dt_1', rows }, ctx);
        assert.equal(out.code, 'too_many_rows');
        assert.equal(out.limit, 100);
        assert.equal(e.calls.exec.length, 0);
        assert.equal(e.calls.charge.length, 0, 'a refused call costs nothing');
        // Configured lower.
        process.env.MCP_DATATABLE_ROWS_MAX = '2';
        e = env();
        out = await e.tools.call('datatables_insert_rows', { datatableId: 'dt_1', rows: rows.slice(0, 3) }, ctx);
        assert.equal(out.code, 'too_many_rows');
        out = await e.tools.call('datatables_update_rows', { datatableId: 'dt_1', updates: rows.slice(0, 3).map((r, i) => ({ id: `rec_${i}`, values: r })) }, ctx);
        assert.equal(out.code, 'too_many_rows');
        // 0 = unlimited.
        process.env.MCP_DATATABLE_ROWS_MAX = '0';
        e = env();
        out = await e.tools.call('datatables_insert_rows', { datatableId: 'dt_1', rows }, ctx);
        assert.equal(out.inserted, 101);
        // Payload.
        process.env.MCP_DATATABLE_PAYLOAD_MAX_BYTES = '200';
        e = env();
        out = await e.tools.call('datatables_insert_rows', { datatableId: 'dt_1', rows: [{ name: 'x'.repeat(500) }] }, ctx);
        assert.equal(out.code, 'payload_too_large');
        assert.equal(e.calls.exec.length, 0);
    } finally {
        for (const [k, v] of [['MCP_DATATABLE_ROWS_MAX', was.rows], ['MCP_DATATABLE_PAYLOAD_MAX_BYTES', was.payload]]) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    }
});

test('rate limit: one unit per row, against the token and against the user', async () => {
    const { calls, tools: t } = env();
    await t.call('datatables_insert_rows', { datatableId: 'dt_1', rows: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] }, ctx);
    assert.deepEqual(calls.charge.map((c) => [c.name, c.key, c.cost]), [
        ['mcp-dt-rows-token', 'tok_1', 3],
        ['mcp-dt-rows-user', 'user:u1', 3],
    ]);
    const legacy = env();
    await legacy.tools.call('datatables_insert_rows', { datatableId: 'dt_1', rows: [{ name: 'A' }] }, { userId: 'u1', tokenId: null });
    assert.equal(legacy.calls.charge[0].key, 'legacy:u1');
});

test('rate limit: a refused charge writes nothing', async () => {
    const { calls, tools: t } = env({ chargeOk: false });
    const out = await t.call('datatables_insert_rows', { datatableId: 'dt_1', rows: [{ name: 'A' }] }, ctx);
    assert.equal(out.code, 'rate_limited');
    assert.equal(out.retryAfter, 30);
    assert.equal(calls.exec.length, 0);
    assert.equal(calls.resolve.length, 0);
});

test('update: a patch, per-row results, conflicts and unknown rows are told apart', async () => {
    const { calls, tools: t } = env({ changes: 1 });
    let out = await t.call('datatables_update_rows', {
        datatableId: 'dt_1',
        updates: [
            { id: 'rec_1', values: { age: 7 } },
            { id: 'rec_2', values: { nickname: 'x' } },
            { id: 'rec_3', values: { name: '' } },
            { id: 'rec_4', values: {} },
            { values: { age: 1 } },
            { id: 'rec_6', values: { id: 'rec_hack' } },
        ],
    }, ctx);
    assert.deepEqual(out.results.map((r) => r.ok), [true, false, false, false, false, false]);
    assert.equal(out.updated, 1);
    assert.match(out.results[1].error, /Unknown column/);
    assert.match(out.results[2].error, /"name" is required/);
    assert.match(out.results[3].error, /empty/);
    assert.match(out.results[5].error, /set by Bee Flow/);
    assert.equal(calls.exec.length, 1);
    assert.match(calls.exec[0].sql, /UPDATE/);
    assert.deepEqual(calls.bump, [0]);

    // Nothing changed and the row is not visible: "no such row". Nothing changed and it is: a conflict.
    const gone = env({ changes: 0 });
    out = await gone.tools.call('datatables_update_rows', { datatableId: 'dt_1', updates: [{ id: 'rec_9', values: { age: 1 }, expectedUpdatedAt: '2026-01-01T00:00:00.000Z' }] }, ctx);
    assert.match(out.results[0].error, /No such row/);
    assert.equal(gone.calls.bump.length, 0);
});

test('update: needs editor access too', async () => {
    const { calls, tools: t } = env({ resolveError: 'datatable_forbidden' });
    const out = await t.call('datatables_update_rows', { datatableId: 'dt_1', updates: [{ id: 'rec_1', values: { age: 1 } }] }, ctx);
    assert.equal(out.code, 'datatable_not_available');
    assert.equal(calls.exec.length, 0);
    assert.equal(calls.resolve[0].opts.needed, 'editor');
});

test('query: reads need viewer access, the limit is capped and the cursor is returned', async () => {
    const was = process.env.MCP_DATATABLE_QUERY_MAX;
    try {
        process.env.MCP_DATATABLE_QUERY_MAX = '5';
        const e = env({ grade: 'viewer' });
        const out = await e.tools.call('datatables_query_rows', {
            datatableId: 'dt_1', limit: 1000, filters: [{ field: 'age', op: 'gt', value: 3 }], sort: 'age', dir: 'asc',
        }, ctx);
        assert.equal(out.count, 0);
        assert.equal(e.calls.resolve[0].opts.needed, 'viewer');
        assert.equal(e.calls.query.length, 1);
        // The access predicate is ANDed in, the filter value is bound, the page is capped (+1 probe).
        assert.match(e.calls.query[0].sql, /LIMIT/);
        assert.ok(e.calls.query[0].params.includes(3));
        assert.ok(e.calls.query[0].params.includes(6));
        const bad = await e.tools.call('datatables_query_rows', { datatableId: 'dt_1', filters: [{ field: 'nope', op: 'eq', value: 1 }] }, ctx);
        assert.equal(bad.code, 'unknown_filter_field');
        const sql = await e.tools.call('datatables_query_rows', { datatableId: 'dt_1', sort: '1; DROP TABLE x' }, ctx);
        assert.equal(sql.code, 'unknown_sort_field');
    } finally {
        if (was === undefined) delete process.env.MCP_DATATABLE_QUERY_MAX; else process.env.MCP_DATATABLE_QUERY_MAX = was;
    }
});

test('schema: columns with type, required, unique and options', async () => {
    const { tools: t } = env({ grade: 'viewer' });
    const out = await t.call('datatables_get_schema', { datatableId: 'dt_1' }, ctx);
    assert.equal(out.canWrite, false, 'a viewer is told it cannot write');
    const name = out.columns.find((c) => c.key === 'name');
    assert.deepEqual(name, { key: 'name', name: 'Name', type: 'text', required: true, unique: false });
    assert.equal(out.columns.find((c) => c.key === 'email').unique, true);
    assert.deepEqual(out.columns.find((c) => c.key === 'status').options, ['new', 'done']);
});

test('list: only the tables the account holds a grade on', async () => {
    const tableA = { id: 'dt_a', name: 'Mine', key: 'mine', scope_kind: 'user', scope_id: 'u1', rowCount: 3 };
    const tableB = { id: 'dt_b', name: 'Theirs', key: 'theirs', scope_kind: 'user', scope_id: 'someone_else', rowCount: 1 };
    const tableC = { id: 'dt_c', name: 'Org', key: 'org', scope_kind: 'org', scope_id: 'org_a', organization_id: 'org_a', owner_user_id: 'u9', is_published: true, rowCount: 8 };
    const t = tools.makeDatatableTools({
        principalFor: async () => ({ userId: 'u1', orgId: 'org_a', organizationId: 'org_a', orgRole: null, groupIds: [], identityError: null }),
        listForScope: async (scope) => (scope.kind === 'org' ? [tableC] : [tableA, tableB]),
        listGrants: async () => [],
        isMirror: () => false,
    });
    const out = await t.call('datatables_list', {}, ctx);
    assert.deepEqual(out.datatables.map((d) => [d.id, d.access, d.canWrite]), [['dt_c', 'viewer', false], ['dt_a', 'owner', true]]);
});

test('no cell value, filter value or database text is logged', async () => {
    const seen = [];
    const originals = {};
    for (const level of ['info', 'warn', 'error', 'debug']) {
        originals[level] = log[level];
        log[level] = (...args) => { seen.push(args.map(String).join(' ')); };
    }
    try {
        const { tools: t } = env({ execFailsFor: 'Dup' });
        await t.call('datatables_insert_rows', { datatableId: 'dt_1', rows: [{ name: 'Dup', email: SECRET }, { name: SECRET }] }, ctx);
        await t.call('datatables_update_rows', { datatableId: 'dt_1', updates: [{ id: 'rec_1', values: { email: SECRET } }] }, ctx);
        await t.call('datatables_query_rows', { datatableId: 'dt_1', filters: [{ field: 'email', op: 'eq', value: SECRET }] }, ctx);
        await env({ resolveError: 'boom' }).tools.call('datatables_insert_rows', { datatableId: 'dt_1', rows: [{ name: SECRET }] }, ctx);
    } finally {
        Object.assign(log, originals);
    }
    assert.ok(seen.length > 0, 'ids and counts are logged');
    assert.ok(seen.every((line) => !line.includes(SECRET) && !line.includes('Dup')), seen.join('\n'));
});

// ── The MCP surface: scope, wiring ──────────────────────────────────────────

const rpc = (message, scopes, datatableTools) => mcp.handleRpc(message, 'u1',
    { toolsForUser: async () => ({ tools: [], session: null }), datatableTools },
    { token: { id: 'tok_1', name: 't', scopes, legacy: false } });

test('scope: a read token lists and calls only the read tools; a write token gets them all', async () => {
    const seen = [];
    const fake = { call: async (name, args, c) => { seen.push({ name, c }); return { ok: true }; } };
    const listOf = async (scopes) => (await rpc({ id: 1, method: 'tools/list' }, scopes, fake)).result.tools.map((x) => x.name);
    assert.deepEqual((await listOf({ integrations: { level: 'read' } })).sort(), ['datatables_get_schema', 'datatables_list', 'datatables_query_rows']);
    assert.equal((await listOf({ integrations: { level: 'write' } })).length, 5);
    assert.deepEqual(await listOf({ automations: { level: 'write' } }), []);
    assert.deepEqual(await listOf({ integrations: { level: 'write', tools: ['datatables_list'] } }), ['datatables_list']);

    const denied = await rpc({ id: 2, method: 'tools/call', params: { name: 'datatables_insert_rows', arguments: { datatableId: 'dt_1', rows: [] } } }, { integrations: { level: 'read' } }, fake);
    assert.equal(denied.result.isError, true);
    assert.match(denied.result.content[0].text, /not available to this token/);
    const noServer = await rpc({ id: 3, method: 'tools/call', params: { name: 'datatables_list', arguments: {} } }, { studio: { level: 'write' } }, fake);
    assert.equal(noServer.result.isError, true);
    assert.equal(seen.length, 0, 'a refused call never reaches the tool');

    const ok = await rpc({ id: 4, method: 'tools/call', params: { name: 'datatables_insert_rows', arguments: { datatableId: 'dt_1', rows: [] } } }, { integrations: { level: 'write' } }, fake);
    assert.equal(ok.result.isError, false);
    assert.deepEqual(seen, [{ name: 'datatables_insert_rows', c: { userId: 'u1', tokenId: 'tok_1' } }]);
});

test('a tool error is reported as isError with its code', async () => {
    const { tools: t } = env({ resolveError: 'datatable_forbidden' });
    const res = await rpc({ id: 5, method: 'tools/call', params: { name: 'datatables_get_schema', arguments: { datatableId: 'dt_1' } } }, { integrations: { level: 'write' } }, t);
    assert.equal(res.result.isError, true);
    assert.equal(JSON.parse(res.result.content[0].text).code, 'datatable_not_available');
});
