'use strict';

/**
 * Record triggers end to end, against the REAL trigger, run and outbox stores on PGlite with a
 * fake clock (testUtils/triggerHarness.testkit.js): what a write records, what a pass delivers,
 * and the two controls of recordTriggerRule.mts as matrices: who may start an owner-level run,
 * and how far a chain of trigger runs goes.
 *
 * The app's own rows live in a small in-memory table here; the write path's real SQL is covered
 * by actionExecutor/records.recordTrigger.test.js and, for the writes of several rows,
 * actionExecutor/records.recordTriggerRows.test.js. Here such a write is the segments its path
 * hands recordCapture.mts.
 *
 * Run: cd server && node --test appStudio/triggers/recordTriggers.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { triggerHarness } = require('../../testUtils/triggerHarness.testkit');
const { studioRunTableDdl } = require('../../testUtils/studioRunTables');
const { makeRecordEventStore } = require('../../stores/studioAppData/recordEvents.mts');
const { writeThrough, _setOutboxDeps, changedFields } = require('./recordOutbox.mts');
const { planCapture } = require('./recordCapture.mts');
const { recordEventPass, resumeScope } = require('./recordDrain.mts');
const { recordTriggerLimits } = require('./recordTriggerLimits.mts');
const {
    deliveryRefusal, writerKindOf, writerKeyOf, readWriteSource, publicWritableEvents, needsPublicOptIn, chainOriginOf, chainRefusedKinds,
    PUBLIC_REFUSED_KINDS, INBOUND_REFUSED_KINDS, UNKNOWN_DEPTH,
} = require('./recordTriggerRule.mts');
const { triggerCtx } = require('./runTriggerCtx.mts');
const { validateTriggers } = require('./triggerSpec.mts');
const { armedTriggersOf } = require('./triggerSync.mts');
const { triggerLimits } = require('./triggerLimits.mts');

const h = triggerHarness({ before, after, beforeEach });
const { s, t, publish, unpublish, row, pass, settle, runs } = h;
const events = makeRecordEventStore(h.db);
const quiet = { info() {}, warn() {}, error() {} };

const access = (roles = {}) => ({ default: 'app', roles, rowFilters: {} });
const table = (id, roles) => ({ id: `tbl_${id}`, key: id, fields: [{ key: 'title', type: 'text' }, { key: 'status', type: 'text' }], access: access(roles) });
const TABLES = {
    orders: table('orders'),
    log: table('log'),
    intake: table('intake', { public: { create: true } }),
    open: table('open', { public: { create: true, update: 'all', delete: 'all' } }),
    linked: { ...table('linked'), source: { kind: 'datatable', datatableId: 'dt_1', mode: 'write' } },
};
const MODEL = { tables: Object.values(TABLES) };

const USER = { kind: 'user' };
const OWNER = { id: 'owner', role: 'owner' };
const MEMBER = { id: 'u_mia', role: 'agent' };
const VISITOR = { id: 'anon:9f3c', role: 'public' };

let rl;
/** The app's own rows: table key -> id -> row. */
let data;
const appDb = {
    batch: async (_owner, _app, statements) => statements.map((st, i) => {
        const rowsOf = data[st.table] || (data[st.table] = new Map());
        if (st.op === 'readMany') return { rows: st.ids.filter((id) => rowsOf.has(id)).map((id) => ({ ...rowsOf.get(id) })) };
        if (st.op === 'noop') return { changes: 0 };
        if (st.op === 'fail') throw Object.assign(new Error('no rows'), { code: 'batch_no_rows', statementIndex: i });
        if (st.op === 'read') return { rows: rowsOf.has(st.id) ? [{ ...rowsOf.get(st.id) }] : [] };
        if (st.op === 'create') { rowsOf.set(st.id, { id: st.id, ...st.values }); return { changes: 1 }; }
        if (!rowsOf.has(st.id)) return { changes: 0 };
        if (st.op === 'delete') rowsOf.delete(st.id); else rowsOf.set(st.id, { ...rowsOf.get(st.id), ...st.values });
        return { changes: 1 };
    }),
};
let nextId = 0;

/** One write through the outbox's write-through, as actionExecutor/records.js does it; null when the write went its usual way. */
async function write(tableDef, event, opts = {}) {
    const { id, values = {}, viewer = MEMBER } = opts;
    const source = Object.hasOwn(opts, 'source') ? opts.source : USER;
    const rowId = id || `r${++nextId}`;
    const through = await writeThrough(h.APP, tableDef, source, viewer, appDb);
    const statement = { op: event, table: tableDef.key, id: rowId, values };
    if (!through) { await appDb.batch('owner', 'app_1', [statement]); return { rowId, through: false }; }
    return { rowId, through: true, changes: await through.exec(event, rowId, statement) };
}

const stmt = (op, tb, id, values = {}) => ({ op, table: tb.key, id, values });
/** One segment: `op` on each of `ids` of `tb`, as a write path names the rows it changes. */
const seg = (op, tb, ids, values) => ({ statements: ids.map((id) => stmt(op, tb, id, values)), rows: { table: tb, event: op, ids } });
/** Rows that are simply there (written without an origin). */
function lay(tb, ids) {
    const rowsOf = data[tb.key] || (data[tb.key] = new Map());
    for (const id of ids) rowsOf.set(id, { id, status: 'old' });
}
/** A write of several rows, as its path runs it: through the capture when there is one, else the statements alone. */
async function writeRows(segments, opts = {}) {
    const { viewer = MEMBER } = opts;
    const source = Object.hasOwn(opts, 'source') ? opts.source : USER;
    const capture = await planCapture(h.APP, segments, { source, viewer });
    const run = (statements) => appDb.batch('owner', 'app_1', statements);
    return { captured: !!capture, results: await (capture ? capture.run(run) : run(segments.flatMap((x) => x.statements))) };
}

const outbox = async () => (await h.pg.query('SELECT * FROM studio_app_record_events ORDER BY seq')).rows;
const drainDeps = (over = {}) => ({
    events: () => events, fire: h.fireDeps(), recordLimits: () => rl,
    tableOf: async (_app, _owner, tableId) => MODEL.tables.find((x) => x.id === tableId || x.key === tableId) || null,
    evaluate: (expr, scope) => require('../../shared/expr/index.mjs').tryEvaluate(expr, scope),
    ...over,
});
const drain = (over) => recordEventPass(drainDeps(over));
/** Settle the runs of earlier fires (the job's own pass), then deliver. */
const tick = async () => { await pass(); return drain(); };

const onRecord = (id, tableId, over = {}) => ({ id, kind: 'record', actionId: 'act_job', tableId, on: ['create', 'update', 'delete'], ...over });
const def = (triggers, actions = {}) => ({ schemaVersion: 3, actions: { act_job: { kind: 'sequence', steps: [h.write('log')] }, ...actions }, triggers });

/** Deliver until nothing fires any more; the run each fire started is waited for. Returns the fires. */
async function runToQuiet(max = 12) {
    let fired = 0;
    for (let i = 0; i < max; i += 1) {
        const out = await tick();
        if (!out.fired) return fired;
        fired += out.fired;
        for (const r of await runs()) await settle(r.id);
        s.clock += 1000;
    }
    assert.fail(`still firing after ${max} passes: a loop`);
    return fired;
}

before(async () => { await h.pg.exec(studioRunTableDdl('studio_app_record_events')); });
beforeEach(async () => {
    await h.pg.query('DELETE FROM studio_app_record_events');
    rl = { ...recordTriggerLimits({}) };
    data = {};
    nextId = 0;
    _setOutboxDeps({
        store: () => events, now: () => s.clock, limits: () => rl, log: quiet,
        compileRead: (tb, id) => ({ op: 'read', table: tb.key, id }),
        compileReadMany: (tb, ids) => ({ op: 'readMany', table: tb.key, ids }),
    });
});
after(() => _setOutboxDeps({}));

// ── The write side ──────────────────────────────────────────────────────────

test('a table without an armed record trigger writes its usual way: no write-through, no outbox row', async () => {
    await publish(def([onRecord('on_orders', 'tbl_orders')]));
    assert.equal((await write(TABLES.log, 'create')).through, false);
    assert.deepEqual(await outbox(), []);
});

test('a draft arms nothing: a record trigger of an unpublished app records no change', async () => {
    t.app.definition = def([onRecord('on_orders', 'tbl_orders')]);
    assert.equal((await write(TABLES.orders, 'create')).through, false);
    await publish(t.app.definition);
    assert.equal((await write(TABLES.orders, 'create')).through, true);
    await unpublish();
    assert.equal((await write(TABLES.orders, 'create')).through, false, 'an unpublish forgets the armed list at once');
    assert.equal((await outbox()).length, 1);
});

test('a write that names no origin never records, whatever the table (seeding, sync, builder tools, imports)', async () => {
    await publish(def([onRecord('on_orders', 'tbl_orders')]));
    for (const source of [undefined, null, {}, { kind: 'seed' }, 'user']) {
        assert.equal((await write(TABLES.orders, 'create', { source })).through, false, JSON.stringify(source));
    }
    assert.deepEqual(await outbox(), []);
});

test('create, update and delete record the row as it was and as it is; a write that touched no row records nothing', async () => {
    await publish(def([onRecord('on_orders', 'tbl_orders')]));
    const { rowId } = await write(TABLES.orders, 'create', { values: { title: 'A', status: 'new' } });
    await write(TABLES.orders, 'update', { id: rowId, values: { status: 'done' } });
    assert.equal((await write(TABLES.orders, 'update', { id: 'nope', values: { status: 'x' } })).changes, 0);
    await write(TABLES.orders, 'delete', { id: rowId });
    const got = (await outbox()).map((e) => [e.event, e.row_id, e.row_before, e.row_after, e.writer_kind, e.depth]);
    assert.deepEqual(got, [
        ['create', rowId, null, { id: rowId, title: 'A', status: 'new' }, 'member', 0],
        ['update', rowId, { id: rowId, title: 'A', status: 'new' }, { id: rowId, title: 'A', status: 'done' }, 'member', 0],
        ['delete', rowId, { id: rowId, title: 'A', status: 'done' }, null, 'member', 0],
    ]);
});

test('the outbox names no account: the writer is a kind and a one-way key', async () => {
    await publish(def([onRecord('on_orders', 'tbl_orders')]));
    await write(TABLES.orders, 'create', { viewer: MEMBER });
    const [e] = await outbox();
    assert.equal(e.writer_kind, 'member');
    assert.match(e.writer_key, /^[0-9a-f]{32}$/);
    assert.ok(!JSON.stringify(e).includes('u_mia'));
});

test('a table linked to a Studio table never records, and the validator and the fire refuse it', async () => {
    await publish(def([onRecord('on_linked', 'tbl_linked')]));
    assert.equal((await write(TABLES.linked, 'create')).through, false);
    assert.equal(deliveryRefusal({ event: 'create', writerKind: 'member', depth: 0, causeTriggerId: null }, { triggerId: 'x', on: ['create'], allowPublicWrites: true }, TABLES.linked, 3).code, 'linked_table');
    const errors = [];
    validateTriggers([onRecord('on_linked', 'tbl_linked')], { def: def([]), dataModel: MODEL, pushE: (f) => errors.push(f.code), pushW() {} });
    assert.deepEqual(errors, ['triggers.record_linked_table']);
});

// ── The fire ────────────────────────────────────────────────────────────────

test('a change starts the action as the app owner, with the change as the trigger root and no account in it', async () => {
    await publish(def([onRecord('on_orders', 'tbl_orders')]));
    const { rowId } = await write(TABLES.orders, 'create', { values: { title: 'A', status: 'new' }, viewer: MEMBER });
    assert.deepEqual(await drain(), { ready: 1, fired: 1, skipped: 0, expired: 0 });
    const armed = await row('on_orders');
    const run = await settle(armed.lastRunId);
    assert.equal(run.status, 'success');
    assert.equal(run.viewerUserId, 'owner');
    const { ctx } = s.executed[0];
    assert.equal(ctx.viewerId, 'owner');
    assert.equal(ctx.role, 'owner');
    assert.deepEqual(ctx.trigger, { kind: 'record', record: {
        triggerId: 'on_orders', event: 'create', tableId: 'tbl_orders', id: rowId,
        row: { id: rowId, title: 'A', status: 'new' }, before: null, changed: [], by: 'member', depth: 0 },
    });
    assert.deepEqual(ctx.writeSource, { kind: 'trigger', depth: 1, triggerId: 'on_orders' });
    const [e] = await outbox();
    assert.equal(e.state, 'fired');
    assert.equal(e.run_id, armed.lastRunId);
});

test('a trigger takes its changes one at a time and in the order they were written', async () => {
    await publish(def([onRecord('on_orders', 'tbl_orders')]));
    const a = await write(TABLES.orders, 'create', { values: { title: 'first' } });
    await write(TABLES.orders, 'update', { id: a.rowId, values: { title: 'second' } });
    await write(TABLES.orders, 'update', { id: a.rowId, values: { title: 'third' } });
    assert.equal((await drain()).fired, 1);
    assert.equal((await drain()).ready, 0, 'the run of the first is still to be settled: the trigger is not ready');
    await runToQuiet();
    assert.deepEqual(s.executed.map((x) => [x.ctx.trigger.record.event, x.ctx.trigger.record.row.title]), [['create', 'first'], ['update', 'second'], ['update', 'third']]);
});

test('two instances that take the same change start one run (the claim is a compare-and-set)', async () => {
    await publish(def([onRecord('on_orders', 'tbl_orders')]));
    await write(TABLES.orders, 'create');
    const [ready] = await events.listReady(10);
    const [first, second] = await Promise.all([events.claim(ready.seq, s.clock), events.claim(ready.seq, s.clock)]);
    assert.equal([first, second].filter(Boolean).length, 1);
    assert.deepEqual(await drain(), { ready: 0, fired: 0, skipped: 0, expired: 0 }, 'a claimed change is never handed out again');
    assert.deepEqual(await runs(), []);
});

test('watched fields and the when formula decide quietly; a formula that fails starts nothing and says so', async () => {
    await publish(def([
        onRecord('on_status', 'tbl_orders', { on: ['update'], fields: ['status'] }),
        onRecord('on_done', 'tbl_orders', { on: ['update'], when: 'trigger.record.row.status == "done"' }),
        onRecord('on_broken', 'tbl_orders', { on: ['update'], when: 'trigger.record.row.status.' }),
    ]));
    const a = await write(TABLES.orders, 'create', { values: { title: 'A', status: 'new' } });
    await write(TABLES.orders, 'update', { id: a.rowId, values: { title: 'B' } });
    assert.deepEqual(await drain(), { ready: 3, fired: 0, skipped: 3, expired: 0 });
    assert.equal((await row('on_status')).lastStatus, null, 'an unchanged field is the trigger working, not a skipped fire');
    assert.equal((await row('on_done')).lastStatus, null);
    assert.equal((await row('on_broken')).lastStatus, 'skipped');
    assert.match((await row('on_broken')).lastError, /when formula/);
    await write(TABLES.orders, 'update', { id: a.rowId, values: { status: 'done' } });
    assert.equal((await drain()).fired, 2);
});

test('the when formula runs inside the engine\'s work budget: one that exceeds it starts nothing', async () => {
    await publish(def([onRecord('on_orders', 'tbl_orders', { when: 'trigger.record.row.title == "x"' })]));
    await write(TABLES.orders, 'create', { values: { title: 'x' } });
    const out = await drain({ evaluate: () => ({ value: undefined, error: 'One formula produced more than 10 items (EXPR_MAX_WORK=10)' }) });
    assert.equal(out.fired, 0);
    assert.equal((await row('on_orders')).lastStatus, 'skipped');
    assert.ok(!(await row('on_orders')).lastError.includes('EXPR_MAX_WORK'), 'the reason is ours, not the engine text');
});

// ── Control 1: who may start an owner-level run ─────────────────────────────

test('matrix: which writer on which table starts a run', async () => {
    const cases = [
        // table,   writer,  opt-in, fires
        ['orders', MEMBER, false, true],
        ['orders', OWNER, false, true],
        ['orders', VISITOR, false, false],
        ['orders', VISITOR, true, true],
        ['orders', { id: 'u_x', role: 'public' }, false, false], // the public role, whatever the id
        ['orders', { id: 'anon:1', role: 'agent' }, false, false], // an anonymous id, whatever the role
        ['orders', { role: 'agent' }, false, false], // no id
        ['intake', VISITOR, false, false],
        ['intake', MEMBER, false, false], // the TABLE is open to visitors: a member's row is not told apart
        ['intake', OWNER, false, false],
        ['intake', VISITOR, true, true],
        ['intake', MEMBER, true, true],
    ];
    for (const [key, viewer, optIn, fires] of cases) {
        await h.pg.query('DELETE FROM studio_app_record_events');
        await h.pg.query('DELETE FROM studio_app_action_runs');
        await publish(def([onRecord('on_it', `tbl_${key}`, optIn ? { allowPublicWrites: true } : {})]));
        await write(TABLES[key], 'create', { viewer });
        const label = `${key} / ${JSON.stringify(viewer)} / allowPublicWrites=${optIn}`;
        assert.equal((await outbox()).length, fires ? 1 : 0, `${label}: recorded`);
        assert.equal((await drain()).fired, fires ? 1 : 0, `${label}: fired`);
        if (!fires) assert.match((await row('on_it')).lastError || '', /allowPublicWrites/, `${label}: the trigger says why`);
        for (const r of await runs()) await settle(r.id);
        await unpublish();
    }
});

test('the fire asks the rule again: a table opened to visitors after the change was recorded starts nothing', async () => {
    await publish(def([onRecord('on_orders', 'tbl_orders')]));
    await write(TABLES.orders, 'create', { viewer: MEMBER });
    const opened = { ...TABLES.orders, access: access({ public: { create: true } }) };
    assert.deepEqual(await drain({ tableOf: async () => opened }), { ready: 1, fired: 0, skipped: 1, expired: 0 });
    const armed = await row('on_orders');
    assert.equal(armed.lastStatus, 'skipped');
    assert.match(armed.lastError, /allowPublicWrites/);
    const [e] = await outbox();
    assert.deepEqual([e.state, e.outcome_code, e.row_after], ['skipped', 'public_write', null], 'a skipped change drops its row values at once');
});

test('the public-table rule in the validator and at arming: opt-in is required, and then the action is held to the stricter list', () => {
    const findings = (trigger, steps) => {
        const out = [];
        validateTriggers([trigger], { def: def([], { act_job: { kind: 'sequence', steps } }), dataModel: MODEL, pushE: (f) => out.push(f.code), pushW() {} });
        return out;
    };
    const plain = [h.write('log')];
    assert.deepEqual(findings(onRecord('a', 'tbl_orders'), plain), []);
    assert.deepEqual(findings(onRecord('a', 'tbl_intake'), plain), ['triggers.record_public_table']);
    assert.deepEqual(findings(onRecord('a', 'tbl_intake', { on: ['delete'] }), plain), [], 'visitors cannot delete here, so a delete trigger needs no opt-in');
    assert.deepEqual(findings(onRecord('a', 'tbl_intake', { allowPublicWrites: true }), plain), []);
    assert.deepEqual(findings(onRecord('a', 'tbl_nope'), plain), ['triggers.record_table_unknown']);
    for (const kind of PUBLIC_REFUSED_KINDS) {
        const step = { kind, tableId: 'log' };
        assert.deepEqual(findings(onRecord('a', 'tbl_intake', { allowPublicWrites: true }), [step]), ['triggers.step_not_unattended'], kind);
        assert.deepEqual(findings(onRecord('a', 'tbl_orders'), [step]), [], `${kind} without the opt-in stays allowed`);
        const armedDef = def([onRecord('a', 'tbl_intake', { allowPublicWrites: true })], { act_job: { kind: 'sequence', steps: [step] } });
        assert.deepEqual(armedTriggersOf(armedDef, 0, triggerLimits({})), [], `${kind}: not armed`);
    }
    assert.deepEqual(publicWritableEvents(TABLES.intake), ['create']);
    assert.equal(needsPublicOptIn(TABLES.orders, ['create', 'update', 'delete']), false);
});

test('the writer is read from the viewer, never from what the write says', () => {
    const src = readWriteSource({ kind: 'trigger', depth: 0, triggerId: 'x' });
    assert.equal(writerKindOf(src, VISITOR, 'owner'), 'public', 'a visitor stays public behind a trigger source');
    assert.equal(writerKindOf(src, OWNER, 'owner'), 'trigger');
    assert.equal(writerKindOf(USER, OWNER, 'owner'), 'owner');
    assert.equal(writerKindOf(USER, { id: 'owner', role: 'agent' }, 'owner'), 'member');
    assert.equal(writerKindOf(USER, null, 'owner'), 'public');
    assert.equal(readWriteSource({ kind: 'trigger' }).depth, UNKNOWN_DEPTH, 'a trigger write without a readable depth is beyond every limit');
    assert.equal(readWriteSource({ kind: 'owner' }), null);
});

test('one writer cannot start more runs per minute than the burst limit; the trigger says so, and another writer still can', async () => {
    rl.writerBurst = 2;
    t.limits.runsPerApp = 0;
    await publish(def([onRecord('a', 'tbl_orders', { on: ['create'] }), onRecord('b', 'tbl_orders', { on: ['create'] }), onRecord('c', 'tbl_orders', { on: ['create'] })]));
    await write(TABLES.orders, 'create', { viewer: MEMBER });
    const out = await drain();
    assert.deepEqual([out.fired, out.skipped], [2, 1]);
    const held = (await Promise.all(['a', 'b', 'c'].map((id) => row(id)))).filter((r) => r.lastStatus === 'skipped');
    assert.equal(held.length, 1);
    assert.match(held[0].lastError, /STUDIO_APP_RECORD_TRIGGER_WRITER_BURST=2/);
    for (const r of await runs()) await settle(r.id);
    await pass();
    await write(TABLES.orders, 'create', { viewer: { id: 'u_ben', role: 'agent' } });
    assert.equal((await drain()).fired, 2, 'the limit is per writer');
});

test('visitors of public pages are one writer for the burst limit, whatever id each visit carries', async () => {
    assert.equal(writerKeyOf('public', { id: 'anon:1', role: 'public' }, 'app_1'), writerKeyOf('public', { id: 'anon:2', role: 'public' }, 'app_1'));
    assert.notEqual(writerKeyOf('member', MEMBER, 'app_1'), writerKeyOf('member', { id: 'u_ben', role: 'agent' }, 'app_1'));
    rl.writerBurst = 1;
    await publish(def([onRecord('on_intake', 'tbl_intake', { on: ['create'], allowPublicWrites: true })]));
    await write(TABLES.intake, 'create', { viewer: { id: 'anon:aaaa', role: 'public' } });
    assert.equal((await drain()).fired, 1);
    for (const r of await runs()) await settle(r.id);
    await pass();
    await write(TABLES.intake, 'create', { viewer: { id: 'anon:bbbb', role: 'public' } });
    assert.deepEqual([(await drain()).fired, (await row('on_intake')).lastStatus], [0, 'skipped']);
    assert.match((await row('on_intake')).lastError, /STUDIO_APP_RECORD_TRIGGER_WRITER_BURST=1/);
});

// ── Rule 6: a chain keeps its start ─────────────────────────────────────────

test('a run that a visitor\'s write could start writes as public again: the next trigger needs the opt-in too', async () => {
    assert.ok(PUBLIC_REFUSED_KINDS.includes('http_request'), 'a step a public page may not run is not run for a visitor by a trigger either');
    for (const [optIn, fires] of [[false, 0], [true, 1]]) {
        await h.pg.query('DELETE FROM studio_app_record_events');
        s.executed.length = 0;
        await publish(def([
            onRecord('on_intake', 'tbl_intake', { on: ['create'], allowPublicWrites: true }),
            onRecord('on_log', 'tbl_log', { on: ['create'], actionId: 'act_tell', ...(optIn ? { allowPublicWrites: true } : {}) }),
        ], { act_tell: { kind: 'sequence', steps: [h.write('orders')] } }));
        await write(TABLES.intake, 'create', { viewer: VISITOR });
        assert.equal((await drain()).fired, 1);
        await settle((await row('on_intake')).lastRunId);
        const { ctx } = s.executed[0];
        assert.deepEqual(ctx.writeSource, { kind: 'trigger', depth: 1, triggerId: 'on_intake', origin: 'public' });
        // The run's own write, as actionExecutor/records.js hands it on.
        await write(TABLES.log, 'create', { source: readWriteSource(ctx.writeSource), viewer: OWNER });
        const recorded = (await outbox()).filter((e) => e.trigger_id === 'on_log').map((e) => [e.writer_kind, e.writer_key, e.depth]);
        assert.deepEqual(recorded, optIn ? [['public', null, 1]] : [], `allowPublicWrites=${optIn}: recorded`);
        await pass();
        assert.equal((await drain()).fired, fires, `allowPublicWrites=${optIn}: fired`);
        if (!fires) assert.match((await row('on_log')).lastError, /allowPublicWrites/);
        for (const r of await runs()) await settle(r.id);
        await unpublish();
    }
});

test('a chain a webhook delivery started runs no http_request further down, at the fire and after a wait', async () => {
    const CALL = { kind: 'http_request', connectorId: 'conn_ab12cd', method: 'GET', path: '/v1/orders' };
    // What a webhook trigger's run hands its record writes.
    const webhookRun = { unattended: { refusedKinds: ['http_request'], start: 'webhook' }, scope: { trigger: { kind: 'webhook', webhook: { body: { kind: 'record', record: { by: 'member', depth: 0 } } } } } };
    const source = triggerCtx(webhookRun).writeSource;
    assert.deepEqual(source, { kind: 'trigger', depth: 1, triggerId: null, origin: 'webhook' }, 'nothing in the body changes the chain');
    assert.equal(chainOriginOf(null, { kind: 'record', record: { by: 'webhook' } }), 'webhook');
    assert.equal(chainOriginOf('webhook', { kind: 'record', record: { by: 'public' } }), 'public', 'of two starts the stricter one counts');
    assert.equal(chainOriginOf(null, { kind: 'record', record: { by: 'member' } }), null);

    await publish(def([onRecord('calls_out', 'tbl_orders', { on: ['create'], actionId: 'act_call' }), onRecord('plain', 'tbl_orders', { on: ['create'] })],
        { act_call: { kind: 'sequence', steps: [CALL] } }));
    await write(TABLES.orders, 'create', { source: readWriteSource(source), viewer: OWNER });
    assert.deepEqual((await outbox()).map((e) => [e.trigger_id, e.writer_kind, e.writer_key]), [['calls_out', 'webhook', null], ['plain', 'webhook', null]]);
    const out = await drain();
    assert.deepEqual([out.fired, out.skipped], [1, 1]);
    const refused = await row('calls_out');
    assert.equal(refused.lastStatus, 'refused');
    assert.match(refused.lastError, /http_request/);
    const run = await settle((await row('plain')).lastRunId);
    assert.equal(run.status, 'success');
    assert.equal(s.executed.at(-1).ctx.writeSource.origin, 'webhook', 'the run it did start carries the start on');
    assert.deepEqual(chainRefusedKinds(s.executed.at(-1).ctx.trigger), INBOUND_REFUSED_KINDS, 'and refuses the step again while it runs and when it goes on after a wait');
    assert.deepEqual(chainRefusedKinds({ kind: 'record', record: { by: null, depth: UNKNOWN_DEPTH } }), INBOUND_REFUSED_KINDS, 'a chain that cannot be read refuses it too');
    assert.deepEqual(chainRefusedKinds({ kind: 'record', record: { by: 'member', depth: 0 } }), []);

    // The same change written by a member starts both.
    for (const r of await runs()) await settle(r.id);
    await pass();
    await write(TABLES.orders, 'create', { viewer: MEMBER });
    assert.equal(await runToQuiet(), 2);
});

test('back-pressure: a change beyond the pending limit of the app is dropped and the trigger says so; the per-app fire limit still holds', async () => {
    rl.maxPending = 2;
    await publish(def([onRecord('on_orders', 'tbl_orders')]));
    for (let i = 0; i < 4; i += 1) await write(TABLES.orders, 'create');
    assert.equal((await outbox()).length, 2);
    assert.match((await row('on_orders')).lastError, /STUDIO_APP_RECORD_TRIGGER_MAX_PENDING=2/);
    t.limits.firesPerHour = 1;
    assert.equal(await runToQuiet(), 1);
    assert.match((await row('on_orders')).lastError, /STUDIO_APP_TRIGGER_FIRES_PER_HOUR=1/);
});

// ── Writes of several rows (recordCapture.mts) ──────────────────────────────

/** Per write path: what it does on `tb`, and how many rows of `tb` it changes. */
const PATHS = {
    'one row': async (tb, by) => { await write(tb, 'create', by); return 1; },
    'upsert (a create, then an update of that row)': async (tb, by) => {
        const { rowId } = await write(tb, 'create', by);
        await write(tb, 'update', { ...by, id: rowId, values: { status: 'new' } });
        return 2;
    },
    'batch create': async (tb, by) => { await writeRows([seg('create', tb, ['n1', 'n2', 'n3'])], by); return 3; },
    'update by filter': async (tb, by) => { lay(tb, ['a', 'b']); await writeRows([seg('update', tb, ['a', 'b'], { status: 'new' })], by); return 2; },
    'delete by filter': async (tb, by) => { lay(tb, ['a', 'b']); await writeRows([seg('delete', tb, ['a', 'b'])], by); return 2; },
    'transaction (by id, with a filter child that names no rows)': async (tb, by) => {
        lay(tb, ['a', 'b']);
        await writeRows([seg('create', tb, ['n1']), seg('update', tb, ['a'], { status: 'new' }), { statements: [stmt('update', tb, 'b', { status: 'held' })] }, seg('delete', tb, ['a'])], by);
        return 3;
    },
    'replace': async (tb, by) => { lay(tb, ['a']); await writeRows([seg('delete', tb, ['a']), seg('create', tb, ['n1', 'n2'])], by); return 3; },
    'cascade delete (the children)': async (tb, by) => { lay(tb, ['a', 'b']); lay(TABLES.log, ['root']); await writeRows([seg('delete', tb, ['a', 'b']), seg('delete', TABLES.log, ['root'])], by); return 2; },
    'set-null (the children)': async (tb, by) => { lay(tb, ['a', 'b']); lay(TABLES.log, ['root']); await writeRows([seg('update', tb, ['a', 'b'], { status: null }), seg('delete', TABLES.log, ['root'])], by); return 2; },
};

test('matrix: writer x write path x table open to visitors or not x opt-in: which rows are recorded and start a run', async () => {
    assert.deepEqual(publicWritableEvents(TABLES.open), ['create', 'update', 'delete']);
    const WRITERS = {
        member: { viewer: MEMBER, kind: 'member' },
        owner: { viewer: OWNER, kind: 'owner' },
        visitor: { viewer: VISITOR, kind: 'public' },
        'a run that a visitor\'s write started': { viewer: OWNER, source: { kind: 'trigger', depth: 1, triggerId: 'on_other', origin: 'public' }, kind: 'public' },
    };
    for (const key of ['orders', 'open']) {
        for (const optIn of [false, true]) {
            await publish(def([onRecord('on_it', `tbl_${key}`, optIn ? { allowPublicWrites: true } : {})]));
            for (const [who, { viewer, source = USER, kind }] of Object.entries(WRITERS)) {
                for (const [path, run] of Object.entries(PATHS)) {
                    await h.pg.query('DELETE FROM studio_app_record_events');
                    await h.pg.query('DELETE FROM studio_app_action_runs');
                    await h.pg.query('UPDATE studio_app_triggers SET last_status = NULL, last_error = NULL');
                    data = {};
                    s.clock += 2 * 3_600_000;
                    const label = `${path} / ${who} / ${key} / allowPublicWrites=${optIn}`;
                    const rows = await run(TABLES[key], { viewer, source });
                    const fires = optIn || (key === 'orders' && kind !== 'public');
                    const got = await outbox();
                    assert.equal(got.length, fires ? rows : 0, `${label}: recorded`);
                    assert.ok(got.every((e) => e.table_id === `tbl_${key}` && e.writer_kind === kind), `${label}: by whom`);
                    if (!fires) assert.match((await row('on_it')).lastError || '', /allowPublicWrites/, `${label}: the trigger says why`);
                    assert.equal((await drain()).fired, fires ? 1 : 0, `${label}: fired, one change at a time`);
                    for (const r of await runs()) await settle(r.id);
                }
            }
            await unpublish();
        }
    }
});

test('a write of several rows records nothing without an origin, on a table without a trigger, or for an event no trigger listens to', async () => {
    await publish(def([onRecord('on_orders', 'tbl_orders', { on: ['create'] })]));
    for (const source of [undefined, null, {}, { kind: 'seed' }]) {
        assert.equal((await writeRows([seg('create', TABLES.orders, ['x'])], { source })).captured, false, JSON.stringify(source));
    }
    assert.equal((await writeRows([seg('create', TABLES.log, ['x'])])).captured, false);
    assert.equal((await writeRows([seg('update', TABLES.orders, ['x'], { status: 'y' })])).captured, false, 'the trigger listens to creates only');
    assert.equal((await writeRows([seg('create', TABLES.linked, ['x'])])).captured, false);
    assert.deepEqual(await outbox(), []);
    assert.equal(data.orders.get('x').status, 'y', 'the statements ran all the same');
});

test('the rows of one write keep their order, and a run\'s rows carry its chain: its own trigger never fires on them', async () => {
    await publish(def([onRecord('on_orders', 'tbl_orders'), onRecord('on_other', 'tbl_orders')]));
    lay(TABLES.orders, ['a']);
    await writeRows([seg('create', TABLES.orders, ['n1', 'n2']), seg('update', TABLES.orders, ['a'], { status: 'new' }), seg('delete', TABLES.orders, ['n1'])],
        { viewer: OWNER, source: { kind: 'trigger', depth: 2, triggerId: 'on_other' } });
    const got = (await outbox()).map((e) => [e.trigger_id, e.event, e.row_id, e.writer_kind, e.depth, e.cause_trigger_id]);
    assert.deepEqual(got, [['create', 'n1'], ['create', 'n2'], ['update', 'a'], ['delete', 'n1']].map(([event, id]) => ['on_orders', event, id, 'trigger', 2, 'on_other']));
    rl.maxDepth = 2;
    await writeRows([seg('create', TABLES.orders, ['n3'])], { viewer: OWNER, source: { kind: 'trigger', depth: 2, triggerId: 'on_third' } });
    assert.equal((await outbox()).length, 4, 'at the depth limit nothing more is recorded');
    assert.match((await row('on_orders')).lastError, /STUDIO_APP_RECORD_TRIGGER_MAX_DEPTH=2/);
});

test('the cap: a write of more rows than a trigger takes from one write records none of them, and the trigger says so', async () => {
    rl.maxRowsPerWrite = 2;
    await publish(def([onRecord('on_orders', 'tbl_orders')]));
    assert.equal((await writeRows([seg('create', TABLES.orders, ['n1', 'n2', 'n3'])])).captured, false);
    assert.deepEqual(await outbox(), [], 'never a part of the rows');
    assert.equal(data.orders.size, 3, 'the write itself ran');
    const armed = await row('on_orders');
    assert.equal(armed.lastStatus, 'skipped');
    assert.match(armed.lastError, /^Skipped: too many rows in one write\. It changed 3 rows.*STUDIO_APP_RECORD_TRIGGER_MAX_ROWS_PER_WRITE=2/);
    // The rows of every segment count together; at the cap the write records.
    assert.equal((await writeRows([seg('create', TABLES.orders, ['n4']), seg('delete', TABLES.orders, ['n1', 'n2'])])).captured, false);
    assert.equal((await writeRows([seg('create', TABLES.orders, ['n5', 'n6'])])).captured, true);
    assert.equal((await outbox()).length, 2);
    // Without a row cap, a write whose reads no longer fit one batch of the app's database (500 statements) records nothing either.
    rl.maxRowsPerWrite = 0;
    const many = Array.from({ length: 499 }, (_, i) => `m${i}`);
    assert.equal((await writeRows([seg('create', TABLES.orders, many)])).captured, false);
    assert.match((await row('on_orders')).lastError, /^Skipped: too many rows in one write\. It changed 499 rows, more than one write can record/);
    assert.equal((await outbox()).length, 2);
});

test('one write of many rows starts no more runs than the limits allow: the pending cap at the write, the writer\'s burst at the fire, and the rest is skipped and shown', async () => {
    Object.assign(rl, { maxRowsPerWrite: 0, maxPending: 5, writerBurst: 2 });
    await publish(def([onRecord('on_orders', 'tbl_orders', { on: ['update'] })]));
    const ids = Array.from({ length: 8 }, (_, i) => `r${i}`);
    lay(TABLES.orders, ids);
    await writeRows([seg('update', TABLES.orders, ids, { status: 'new' })]);
    assert.deepEqual((await outbox()).map((e) => e.row_id), ids.slice(0, 5), 'the first five wait; three were dropped at the write');
    assert.match((await row('on_orders')).lastError, /STUDIO_APP_RECORD_TRIGGER_MAX_PENDING=5/);
    for (let i = 0; i < 8; i += 1) {
        await tick();
        for (const r of await runs()) await settle(r.id);
        s.clock += 1000;
    }
    assert.deepEqual((await outbox()).map((e) => [e.state, e.outcome_code]), [['fired', null], ['fired', null], ['skipped', 'writer_burst'], ['skipped', 'writer_burst'], ['skipped', 'writer_burst']]);
    assert.equal((await runs()).length, 2, 'eight changed rows, two owner runs');
    const armed = await row('on_orders');
    assert.equal(armed.lastStatus, 'skipped');
    assert.match(armed.lastError, /STUDIO_APP_RECORD_TRIGGER_WRITER_BURST=2/);
});

test('rows that changed fewer than were read cannot be told apart: that write records nothing and says so', async () => {
    await publish(def([onRecord('on_orders', 'tbl_orders')]));
    lay(TABLES.orders, ['a', 'b']);
    const racing = { statements: [stmt('update', TABLES.orders, 'a', { status: 'new' }), stmt('noop', TABLES.orders, 'b')], rows: { table: TABLES.orders, event: 'update', ids: ['a', 'b'] } };
    assert.equal((await writeRows([racing])).captured, true);
    assert.deepEqual(await outbox(), [], 'an event is lost, never invented');
    assert.match((await row('on_orders')).lastError, /changed by someone else while a write of several rows ran/);
    await writeRows([seg('delete', TABLES.orders, ['a', 'gone'])]);
    assert.deepEqual((await outbox()).map((e) => [e.event, e.row_id]), [['delete', 'a']], 'a row that was not there before the write is no change');
});

test('a batch that fails records nothing, and the failure names the caller\'s own statement', async () => {
    await publish(def([onRecord('on_orders', 'tbl_orders')]));
    const segments = [seg('create', TABLES.orders, ['n1']), { statements: [stmt('fail', TABLES.orders, 'x')] }];
    await assert.rejects(() => writeRows(segments), (e) => e.code === 'batch_no_rows' && e.statementIndex === 1);
    assert.deepEqual(await outbox(), []);
});

// ── Control 2: the depth guard ──────────────────────────────────────────────

/** The run's steps write through the same write-through, with the source the server runner gave them. */
function runsWrite(byAction) {
    s.execute = async (_app, _model, step, ctx) => {
        const todo = byAction[ctx.actionId];
        if (todo) await write(TABLES[todo.table], todo.event, { id: todo.sameRow ? ctx.trigger.record.id : undefined, values: { status: `by ${ctx.actionId}` }, source: ctx.writeSource, viewer: ctx.viewer });
        return { ok: true, result: { step: step.kind } };
    };
}

test('loop guard: a trigger that updates the row it fires on runs once', async () => {
    runsWrite({ act_job: { table: 'orders', event: 'update', sameRow: true } });
    await publish(def([onRecord('on_orders', 'tbl_orders')]));
    await write(TABLES.orders, 'create');
    assert.equal(await runToQuiet(), 1);
    assert.equal((await outbox()).length, 1, 'the write of its own run is not even recorded for it');
});

test('loop guard: a trigger that creates rows in its own table runs once (its own run never fires it, whatever the row)', async () => {
    runsWrite({ act_job: { table: 'orders', event: 'create' } });
    await publish(def([onRecord('on_orders', 'tbl_orders')]));
    await write(TABLES.orders, 'create');
    assert.equal(await runToQuiet(), 1);
});

test('loop guard: two triggers that write each other\'s table stop after the depth limit, and the last one says why', async () => {
    runsWrite({ act_job: { table: 'log', event: 'create' }, act_back: { table: 'orders', event: 'create' } });
    await publish(def(
        [onRecord('a', 'tbl_orders'), onRecord('b', 'tbl_log', { actionId: 'act_back' })],
        { act_back: { kind: 'sequence', steps: [h.write('orders')] } },
    ));
    await write(TABLES.orders, 'create');
    assert.equal(await runToQuiet(), 3, 'STUDIO_APP_RECORD_TRIGGER_MAX_DEPTH=3: person -> a -> b -> a, and then nothing');
    assert.deepEqual((await outbox()).map((e) => e.depth), [0, 1, 2]);
    const last = await row('b');
    assert.equal(last.lastStatus, 'skipped');
    assert.match(last.lastError, /STUDIO_APP_RECORD_TRIGGER_MAX_DEPTH=3/);
});

test('matrix: the depth at which a change still starts a run', () => {
    const hook = { triggerId: 'b', on: ['create'], allowPublicWrites: false };
    const at = (depth, max, cause = 'a') => deliveryRefusal({ event: 'create', writerKind: 'trigger', depth, causeTriggerId: cause }, hook, TABLES.orders, max)?.code ?? null;
    assert.deepEqual([0, 1, 2, 3, 4, UNKNOWN_DEPTH].map((d) => at(d, 3)), [null, null, null, 'depth', 'depth', 'depth']);
    assert.deepEqual([0, 1, 2].map((d) => at(d, 1)), [null, 'depth', 'depth']);
    assert.equal(at(50, 0), null, '0 switches the limit off');
    assert.equal(at(0, 3, 'b'), 'own_write', 'its own run, at any depth');
    assert.equal(at(50, 0, 'b'), 'own_write', 'also with the depth limit off');
});

test('a write of a schedule run counts as depth 1; a run that goes on after a wait keeps its chain, and one whose change is gone writes beyond every limit', async () => {
    await publish(def([onRecord('on_orders', 'tbl_orders')]));
    await write(TABLES.orders, 'create', { source: readWriteSource({ kind: 'trigger', depth: 1, triggerId: null }), viewer: OWNER });
    assert.deepEqual((await outbox()).map((e) => [e.writer_kind, e.depth, e.writer_key]), [['trigger', 1, null]]);
    await drain();
    const armed = await row('on_orders');
    const kept = await resumeScope(armed.lastRunId, { id: 'on_orders', kind: 'record', actionId: 'act_job' }, { events: () => events });
    assert.deepEqual([kept.kind, kept.record.event, kept.record.depth, kept.record.by], ['record', 'create', 1, 'trigger']);
    const lost = await resumeScope('run_unknown', { id: 'on_orders', kind: 'record', actionId: 'act_job' }, { events: () => events });
    assert.equal(lost.record.depth, UNKNOWN_DEPTH);
    assert.equal(await resumeScope('run_unknown', { id: 'tick', kind: 'schedule', actionId: 'act_job' }, { events: () => events }), null);
    await settle(armed.lastRunId);
});

// ── Housekeeping ────────────────────────────────────────────────────────────

test('prune: a change that waited too long expires and says so; finished rows go after the retention, but not while their run is on hold', async () => {
    await publish(def([onRecord('on_orders', 'tbl_orders')]));
    await write(TABLES.orders, 'create');
    await drain();
    const armed = await row('on_orders');
    await settle(armed.lastRunId);
    await pass();
    await write(TABLES.orders, 'create');
    await h.triggers.setPaused('app_1', 'on_orders', { paused: true, code: 'user', reason: 'off' });
    s.clock += rl.eventTtlMs + 1000;
    await h.pg.query("UPDATE studio_app_action_runs SET status = 'paused' WHERE id = $1", [armed.lastRunId]);
    const out = await drain();
    assert.equal(out.expired, 1);
    assert.deepEqual((await outbox()).map((e) => [e.state, e.outcome_code]), [['fired', null], ['skipped', 'expired']], 'the fired row stays: its run is on hold and reads it');
    await h.pg.query("UPDATE studio_app_action_runs SET status = 'success' WHERE id = $1", [armed.lastRunId]);
    s.clock += rl.retentionMs + 1000;
    await drain();
    assert.deepEqual(await outbox(), []);
});

test('changedFields names what differs and ignores the update stamp', () => {
    assert.deepEqual(changedFields({ a: 1, b: 'x', updated_at: 1 }, { a: 2, b: 'x', c: null, updated_at: 2 }), ['a']);
    assert.deepEqual(changedFields(null, { a: 1 }), []);
});

// ── The run log and the builder ─────────────────────────────────────────────

test('the run log names the change that started a run without any row value', async () => {
    const { runStartedBy } = require('./recordDrain.mts');
    await publish(def([onRecord('on_orders', 'tbl_orders')]));
    const { rowId } = await write(TABLES.orders, 'create', { values: { title: 'Secret title' } });
    await drain();
    const armed = await row('on_orders');
    const started = await runStartedBy(armed.lastRunId, { events: () => events });
    assert.deepEqual(started, { kind: 'record', event: 'create', tableId: 'tbl_orders', rowId, by: 'member', depth: 0 });
    assert.equal(await runStartedBy('run_unknown', { events: () => events }), null);
    await settle(armed.lastRunId);
});

test('app_set_record_trigger writes a record trigger into the draft and refuses the stricter list with the opt-in', () => {
    const tool = require('../builderTools/tools/app_set_record_trigger.js');
    const { canonicalizeAppDefinition } = require('../canonicalize');
    const { emptyDefinition } = require('../componentSpecs');
    const draft = (steps) => {
        const base = canonicalizeAppDefinition(emptyDefinition('Fixture app')).def;
        return { userId: 'usr_test', def: { ...base, actions: { act_job1: { kind: 'sequence', steps } } } };
    };
    const plain = draft([h.write('log')]);
    const out = tool.apply(plain, { actionId: 'act_job1', tableId: 'tbl_orders', on: ['update', 'create'], fields: ['status'], when: 'trigger.record.row.status == "done"' });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(plain.def.triggers, [{ id: 'trigger1', kind: 'record', actionId: 'act_job1', tableId: 'tbl_orders', on: ['create', 'update'], fields: ['status'], when: 'trigger.record.row.status == "done"' }]);
    assert.equal(plain.def.schemaVersion, 3);
    assert.match(tool.apply(draft([h.write('log')]), { actionId: 'act_job1', tableId: 'tbl_orders', on: ['sometimes'] }).error, /on lists at least one of create, update, delete/);
    const erasing = draft([{ kind: 'delete_record', tableId: 'log', recordId: { kind: 'static', value: 'r1' } }]);
    assert.equal(tool.apply(erasing, { actionId: 'act_job1', tableId: 'tbl_orders', on: ['create'] }).ok, true, 'without the opt-in a delete step is allowed');
    assert.match(tool.apply(draft(erasing.def.actions.act_job1.steps), { actionId: 'act_job1', tableId: 'tbl_intake', on: ['create'], allowPublicWrites: true }).error, /delete_record step/);
});

test('which writes fire is said once to the AI builder: the kind, the triggers key and the tool carry one text, and it names what does not fire', () => {
    const { RECORD_TRIGGER_WRITES } = require('./recordFiresText');
    const texts = {
        kind: require('./kinds/record.mts').default.description,
        key: require('../definitionKeys/triggers.js').description,
        tool: require('../builderTools/tools/app_set_record_trigger.js').description,
    };
    for (const [where, text] of Object.entries(texts)) assert.ok(String(text).includes(RECORD_TRIGGER_WRITES), where);
    for (const named of ['with a filter', 'inside a transaction step', 'ai_extract', 'dataset_query', 'delete rule', 'file_intake', 'the mailbox hook', 'connector sync', 'app_seed_records']) {
        assert.ok(RECORD_TRIGGER_WRITES.includes(named), named);
    }
});
