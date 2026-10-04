'use strict';

/**
 * A FORM THAT COLLECTS ITS ANSWERS IN A TABLE, END TO END, against a REAL
 * Postgres (pglite; the genuine store, engine, planner and compiler; the
 * datatables handlers invoked off the route stack; the form-answers engine
 * driven as the crud and formPublic routes drive it).
 *
 * The story: a form automation with `collect: true` gets a table whose columns
 * are its questions; a submission is a row with the submitter as created_by;
 * a relabel renames a column and moves no data; a retype adds a column and
 * retires the old one; a removed question is retired, its answers intact;
 * the dashboard summary counts what the caller may see and nobody else gets
 * it; the retired column can be dropped by the owner and no other; turning
 * collection off keeps the table; deleting the form releases it.
 *
 * Run: cd server && node --test routes/automation/formAnswers.integration.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

const SERVER = path.resolve(__dirname, '..', '..');
const { PGlite } = require('@electric-sql/pglite');
const pg = new PGlite();

function adaptResult(res, sql) {
    const r = Array.isArray(res) ? (res[res.length - 1] || {}) : (res || {});
    const rows = r.rows || [];
    const fields = r.fields || [];
    const command = fields.length > 0 ? 'SELECT' : String(sql).trim().split(/\s+/)[0].toUpperCase();
    const rowCount = fields.length > 0 ? rows.length : (typeof r.affectedRows === 'number' ? r.affectedRows : 0);
    return { rows, fields, rowCount, command };
}
async function rawQuery(sql, params) {
    if (Array.isArray(params) && params.length > 0) return adaptResult(await pg.query(sql, params), sql);
    if (/;\s*\S/.test(String(sql).trim())) return adaptResult(await pg.exec(sql), sql);
    return adaptResult(await pg.query(sql), sql);
}
const client = { query: (sql, params) => rawQuery(sql, params), release: () => {} };

function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

mock(path.join(SERVER, 'db.js'), {
    pool: { query: rawQuery, connect: async () => client },
    run: rawQuery,
    getOne: async (sql, params) => (await rawQuery(sql, params)).rows[0] || null,
    getAll: async (sql, params) => (await rawQuery(sql, params)).rows,
    exec: (sql) => rawQuery(sql, []),
    getClient: async () => client,
    withTransaction: async (fn) => {
        await client.query('BEGIN');
        try { const out = await fn(client); await client.query('COMMIT'); return out; } catch (e) { try { await client.query('ROLLBACK'); } catch { /* */ } throw e; }
    },
    makeStoreInit: (tag, schemaFn) => {
        let promise = null;
        return function ensureInit() {
            if (!promise) promise = Promise.resolve().then(schemaFn).catch((err) => { promise = null; throw err; });
            return promise;
        };
    },
    getRedis: () => null, redisHealthy: () => false,
    isSqlStateError: (e) => typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code),
});

const ORG = 'org-forms';
const OWNER = 'u-owner';
const READER = 'u-reader';
const STRANGER = 'u-stranger';
const USERS = {
    [OWNER]: { id: OWNER, organizationId: ORG, orgRole: 'member', groups: [], displayName: 'Olive Owner' },
    [READER]: { id: READER, organizationId: ORG, orgRole: 'member', groups: [], displayName: 'Rita Reader' },
    [STRANGER]: { id: STRANGER, organizationId: ORG, orgRole: 'member', groups: [], displayName: 'Sam Stranger' },
};
mock(path.join(SERVER, 'stores/userStore'), {
    getUser: async (id) => USERS[id] || null,
    getAllGroups: async () => [],
    getOrganization: async () => ({ id: ORG }),
    getUserAvatarsByIds: async (ids) => ids.map(id => USERS[id]).filter(Boolean).map(u => ({ id: u.id, username: u.id, displayName: u.displayName })),
});
mock(path.join(SERVER, 'stores/projectStore'), {});
const pass = () => (req, res, next) => next();
mock(path.join(SERVER, 'auth'), {
    requirePermission: pass, requireActiveOrgForMutations: pass,
    assertUserCanUseOrg: async () => true, validateSharedGroupsForOrg: async (_r, g) => g || [],
    hasPermission: async () => true, Permissions: { MANAGE_DATATABLES: 'manage_datatables' },
});
mock(path.join(SERVER, 'core/entitlements/betaFeatures'), { requireBetaFeature: pass });
mock(path.join(SERVER, 'core/entitlements/entitlements'), { requireCapability: pass });
mock(path.join(SERVER, 'utils/perUserRateLimit'), { perUserRateLimit: pass });
mock(path.join(SERVER, 'jobs/kbSourceRefresh'), { onDatatableChanged: () => {} });
mock(path.join(SERVER, 'core/webpages/webpageShareReconciler'), { onDatatableChanged: () => {} });
// The form-answers routes look the automation up to name the form; the answers
// engine itself never touches the automation store.
const AUTOMATIONS = new Map();
mock(path.join(SERVER, 'stores/automationStore'), {
    getAutomation: async (id) => AUTOMATIONS.get(id) || null,
    getFormPagesForAutomation: async (id) => (AUTOMATIONS.has(id) ? [{ id: 'tok'.padEnd(48, 'a'), automationId: id, triggerStepId: null }] : []),
});

const router = require('../datatables');
const datatableStore = require('../../stores/datatableStore');
const datatableDbStore = require('../../stores/datatableDbStore');
const formAnswers = require('../../automation/formAnswers');
const { managedFieldsError } = require('../../core/dataEngine/dataModel/managedTables');
const schemaOf = (orgId) => datatableDbStore.schemaNameFor('org', orgId);
const SC = datatableStore.orgScope(ORG);

function routeStack(method, routePath) {
    for (const layer of router.stack) {
        if (layer.route && layer.route.path === routePath && layer.route.methods[method]) return layer.route.stack.map(l => l.handle);
    }
    throw new Error(`route not found: ${method} ${routePath}`);
}
async function call(method, routePath, req) {
    const res = { statusCode: 200, body: null, sent: false, headers: {}, text: '' };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; res.sent = true; return res; };
    res.setHeader = () => res; res.write = () => true; res.end = () => { res.sent = true; return res; };
    const full = { params: {}, query: {}, body: {}, headers: {}, ...req };
    for (const handle of routeStack(method, routePath)) {
        let advanced = false;
        await handle(full, res, () => { advanced = true; });
        if (res.sent || !advanced) break;
    }
    return res;
}
const as = (userId, over = {}) => ({ session: { user: { id: userId } }, ...over });
async function realRows(key) { return (await rawQuery(`SELECT * FROM "${schemaOf(ORG)}"."${key}" ORDER BY "created_at", "id"`)).rows; }
async function columnsOf(key) {
    return (await rawQuery(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`, [schemaOf(ORG), key])).rows;
}

const Q = (name, type, label, extra = {}) => ({ name, type, label, ...extra });
function definition(fields, { collect = true, pages = [] } = {}) {
    return {
        trigger: { kind: 'form', form: { collect, title: 'Customer feedback', fields } },
        steps: pages.map(p => ({ id: p.id, type: 'form_page', mode: 'input', form: { fields: p.fields } })),
    };
}
const automation = { id: 'auto_feedback', userId: OWNER, organizationId: ORG, title: 'Feedback automation', definition: null };
function setDefinition(def) { automation.definition = def; AUTOMATIONS.set(automation.id, { ...automation, isActive: true }); return def; }

let tableId = null;
let tableKey = null;
let fieldIds = {};

before(async () => {
    await pg.exec("SET TIME ZONE 'UTC'");
    await datatableStore.initDB();
    // the dependents index LEFT JOINs the automations table when a column goes
    await pg.exec(`CREATE TABLE IF NOT EXISTS automations (id TEXT PRIMARY KEY, user_id TEXT, title TEXT, definition_json JSONB, last_run_at TIMESTAMPTZ)`);
});
after(async () => { await pg.close(); });

test('a form automation with collect:true gets a table whose columns are its questions', async () => {
    const def = setDefinition(definition([
        Q('email', 'email', 'Your e-mail', { required: true }),
        Q('source', 'select', 'How did you hear about us?', { options: ['search', 'colleague', 'newsletter'] }),
        Q('subscribe', 'checkbox', 'Subscribe to updates?'),
        Q('team', 'number', 'Team size'),
        Q('more', 'textarea', 'Anything else?'),
    ]));
    const out = await formAnswers.ensureAnswersTable(automation, def);
    assert.ok(out && out.table, JSON.stringify(out));
    assert.strictEqual(out.created, true);
    tableId = out.table.id;
    tableKey = out.table.key;
    assert.strictEqual(out.table.managedKind, 'form_answers');
    assert.strictEqual(out.table.name, 'Answers — Customer feedback');
    assert.strictEqual(out.table.source.automationId, 'auto_feedback');
    assert.strictEqual(out.table.source.linked, true);
    assert.match(out.table.description, /personal data/);
    assert.strictEqual(out.table.subjectColumn, 'email', 'the first e-mail question is the data-subject column');
    const meta = await datatableStore.getTableMeta(SC, tableId);
    assert.deepStrictEqual(meta.fields.map(f => f.key), ['run_id', 'completed_at', 'email', 'source', 'subscribe', 'team', 'more']);
    fieldIds = Object.fromEntries(meta.fields.map(f => [f.key, f.id]));
    const cols = await columnsOf(tableKey);
    assert.ok(cols.some(c => c.column_name === 'email' && c.data_type === 'text'));
    assert.ok(cols.some(c => c.column_name === 'subscribe' && c.data_type === 'boolean'));
    assert.ok(cols.some(c => c.column_name === 'team' && c.data_type === 'numeric'));
    // the client sees the columns, never the fingerprint
    const res = await call('get', '/:id', as(OWNER, { params: { id: tableId } }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.datatable.source.kind, 'form_answers');
    assert.strictEqual(res.body.datatable.source.fingerprint, undefined);
    assert.deepStrictEqual(res.body.datatable.source.columns.map(c => c.key), ['email', 'source', 'subscribe', 'team', 'more']);
});

test('an unchanged save costs nothing and provisions nothing twice', async () => {
    const out = await formAnswers.ensureAnswersTable(automation, automation.definition);
    assert.strictEqual(out.table.id, tableId);
    assert.strictEqual(out.created, false);
    assert.strictEqual(out.changed, false);
    assert.strictEqual((await datatableStore.listAnswersTablesForAutomation('auto_feedback')).length, 1);
});

test('the schema route refuses every list — the form is the only editor of these columns', async () => {
    const meta = await datatableStore.getTableMeta(SC, tableId);
    const res = await call('put', '/:id/schema', as(OWNER, { params: { id: tableId }, body: { fields: meta.fields, expectedVersion: 1 } }));
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'schema_from_definition');
    assert.match(res.body.error, /form/);
    assert.strictEqual(managedFieldsError('form_answers', meta.fields) !== null, true);
    // and "only my own rows" is refused, while retention is allowed
    const own = await call('patch', '/:id', as(OWNER, { params: { id: tableId }, body: { rowScope: 'own' } }));
    assert.strictEqual(own.statusCode, 400, JSON.stringify(own.body));
    assert.strictEqual(own.body.code, 'answers_row_scope');
    const ret = await call('patch', '/:id', as(OWNER, { params: { id: tableId }, body: { retentionDays: 90, retentionField: 'created_at' } }));
    assert.strictEqual(ret.statusCode, 200, JSON.stringify(ret.body));
    assert.strictEqual(ret.body.datatable.retentionDays, 90);
    await call('patch', '/:id', as(OWNER, { params: { id: tableId }, body: { retentionDays: null } }));
});

let firstRowId = null;
test('a submission is a row: the submitter as created_by, "" as NULL, completed at once on a single-page form', async () => {
    const r = await formAnswers.write.recordSubmission({
        automation, definition: automation.definition,
        values: { email: 'anna@example.test', source: 'search', subscribe: true, team: '12', more: '' },
        submitterId: READER,
    });
    assert.ok(r && r.rowId, 'a row id comes back');
    assert.strictEqual(r.datatableId, tableId);
    firstRowId = r.rowId;
    const rows = await realRows(tableKey);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].id, firstRowId);
    assert.strictEqual(rows[0].created_by, READER);
    assert.strictEqual(rows[0].email, 'anna@example.test');
    assert.strictEqual(rows[0].source, 'search');
    assert.strictEqual(rows[0].subscribe, true);
    assert.strictEqual(Number(rows[0].team), 12);
    assert.strictEqual(rows[0].more, null, '"" is NULL, so "skipped" is IS NULL');
    assert.ok(rows[0].completed_at, 'no further pages → complete at once');
    const t = await datatableStore.getDatatable(tableId, SC);
    assert.strictEqual(t.rowCount, 1);
    // the run, once it exists, is attached to the row
    await formAnswers.write.attachRun({ automation, datatableId: tableId, rowId: firstRowId, run: { id: 'run_1', rootRunId: null } });
    assert.strictEqual((await realRows(tableKey))[0].run_id, 'run_1');
});

test('two more submissions, one without a submitter', async () => {
    await formAnswers.write.recordSubmission({ automation, definition: automation.definition, values: { email: 'bob@example.test', source: 'colleague', subscribe: false, team: '3', more: 'Great onboarding' }, submitterId: OWNER });
    await formAnswers.write.recordSubmission({ automation, definition: automation.definition, values: { email: 'cee@example.test', source: 'search', subscribe: true, team: '', more: 'Please add SSO' }, submitterId: null });
    assert.strictEqual((await realRows(tableKey)).length, 3);
});

test('a relabel renames the column header and moves no data; a retype adds a column and retires the old one', async () => {
    const before = await realRows(tableKey);
    const def = setDefinition(definition([
        Q('email', 'email', 'Work e-mail', { required: true }),
        Q('source', 'select', 'How did you hear about us?', { options: ['search', 'colleague', 'newsletter', 'event'] }),
        Q('subscribe', 'checkbox', 'Subscribe to updates?'),
        Q('team', 'text', 'Team size'),
        Q('more', 'textarea', 'Anything else?'),
    ]));
    const out = await formAnswers.ensureAnswersTable(automation, def);
    assert.strictEqual(out.changed, true);
    const meta = await datatableStore.getTableMeta(SC, tableId);
    const email = meta.fields.find(f => f.key === 'email');
    assert.strictEqual(email.id, fieldIds.email, 'same id');
    assert.strictEqual(email.name, 'Work e-mail', 'new header');
    assert.deepStrictEqual(meta.fields.find(f => f.key === 'source').options, ['search', 'colleague', 'newsletter', 'event'], 'options grew');
    assert.deepStrictEqual(meta.fields.map(f => f.key), ['run_id', 'completed_at', 'email', 'source', 'subscribe', 'team_2', 'more', 'team'], 'the retyped column is new, the old one is last');
    const src = out.table.source.columnMap;
    assert.strictEqual(src[fieldIds.team].retired, true, 'the numeric "team" is retired');
    assert.strictEqual(meta.fields.find(f => f.key === 'team_2').type, 'text');
    const after = await realRows(tableKey);
    assert.deepStrictEqual(after.map(r => [r.id, r.email, Number(r.team)]), before.map(r => [r.id, r.email, Number(r.team)]), 'no row moved');
    // a new submission writes the new column; the retired one stays as it was
    await formAnswers.write.recordSubmission({ automation, definition: def, values: { email: 'dee@example.test', source: 'event', subscribe: false, team: 'about ten', more: '' }, submitterId: READER });
    const last = (await realRows(tableKey))[3];
    assert.strictEqual(last.team_2, 'about ten');
    assert.strictEqual(last.team, null);
});

test('a removed question keeps its column, retired, answers intact', async () => {
    const def = setDefinition(definition([
        Q('email', 'email', 'Work e-mail', { required: true }),
        Q('source', 'select', 'How did you hear about us?', { options: ['search', 'colleague', 'newsletter', 'event'] }),
        Q('team', 'text', 'Team size'),
        Q('more', 'textarea', 'Anything else?'),
    ]));
    const out = await formAnswers.ensureAnswersTable(automation, def);
    assert.strictEqual(out.changed, true);
    const meta = await datatableStore.getTableMeta(SC, tableId);
    assert.ok(meta.fields.some(f => f.key === 'subscribe'), 'the column is still there');
    assert.strictEqual(out.table.source.columnMap[fieldIds.subscribe].retired, true);
    assert.strictEqual((await realRows(tableKey)).filter(r => r.subscribe === true).length, 2, 'the answers are intact');
    const pub = await call('get', '/:id', as(OWNER, { params: { id: tableId } }));
    assert.deepStrictEqual(pub.body.datatable.source.columns.filter(c => c.retired).map(c => c.key).sort(), ['subscribe', 'team']);
});

test('the summary counts what the caller may see: the owner sees everything, a stranger nothing, a shared reader the same numbers', async () => {
    const res = await call('get', '/:id/answers/summary', as(OWNER, { params: { id: tableId }, query: {} }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const s = res.body;
    assert.strictEqual(s.table.id, tableId);
    assert.strictEqual(s.form.automationId, 'auto_feedback');
    assert.strictEqual(s.form.title, 'Customer feedback');
    assert.strictEqual(s.form.mine, true);
    assert.match(s.form.url, /^\/f\//);
    assert.strictEqual(s.range.bucket, 'day');
    assert.deepStrictEqual([s.totals.all, s.totals.inRange, s.totals.last7d, s.totals.today, s.totals.completed, s.totals.open], [4, 4, 4, 4, 4, 0]);
    assert.ok(s.totals.lastAt);
    assert.strictEqual(s.timeline.length, 1);
    assert.strictEqual(s.timeline[0].n, 4);
    const byKey = Object.fromEntries(s.questions.map(q => [q.key, q]));
    assert.deepStrictEqual(s.questions.map(q => q.key), ['email', 'source', 'team_2', 'more', 'team', 'subscribe'], 'form order, then the retired in the order they were retired');
    assert.strictEqual(byKey.subscribe.retired, true);
    assert.strictEqual(byKey.source.breakdown.kind, 'choice');
    assert.deepStrictEqual(byKey.source.breakdown.values.map(v => [v.value, v.n]), [['search', 2], ['colleague', 1], ['event', 1]]);
    assert.strictEqual(byKey.source.breakdown.values[0].pct, 50);
    assert.deepStrictEqual(byKey.subscribe.breakdown, { kind: 'yesno', yes: 2, no: 2 });
    assert.strictEqual(byKey.team.breakdown.kind, 'number');
    assert.deepStrictEqual([byKey.team.breakdown.min, byKey.team.breakdown.max, byKey.team.breakdown.avg], [3, 12, 7.5]);
    assert.strictEqual(byKey.team.answered, 2);
    assert.strictEqual(byKey.team.skipped, 2);
    assert.strictEqual(byKey.more.breakdown.kind, 'text');
    assert.deepStrictEqual(byKey.more.breakdown.recent.map(r => r.value).sort(), ['Great onboarding', 'Please add SSO']);
    assert.strictEqual(byKey.email.answered, 4);
    assert.strictEqual(s.recent.length, 4);
    const named = s.recent.find(r => r.by && r.by.id === READER);
    assert.strictEqual(named.by.name, 'Rita Reader');
    assert.ok(s.recent.some(r => r.by === null), 'an anonymous submission has no "by"');
    assert.ok(s.recent.every(r => Object.keys(r.preview).length <= 3));
    assert.strictEqual(s.recent.find(r => r.rowId === firstRowId).runId, 'run_1');

    // a range that excludes everything
    const empty = await call('get', '/:id/answers/summary', as(OWNER, { params: { id: tableId }, query: { from: '2020-01-01', to: '2020-01-31' } }));
    assert.strictEqual(empty.statusCode, 200);
    assert.strictEqual(empty.body.totals.inRange, 0);
    assert.strictEqual(empty.body.totals.all, 4);
    assert.strictEqual(empty.body.range.bucket, 'day');
    const bad = await call('get', '/:id/answers/summary', as(OWNER, { params: { id: tableId }, query: { from: '2026-02-01', to: '2026-01-01' } }));
    assert.strictEqual(bad.statusCode, 400);
    assert.strictEqual(bad.body.code, 'bad_range');

    // nobody else, until the table is shared
    const stranger = await call('get', '/:id/answers/summary', as(STRANGER, { params: { id: tableId } }));
    assert.strictEqual(stranger.statusCode, 404, 'no grade = the table does not exist for them');
    const grant = await call('post', '/:id/grants', as(OWNER, { params: { id: tableId }, body: { granteeType: 'user', granteeId: READER, grade: 'viewer' } }));
    assert.strictEqual(grant.statusCode, 200, JSON.stringify(grant.body));
    const reader = await call('get', '/:id/answers/summary', as(READER, { params: { id: tableId } }));
    assert.strictEqual(reader.statusCode, 200, JSON.stringify(reader.body));
    assert.strictEqual(reader.body.totals.all, 4);
    assert.strictEqual(reader.body.form.mine, false);
    assert.strictEqual(reader.body.recent.find(r => r.rowId === firstRowId).runId, 'run_1', 'a reader may see the run id of a shared table');
});

test('the generic aggregate answers a validated descriptor and refuses a bad one', async () => {
    const ok = await call('post', '/:id/aggregate', as(READER, { params: { id: tableId }, body: { groupBy: [{ field: 'source' }], aggregates: [{ fn: 'count', field: '*', as: 'n' }], sort: [{ field: 'n', dir: 'desc' }] } }));
    assert.strictEqual(ok.statusCode, 200, JSON.stringify(ok.body));
    assert.deepStrictEqual(ok.body.rows.map(r => [r.source, Number(r.n)]), [['search', 2], ['colleague', 1], ['event', 1]]);
    const byDay = await call('post', '/:id/aggregate', as(READER, { params: { id: tableId }, body: { groupBy: [{ field: 'created_at', bucket: 'day', as: 'd' }], aggregates: [{ fn: 'count' }] } }));
    assert.strictEqual(byDay.statusCode, 200, JSON.stringify(byDay.body));
    assert.strictEqual(byDay.body.rows.length, 1);
    for (const [body, code] of [
        [{}, 'bad_descriptor'],
        [{ groupBy: [{ field: 'nope' }] }, 'unknown_filter_field'],
        [{ aggregates: [{ fn: 'median', field: 'team' }] }, 'unknown_agg_fn'],
        [{ groupBy: [{ field: 'created_at', bucket: 'fortnight' }] }, 'unknown_bucket'],
    ]) {
        const res = await call('post', '/:id/aggregate', as(READER, { params: { id: tableId }, body }));
        assert.strictEqual(res.statusCode, 400, JSON.stringify(res.body));
        assert.strictEqual(res.body.code, code);
    }
});

test('a multi-page journey: the row is open until the last page, then complete', async () => {
    const def = setDefinition(definition([
        Q('email', 'email', 'Work e-mail', { required: true }),
        Q('source', 'select', 'How did you hear about us?', { options: ['search', 'colleague', 'newsletter', 'event'] }),
        Q('team', 'text', 'Team size'),
        Q('more', 'textarea', 'Anything else?'),
    ], { pages: [{ id: 'page2', fields: [Q('rating', 'number', 'Rating')] }] }));
    const out = await formAnswers.ensureAnswersTable(automation, def);
    const meta = await datatableStore.getTableMeta(SC, tableId);
    assert.ok(meta.fields.some(f => f.key === 'rating'), 'the page-2 question is a column');
    const r = await formAnswers.write.recordSubmission({ automation, definition: def, values: { email: 'eve@example.test', source: 'newsletter', team: '', more: '' }, submitterId: READER });
    let row = (await realRows(tableKey)).find(x => x.id === r.rowId);
    assert.strictEqual(row.completed_at, null, 'page 2 is still to come');
    const patched = await formAnswers.write.recordPageAnswers({ automation, datatableId: tableId, rowId: r.rowId, pageStepId: 'page2', values: { rating: '4' } });
    assert.strictEqual(patched, true);
    row = (await realRows(tableKey)).find(x => x.id === r.rowId);
    assert.strictEqual(Number(row.rating), 4);
    assert.strictEqual(row.completed_at, null);
    await formAnswers.write.markCompleted({ automation, datatableId: tableId, rowId: r.rowId });
    row = (await realRows(tableKey)).find(x => x.id === r.rowId);
    assert.ok(row.completed_at);
    const s = await call('get', '/:id/answers/summary', as(OWNER, { params: { id: tableId } }));
    assert.deepStrictEqual([s.body.totals.inRange, s.body.totals.completed, s.body.totals.open], [5, 5, 0]);
    assert.ok(out.table);
});

test('a retired column can be dropped by the owner, never a live one, never by a reader', async () => {
    const live = await call('delete', '/:id/answers/columns/:fieldId', as(OWNER, { params: { id: tableId, fieldId: fieldIds.email } }));
    assert.strictEqual(live.statusCode, 409);
    assert.strictEqual(live.body.code, 'column_live');
    const reader = await call('delete', '/:id/answers/columns/:fieldId', as(READER, { params: { id: tableId, fieldId: fieldIds.subscribe } }));
    assert.strictEqual(reader.statusCode, 403, JSON.stringify(reader.body));
    const unknown = await call('delete', '/:id/answers/columns/:fieldId', as(OWNER, { params: { id: tableId, fieldId: 'fld_fanope' } }));
    assert.strictEqual(unknown.statusCode, 404);
    const gone = await call('delete', '/:id/answers/columns/:fieldId', as(OWNER, { params: { id: tableId, fieldId: fieldIds.subscribe } }));
    assert.strictEqual(gone.statusCode, 200, JSON.stringify(gone.body));
    assert.ok(!gone.body.fields.some(f => f.key === 'subscribe'));
    assert.ok(!gone.body.source.columns.some(c => c.key === 'subscribe'));
    assert.ok(!(await columnsOf(tableKey)).some(c => c.column_name === 'subscribe'), 'the physical column is gone');
    assert.strictEqual((await realRows(tableKey)).length, 5, 'the rows are not');
});

test('the write path never fails a submission: a table the automation may not write is reported, not thrown', async () => {
    const other = { ...automation, id: 'auto_other', userId: STRANGER, organizationId: ORG };
    // point the stranger's automation at the owner's table by id: the resolver refuses
    const r = await formAnswers.write.recordPageAnswers({ automation: other, datatableId: tableId, rowId: firstRowId, pageStepId: 'page2', values: { rating: '1' } });
    assert.strictEqual(r, false);
    const row = (await realRows(tableKey)).find(x => x.id === firstRowId);
    assert.strictEqual(row.rating, null, 'nothing was written');
});

test('collect:false unlinks the table and keeps it; the release route then makes it ordinary; delete-the-form releases too', async () => {
    const def = setDefinition(definition([Q('email', 'email', 'Work e-mail')], { collect: false }));
    const out = await formAnswers.ensureAnswersTable(automation, def);
    assert.strictEqual(out, null);
    let t = await datatableStore.getDatatable(tableId, SC);
    assert.strictEqual(t.source.linked, false);
    assert.strictEqual(t.managedKind, 'form_answers');
    assert.strictEqual((await realRows(tableKey)).length, 5, 'rows kept');
    // a submission while unlinked writes nothing
    const r = await formAnswers.write.recordSubmission({ automation, definition: def, values: { email: 'x@example.test' }, submitterId: OWNER });
    assert.strictEqual(r, null);
    // collect back on re-adopts the same table
    const on = await formAnswers.ensureAnswersTable(automation, setDefinition(definition([Q('email', 'email', 'Work e-mail')], { collect: true })));
    assert.strictEqual(on.table.id, tableId);
    assert.strictEqual(on.created, false);
    assert.strictEqual(on.table.source.linked, true);
    // release is refused while linked
    const refused = await call('post', '/:id/answers/release', as(OWNER, { params: { id: tableId } }));
    assert.strictEqual(refused.statusCode, 409);
    assert.strictEqual(refused.body.code, 'still_linked');
    // deleting the form releases the table: an ordinary table now, rows kept
    const released = await formAnswers.releaseAnswersTables(automation);
    assert.deepStrictEqual(released, [tableId]);
    t = await datatableStore.getDatatable(tableId, SC);
    assert.strictEqual(t.managedKind, null);
    assert.strictEqual(t.source, null);
    assert.strictEqual((await realRows(tableKey)).length, 5);
    const summary = await call('get', '/:id/answers/summary', as(OWNER, { params: { id: tableId } }));
    assert.strictEqual(summary.statusCode, 404, 'no longer an answers table');
});
