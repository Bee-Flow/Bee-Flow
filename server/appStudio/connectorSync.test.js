/**
 * App Studio — connector → table sync.
 *
 * The properties under test are the ones that decide whether a background
 * refresh is safe to leave running unattended:
 *   • it writes through the record-write choke point (RLS + quotas), never around it
 *   • upsert is idempotent — re-running does not duplicate rows
 *   • the watermark only ever advances, and the 'client' tier really does skip
 *   • a claimed sync cannot be started twice (two replicas, one tick)
 *   • a failure still schedules the next attempt instead of going dark
 *   • an empty upstream response never empties a working table
 *
 * Pure-module: connectorSync takes an injectable `_deps` seam, so nothing here
 * touches Postgres, SQLite or the network.
 *
 * Run: cd server && node --test appStudio/connectorSync.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const connectorSync = require('./connectorSync');
const dataModel = require('./dataModel');

const app = { id: 'app-1', userId: 'owner-1', organizationId: 'org-1' };

const TABLE = {
    id: 'tbl_aaaaaa',
    key: 'emails',
    name: 'Emails',
    fields: [
        { id: 'fld_000001', key: 'ext_id', name: 'id', type: 'text', unique: true, sourcePath: 'id' },
        { id: 'fld_000002', key: 'subject', name: 'subject', type: 'text', sourcePath: 'subject' },
        { id: 'fld_000003', key: 'received', name: 'receivedAt', type: 'datetime', sourcePath: 'receivedAt' },
        { id: 'fld_000004', key: 'unread', name: 'unread', type: 'bool', sourcePath: 'unread' },
        { id: 'fld_000005', key: 'size', name: 'size', type: 'number', sourcePath: 'size' },
    ],
};

const MODEL = { modelVersion: 1, tables: [TABLE], roles: [], roleMapping: { default: 'app', byGroup: {} } };

function connector(sync, extra = {}) {
    return { id: 'conn_ab12cd', kind: 'integration_tool', name: 'Emails', tool: 'gmail_search', sync, ...extra };
}

// The store's writeRecordBatch stub keys inserted rows by `ext_id`; a child
// table keys on its own `ext_id` too, so both share one id space in the fake.

/**
 * A harness that records every write and models the table as a Map so upserts
 * can actually be observed across two runs.
 */
function harness({ runs = [], existing = new Map(), claim = true } = {}) {
    const log = { inserts: [], updates: [], deletes: 0, finish: null, connectorCalls: [], claims: 0, lookups: [], nextRecordId: 0 };
    let runIndex = 0;
    const store = new Map(existing);   // key value → record id

    const _deps = {
        runConnector: async (conn, opts) => {
            log.connectorCalls.push({ params: opts.params, systemArgs: opts.systemArgs, trace: opts.trace });
            const next = runs[Math.min(runIndex++, runs.length - 1)];
            return typeof next === 'function' ? next() : next;
        },
        claimSync: async () => { log.claims += 1; return claim ? { watermark: log.priorWatermark ?? null } : null; },
        finishSync: async (_appId, _connId, payload) => { log.finish = payload; return payload; },
        // Mirrors the real compiler: the lookup is scoped to the keys of the
        // batch, never the whole table.
        compileKeyIndex: (_t, _k, keys) => { log.lookups.push([...keys]); return { sql: 'SELECT', params: keys }; },
        compileDeleteAll: () => ({ sql: 'DELETE', params: [] }),
        query: async (_o, _a, _sql, keys) => ({
            rows: (keys || []).filter((k) => store.has(String(k))).map((k) => ({ id: store.get(String(k)), k })),
        }),
        exec: async () => { log.deletes += 1; store.clear(); return { changes: 0 }; },
        writeRecordBatch: async (_a, _m, _t, rows, opts) => {
            // Ids are minted off a counter read ONCE — reading store.size inside
            // the loop would skip numbers as the map grows.
            const base = log.nextRecordId;
            log.nextRecordId += rows.length;
            const ids = rows.map((_, i) => `rec_${base + i}`);
            rows.forEach((r, i) => {
                if (r.ext_id !== undefined && r.ext_id !== null) store.set(String(r.ext_id), ids[i]);
            });
            log.inserts.push({ rows, viewer: opts.viewer, ids });
            return ids;
        },
        writeRecord: async (_a, _m, _t, values, opts) => {
            log.updates.push({ values, recordId: opts.recordId, viewer: opts.viewer });
            return { id: opts.recordId, updated: true, changes: 1 };
        },
        setRowCount: async () => {},
        bumpDataVersion: async () => {},
    };
    return { log, store, _deps, withWatermark: (w) => { log.priorWatermark = w; return { log, store, _deps }; } };
}

// ── the write path ──────────────────────────────────────────────────

test('every default dependency actually resolves to a function', () => {
    // Each one is a lazy `require('./x').fn(...)`, so a helper that is defined
    // but not EXPORTED type-checks, passes every stubbed test, and then throws
    // "is not a function" on the first real refresh — which is exactly what
    // actionExecutor.writeRecordBatch did.
    for (const [name, fn] of Object.entries(connectorSync._defaultDeps())) {
        const [, mod, prop] = /require\('([^']+)'\)\.(\w+)/.exec(String(fn)) || [];
        assert.ok(mod, `${name} is not the expected lazy-require shape`);
        assert.strictEqual(typeof require(mod)[prop], 'function', `${mod} does not export ${prop}`);
    }
});

test('sync writes as the OWNER through the record-write choke point', async () => {
    const h = harness({ runs: [{ rows: [{ id: 'm1', subject: 'Hi', receivedAt: '2026-08-01T10:00:00Z', unread: true, size: 42 }] }] });
    const res = await connectorSync.syncConnector(app, MODEL,
        connector({ tableId: TABLE.id, mode: 'upsert', keyField: 'id' }), { _deps: h._deps });

    assert.strictEqual(res.inserted, 1);
    // 'owner' is the only role with unconditional write scope (rlsGateway), and
    // going through writeRecordBatch is what applies the storage quotas.
    assert.deepStrictEqual(h.log.inserts[0].viewer, { id: 'owner-1', role: 'owner' });
    assert.deepStrictEqual(h.log.inserts[0].rows[0], {
        ext_id: 'm1', subject: 'Hi', received: '2026-08-01T10:00:00.000Z', unread: true, size: 42,
    });
});

test('sync maps upstream fields onto columns by sourcePath and coerces per type', () => {
    const values = connectorSync.mapRowToColumns(
        { id: 7, subject: { rich: 'obj' }, receivedAt: 1754042400, unread: 'true', size: '99' }, TABLE);
    assert.strictEqual(values.ext_id, '7', 'a numeric id becomes text for a text column');
    assert.strictEqual(values.subject, '{"rich":"obj"}', 'a nested object becomes JSON text');
    assert.strictEqual(values.received, new Date(1754042400 * 1000).toISOString(), 'unix seconds become ISO');
    assert.strictEqual(values.unread, true);
    assert.strictEqual(values.size, 99);
});

test('sync fills a hand-added column named after the upstream field (no sourcePath)', () => {
    const table = { ...TABLE, fields: [{ id: 'fld_x', key: 'subject', name: 'Subject', type: 'text' }] };
    assert.deepStrictEqual(connectorSync.mapRowToColumns({ subject: 'Hello' }, table), { subject: 'Hello' });
});

// ── idempotence ─────────────────────────────────────────────────────

test('upsert: re-running updates matched rows instead of duplicating them', async () => {
    const h = harness({
        runs: [
            { rows: [{ id: 'm1', subject: 'First' }, { id: 'm2', subject: 'Second' }] },
            { rows: [{ id: 'm1', subject: 'First (edited)' }, { id: 'm3', subject: 'Third' }] },
        ],
    });
    const c = connector({ tableId: TABLE.id, mode: 'upsert', keyField: 'id' });

    const first = await connectorSync.syncConnector(app, MODEL, c, { _deps: h._deps });
    assert.deepStrictEqual([first.inserted, first.updated], [2, 0]);

    const second = await connectorSync.syncConnector(app, MODEL, c, { _deps: h._deps });
    assert.strictEqual(second.updated, 1, 'm1 matched an existing row');
    assert.strictEqual(second.inserted, 1, 'm3 is new');
    assert.strictEqual(h.log.updates[0].values.subject, 'First (edited)');
    assert.strictEqual(h.store.size, 3, 'three distinct records, not five');
});

test('upsert: the existing-record lookup is scoped to the batch, not the whole table', async () => {
    const h = harness({ runs: [{ rows: [{ id: 'm1' }, { id: 'm2' }] }] });
    await connectorSync.syncConnector(app, MODEL,
        connector({ tableId: TABLE.id, mode: 'upsert', keyField: 'id' }), { _deps: h._deps });
    // A full-table read would be capped by the storage engine at 10k rows, so a
    // bigger table would return a partial map and re-insert everything unmatched
    // on every sync. Looking up only these keys is correct at any table size.
    assert.deepStrictEqual(h.log.lookups, [['m1', 'm2']]);
});

test('upsert: a key repeated within one batch is written once, not twice', async () => {
    // A chained connector legitimately emits this: two attachments folded back
    // onto the same message. Inserting both would breach the unique index.
    const h = harness({ runs: [{ rows: [{ id: 'm1', subject: 'first' }, { id: 'm1', subject: 'dup' }, { id: 'm2' }] }] });
    const res = await connectorSync.syncConnector(app, MODEL,
        connector({ tableId: TABLE.id, mode: 'upsert', keyField: 'id' }), { _deps: h._deps });
    assert.strictEqual(res.inserted, 2);
    assert.strictEqual(h.log.inserts[0].rows[0].subject, 'first', 'first occurrence wins');
});

test('replace: empties and refills, but NEVER empties on an empty response', async () => {
    const h = harness({ runs: [{ rows: [{ id: 'a' }, { id: 'b' }] }, { rows: [] }] });
    const c = connector({ tableId: TABLE.id, mode: 'replace' });

    const first = await connectorSync.syncConnector(app, MODEL, c, { _deps: h._deps });
    assert.strictEqual(first.inserted, 2);
    assert.strictEqual(h.log.deletes, 1);

    // A transient upstream hiccup returning nothing must not wipe good data.
    const second = await connectorSync.syncConnector(app, MODEL, c, { _deps: h._deps });
    assert.strictEqual(second.inserted, 0);
    assert.strictEqual(h.log.deletes, 1, 'no second DELETE');
    assert.strictEqual(h.store.size, 2, 'the rows are still there');
});

// ── incremental tiers ───────────────────────────────────────────────

test("'request' tier sends the stored watermark up as the action's since-param", async () => {
    const h = harness({ runs: [{ rows: [{ id: 'm1', receivedAt: '2026-08-03T12:00:00Z' }] }] });
    h.log.priorWatermark = '2026-08-01T00:00:00.000Z';
    const res = await connectorSync.syncConnector(app, MODEL, connector({
        tableId: TABLE.id, mode: 'upsert', keyField: 'id',
        incremental: { field: 'receivedAt', param: 'updatedAfter', format: 'iso' },
    }), { _deps: h._deps });

    assert.deepStrictEqual(h.log.connectorCalls[0].systemArgs, { updatedAfter: '2026-08-01T00:00:00.000Z' });
    assert.deepStrictEqual(h.log.connectorCalls[0].params, {}, 'never through the viewer-param channel');
    assert.strictEqual(res.watermark, '2026-08-03T12:00:00.000Z', 'the watermark advanced');
});

test("'client' tier fetches everything but only writes what changed", async () => {
    const h = harness({
        runs: [{ rows: [
            { id: 'old', receivedAt: '2026-07-01T00:00:00Z' },
            { id: 'new', receivedAt: '2026-08-03T00:00:00Z' },
        ] }],
    });
    h.log.priorWatermark = '2026-08-01T00:00:00.000Z';
    const res = await connectorSync.syncConnector(app, MODEL, connector({
        tableId: TABLE.id, mode: 'upsert', keyField: 'id',
        incremental: { field: 'receivedAt', param: null, format: 'iso' },
    }), { _deps: h._deps });

    assert.strictEqual(res.skipped, 1, 'the older row was skipped');
    assert.strictEqual(res.inserted, 1);
    assert.deepStrictEqual(h.log.connectorCalls[0].systemArgs, {}, 'no since-param to send');
});

test('the watermark never moves backwards', () => {
    const rows = [{ t: '2026-07-01T00:00:00Z' }, { t: '2026-08-02T00:00:00Z' }];
    assert.strictEqual(connectorSync.highWatermark(rows, 't', '2026-09-01T00:00:00.000Z'),
        '2026-09-01T00:00:00.000Z', 'an older batch does not lower it');
    assert.strictEqual(connectorSync.highWatermark(rows, 't', null), '2026-08-02T00:00:00.000Z');
    assert.strictEqual(connectorSync.highWatermark([{ t: 'not a date' }], 't', null), null);
});

test('the watermark renders into whatever shape the since-param wants', () => {
    const iso = '2026-08-01T10:00:00.000Z';
    assert.strictEqual(connectorSync.renderWatermark(iso, 'iso'), iso);
    assert.strictEqual(connectorSync.renderWatermark(iso, 'date'), '2026-08-01');
    assert.strictEqual(connectorSync.renderWatermark(iso, 'unix'), Math.floor(Date.parse(iso) / 1000));
    assert.strictEqual(connectorSync.renderWatermark(null, 'iso'), null);
});

// An epoch-second watermark is a round trip through ISO: highWatermark stores
// the comparable string, renderWatermark turns it back into seconds. Withings
// is the first source to use it on BOTH sides (its `modified` field and its
// `lastupdate` parameter are the same clock), so a lossy hop would resend the
// wrong window on every sync.
test('an epoch-second watermark survives the ISO round trip intact', () => {
    const rows = [
        { measurement_key: 'withings:meas:900:1', modified: 1_755_580_260 },
        { measurement_key: 'withings:meas:901:1', modified: 1_755_666_660 },
    ];
    const stored = connectorSync.highWatermark(rows, 'modified', null);
    assert.strictEqual(stored, new Date(1_755_666_660_000).toISOString());
    assert.strictEqual(connectorSync.renderWatermark(stored, 'unix'), 1_755_666_660);
});

test("no incremental block → every run is a full refresh, no watermark kept", async () => {
    const h = harness({ runs: [{ rows: [{ id: 'a', receivedAt: '2026-08-03T00:00:00Z' }] }] });
    const res = await connectorSync.syncConnector(app, MODEL,
        connector({ tableId: TABLE.id, mode: 'replace' }), { _deps: h._deps });
    assert.strictEqual(res.watermark, null);
    assert.strictEqual(res.skipped, 0);
});

// ── concurrency + failure ───────────────────────────────────────────

test('a sync already claimed by another replica is not started twice', async () => {
    const h = harness({ runs: [{ rows: [{ id: 'a' }] }], claim: false });
    const res = await connectorSync.syncConnector(app, MODEL,
        connector({ tableId: TABLE.id, mode: 'replace' }), { _deps: h._deps });
    assert.strictEqual(res.alreadyRunning, true);
    assert.strictEqual(h.log.connectorCalls.length, 0, 'the upstream was never called');
});

test('a failing run records the error AND still schedules the next attempt', async () => {
    const h = harness({ runs: [() => { throw new Error('gmail is not connected'); }] });
    await assert.rejects(() => connectorSync.syncConnector(app, MODEL,
        connector({ tableId: TABLE.id, mode: 'replace' }), { _deps: h._deps }), /not connected/);

    assert.strictEqual(h.log.finish.status, 'error');
    assert.match(h.log.finish.error, /not connected/);
    assert.ok(h.log.finish.nextRunAt, 'a connector that is down for an hour recovers on its own');
});

test('a connector whose table was deleted fails loudly, before claiming anything', async () => {
    const h = harness({ runs: [{ rows: [] }] });
    await assert.rejects(
        () => connectorSync.syncConnector(app, MODEL, connector({ tableId: 'tbl_gone' }), { _deps: h._deps }),
        (e) => e.status === 409 && e.code === 'table_missing',
    );
    assert.strictEqual(h.log.claims, 0);
});

// ── related tables ──────────────────────────────────────────────────
//
// A chain that expands stores TWO tables joined by a relation column, so the
// parent's fields aren't repeated once per child. The link is resolved from the
// positional `_parentIndex` the runner stamps — never by matching a column name,
// which would break the moment a child element carried the same key as its parent.

const CHILD_TABLE = {
    id: 'tbl_bbbbbb',
    key: 'attachments',
    name: 'Attachments',
    fields: [
        { id: 'fld_100001', key: 'emails_ref', name: 'Emails record', type: 'relation', relation: { table: TABLE.id } },
        { id: 'fld_100002', key: 'ext_id', name: 'id', type: 'text', unique: true, sourcePath: 'id' },
        { id: 'fld_100003', key: 'filename', name: 'name', type: 'text', sourcePath: 'name' },
    ],
};
const MODEL_WITH_CHILD = { ...MODEL, tables: [TABLE, CHILD_TABLE] };

function joinedConnector() {
    return connector({
        tableId: TABLE.id, mode: 'upsert', keyField: 'id',
        children: [{ tableId: CHILD_TABLE.id, level: 1, parentLevel: 0, relationField: 'emails_ref', mode: 'upsert', keyField: 'id' }],
    }, { chain: [{ tool: 'gmail_read', argsFrom: { messageId: 'id' }, expand: 'attachments' }] });
}

test('joined: each child row is stamped with its parent’s real record id', async () => {
    const h = harness({
        runs: [{
            rows: [],   // the flat view is irrelevant here
            grains: [
                { level: 0, rows: [{ id: 'm1', subject: 'Hi' }, { id: 'm2', subject: 'Yo' }] },
                { level: 1, parentLevel: 0, expandFrom: 'attachments', rows: [
                    { id: 'a1', name: 'x.pdf', _parentIndex: 0 },
                    { id: 'a2', name: 'y.pdf', _parentIndex: 0 },
                    { id: 'a3', name: 'z.pdf', _parentIndex: 1 },
                ] },
            ],
        }],
    });
    const res = await connectorSync.syncConnector(app, MODEL_WITH_CHILD, joinedConnector(), { _deps: h._deps });

    assert.strictEqual(res.inserted, 5, '2 messages + 3 attachments');
    assert.deepStrictEqual(res.children, [{ tableId: CHILD_TABLE.id, table: 'attachments', inserted: 3, updated: 0 }]);

    // The parent batch is written first so its ids exist to point at.
    const [parentBatch, childBatch] = h.log.inserts;
    assert.deepStrictEqual(parentBatch.rows.map((r) => r.ext_id), ['m1', 'm2']);
    const parentIds = parentBatch.ids;
    assert.deepStrictEqual(childBatch.rows.map((r) => r.emails_ref), [parentIds[0], parentIds[0], parentIds[1]],
        'the first two attachments point at message 1, the third at message 2');
    // And the child holds only its own columns.
    assert.strictEqual(childBatch.rows[0].subject, undefined);
    assert.deepStrictEqual(childBatch.rows[0].ext_id, 'a1');
});

test('joined: the run asks the connector to report grains', async () => {
    const h = harness({ runs: [{ rows: [], grains: [{ level: 0, rows: [] }] }] });
    await connectorSync.syncConnector(app, MODEL_WITH_CHILD, joinedConnector(), { _deps: h._deps });
    assert.strictEqual(h.log.connectorCalls[0].trace, true);
});

test('joined: the PARENT table stores grain 0, not the flattened output', async () => {
    // The flat output is one row per attachment; storing that in the messages
    // table would duplicate each message and lose messages with no attachments.
    const h = harness({
        runs: [{
            rows: [{ id: 'a1', subject: 'Hi' }, { id: 'a2', subject: 'Hi' }],
            grains: [
                { level: 0, rows: [{ id: 'm1', subject: 'Hi' }] },
                { level: 1, parentLevel: 0, rows: [{ id: 'a1', _parentIndex: 0 }, { id: 'a2', _parentIndex: 0 }] },
            ],
        }],
    });
    const res = await connectorSync.syncConnector(app, MODEL_WITH_CHILD, joinedConnector(), { _deps: h._deps });
    assert.strictEqual(h.log.inserts[0].rows.length, 1, 'one message, not two');
    assert.strictEqual(res.children[0].inserted, 2);
});

test('joined: a child whose parent was not written gets no dangling reference', async () => {
    const h = harness({
        runs: [{
            rows: [],
            grains: [
                { level: 0, rows: [{ id: 'm1' }] },
                { level: 1, parentLevel: 0, rows: [{ id: 'a1', _parentIndex: 7 }] },   // parent index out of range
            ],
        }],
    });
    await connectorSync.syncConnector(app, MODEL_WITH_CHILD, joinedConnector(), { _deps: h._deps });
    const childBatch = h.log.inserts[1];
    assert.strictEqual(childBatch.rows[0].emails_ref, undefined);
});

test('joined: re-running updates both tables instead of duplicating either', async () => {
    const grains = () => ({
        rows: [],
        grains: [
            { level: 0, rows: [{ id: 'm1', subject: 'Hi' }] },
            { level: 1, parentLevel: 0, rows: [{ id: 'a1', name: 'x.pdf', _parentIndex: 0 }] },
        ],
    });
    const h = harness({ runs: [grains(), grains()] });
    const c = joinedConnector();

    const first = await connectorSync.syncConnector(app, MODEL_WITH_CHILD, c, { _deps: h._deps });
    assert.strictEqual(first.inserted, 2);

    const second = await connectorSync.syncConnector(app, MODEL_WITH_CHILD, c, { _deps: h._deps });
    assert.strictEqual(second.inserted, 0);
    assert.strictEqual(second.updated, 2, 'both the message and its attachment matched');
});

test('a connector with no children still runs without asking for grains', async () => {
    const h = harness({ runs: [{ rows: [{ id: 'm1' }] }] });
    await connectorSync.syncConnector(app, MODEL,
        connector({ tableId: TABLE.id, mode: 'upsert', keyField: 'id' }), { _deps: h._deps });
    assert.notStrictEqual(h.log.connectorCalls[0].trace, true);
});

// ── scheduling ──────────────────────────────────────────────────────

test('nextRunFor honours an interval, a cron, and a missing schedule', () => {
    const from = Date.parse('2026-08-03T10:00:00.000Z');
    assert.strictEqual(connectorSync.nextRunFor({ schedule: { everyMinutes: 30 } }, from), '2026-08-03T10:30:00.000Z');
    // Below the floor is clamped up rather than honoured.
    assert.strictEqual(connectorSync.nextRunFor({ schedule: { everyMinutes: 1 } }, from),
        new Date(from + dataModel.MIN_SYNC_MINUTES * 60_000).toISOString());
    assert.ok(connectorSync.nextRunFor({ schedule: { cron: '0 6 * * *', tz: 'Europe/Amsterdam' } }, from));
    assert.strictEqual(connectorSync.nextRunFor({}, from),
        new Date(from + connectorSync.DEFAULT_SYNC_MINUTES * 60_000).toISOString());
});

test('isStale decides when opening the app should kick a refresh', () => {
    const now = Date.parse('2026-08-03T12:00:00.000Z');
    const sync = { schedule: { everyMinutes: 60 }, refreshOnView: true };
    assert.strictEqual(connectorSync.isStale(null, sync, now), true, 'never synced');
    assert.strictEqual(connectorSync.isStale({ lastRunAt: '2026-08-03T11:59:00Z' }, sync, now), false, 'fresh');
    assert.strictEqual(connectorSync.isStale({ lastRunAt: '2026-08-03T10:00:00Z' }, sync, now), true, 'stale');
    assert.strictEqual(connectorSync.isStale({ lastRunAt: '2026-08-03T10:00:00Z', status: 'running' }, sync, now), false,
        'already in flight — no pile-up');
    assert.strictEqual(connectorSync.isStale({ lastRunAt: '2020-01-01T00:00:00Z' }, { ...sync, refreshOnView: false }, now), false,
        'the owner turned on-view refresh off');
});

// ── Retention ───────────────────────────────────────────────────────────────

test('retention purges the child table too, not only the parent', async () => {
    // A mailbox that rolls messages up into conversations keeps the actual
    // personal data in the CHILD table. Purging only the parent would leave
    // every message body forever while still reporting a retention policy —
    // which is worse than having no policy at all.
    const purges = [];
    const h = harness({ runs: [{ grains: [{ level: 0, rows: [{ id: 'p1', receivedAt: '2026-08-01T00:00:00Z' }] }, { level: 1, rows: [] }] }] });
    h._deps.compileDeleteOlderThan = (table, _access, opts) => {
        purges.push({ table: table.key, field: opts.field, cutoffIso: opts.cutoffIso });
        return { sql: `DELETE FROM ${table.key}`, params: [] };
    };
    h._deps.exec = async () => ({ changes: 1 });

    // A child that CAN be dated — the mailbox case, where the messages carry
    // their own received stamp.
    const datedChild = {
        ...CHILD_TABLE,
        fields: [...CHILD_TABLE.fields, { id: 'fld_100004', key: 'received', name: 'receivedAt', type: 'datetime', sourcePath: 'receivedAt' }],
    };

    await connectorSync.syncConnector(app, { ...MODEL, tables: [TABLE, datedChild] }, connector({
        tableId: TABLE.id, mode: 'upsert', keyField: 'id',
        incremental: { field: 'receivedAt', format: 'iso' },
        retentionDays: 30,
        children: [{ tableId: datedChild.id, level: 1, relationField: 'emails_ref', keyField: 'id', mode: 'upsert' }],
    }), { _deps: h._deps });

    assert.deepStrictEqual(purges.map((p) => p.table), ['emails', 'attachments']);
    // The source path is 'receivedAt'; the COLUMN is 'received'. Getting that
    // mapping wrong silently purges nothing.
    assert.ok(purges.every((p) => p.field === 'received'), 'each table is purged on its own column');
});

test('a child without the timestamp column is skipped, never guessed at', async () => {
    const purges = [];
    // CHILD_TABLE has no `received` column.
    const h = harness({ runs: [{ grains: [{ level: 0, rows: [{ id: 'p1', receivedAt: '2026-08-01T00:00:00Z' }] }, { level: 1, rows: [] }] }] });
    h._deps.compileDeleteOlderThan = (table, _a, opts) => {
        purges.push(table.key);
        return { sql: 'DELETE', params: [opts.cutoffIso] };
    };
    h._deps.exec = async () => ({ changes: 0 });

    const childNoStamp = { ...CHILD_TABLE, fields: CHILD_TABLE.fields.filter((f) => f.key !== 'received') };
    await connectorSync.syncConnector(app, { ...MODEL, tables: [TABLE, childNoStamp] }, connector({
        tableId: TABLE.id, mode: 'upsert', keyField: 'id',
        incremental: { field: 'receivedAt', format: 'iso' },
        retentionDays: 30,
        children: [{ tableId: childNoStamp.id, level: 1, relationField: 'emails_ref', keyField: 'id', mode: 'upsert' }],
    }), { _deps: h._deps });

    assert.deepStrictEqual(purges, ['emails'], 'only the table that can be dated');
});

test('a child with no date of its own is purged WITH its parent, parent-first', async () => {
    // The attachment case. Its age is not its own fact — it is its message's —
    // so the only honest rule is "when the message goes, the attachment goes".
    // Order matters: a cascade step asks "does my parent still exist?", so the
    // parent's purge has to have run first or the child catches up a sync late.
    const purges = [];
    const h = harness({ runs: [{ grains: [{ level: 0, rows: [{ id: 'p1', receivedAt: '2026-08-01T00:00:00Z' }] }, { level: 1, rows: [] }] }] });
    h._deps.compileDeleteOlderThan = (table, _a, opts) => {
        purges.push({ table: table.key, mode: 'column', field: opts.field });
        return { sql: 'DELETE', params: [], where: '1=1', whereParams: [] };
    };
    h._deps.compileDeleteOrphans = (table, _a, opts) => {
        purges.push({ table: table.key, mode: 'cascade', parent: opts.parentTableMeta.key, relationField: opts.relationField });
        return { sql: 'DELETE', params: [], where: '1=1', whereParams: [] };
    };
    h._deps.exec = async () => ({ changes: 2 });

    const childNoStamp = { ...CHILD_TABLE, fields: CHILD_TABLE.fields.filter((f) => f.key !== 'received') };
    await connectorSync.syncConnector(app, { ...MODEL, tables: [TABLE, childNoStamp] }, connector({
        tableId: TABLE.id, mode: 'upsert', keyField: 'id',
        incremental: { field: 'receivedAt', format: 'iso' },
        retentionDays: 30,
        children: [{ tableId: childNoStamp.id, level: 1, relationField: 'emails_ref', keyField: 'id', mode: 'upsert', retentionCascade: true }],
    }), { _deps: h._deps });

    assert.deepStrictEqual(purges, [
        { table: 'emails', mode: 'column', field: 'received' },
        { table: 'attachments', mode: 'cascade', parent: 'emails', relationField: 'emails_ref' },
    ]);
});

test('no retentionDays means nothing is ever deleted', async () => {
    let purged = false;
    const h = harness({ runs: [{ rows: [{ id: 'p1', receivedAt: '2026-08-01T00:00:00Z' }] }] });
    h._deps.compileDeleteOlderThan = () => { purged = true; return { sql: 'DELETE', params: [] }; };

    await connectorSync.syncConnector(app, MODEL, connector({
        tableId: TABLE.id, mode: 'upsert', keyField: 'id',
        incremental: { field: 'receivedAt', format: 'iso' },
    }), { _deps: h._deps });

    assert.strictEqual(purged, false);
});

// ── Grain depth ─────────────────────────────────────────────────────
// A child is not necessarily a child of grain 0. A threaded mailbox produces
// conversations (0) → messages (1) → attachments (2), and an attachment belongs
// to its MESSAGE. The sync used to pass grain 0's ids to every child, which
// related attachments to tickets — silently, since both are valid record ids.

const GRANDCHILD_TABLE = {
    id: 'tbl_cccccc',
    key: 'files',
    name: 'Files',
    fields: [
        { id: 'fld_200001', key: 'att_ref', name: 'Attachment', type: 'relation', relation: { table: CHILD_TABLE.id } },
        { id: 'fld_200002', key: 'ext_id', name: 'id', type: 'text', unique: true, sourcePath: 'id' },
    ],
};
const MODEL_3 = { ...MODEL, tables: [TABLE, CHILD_TABLE, GRANDCHILD_TABLE] };

const THREE_GRAINS = {
    rows: [],
    grains: [
        { level: 0, rows: [{ id: 'm1' }, { id: 'm2' }] },
        { level: 1, rows: [{ id: 'a1', _parentIndex: 0 }, { id: 'a2', _parentIndex: 1 }] },
        { level: 2, rows: [{ id: 'f1', _parentIndex: 1 }] },
    ],
};

test('a level-2 child relates to its level-1 parent, not to grain 0', async () => {
    const h = harness({ runs: [THREE_GRAINS] });
    await connectorSync.syncConnector(app, MODEL_3, connector({
        tableId: TABLE.id, mode: 'upsert', keyField: 'id',
        children: [
            { tableId: CHILD_TABLE.id, level: 1, parentLevel: 0, relationField: 'emails_ref', mode: 'upsert', keyField: 'id' },
            { tableId: GRANDCHILD_TABLE.id, level: 2, parentLevel: 1, relationField: 'att_ref', mode: 'upsert', keyField: 'id' },
        ],
    }), { _deps: h._deps });

    const [, childBatch, grandBatch] = h.log.inserts;
    // _parentIndex 1 in the LEVEL-1 grain — attachment a2, not message m2.
    assert.strictEqual(grandBatch.rows[0].att_ref, childBatch.ids[1]);
    assert.notStrictEqual(grandBatch.rows[0].att_ref, h.log.inserts[0].ids[1]);
});

test('a child with no parentLevel still relates to grain 0 (no regression)', async () => {
    // Every connector written before parentLevel existed omits it, and must keep
    // behaving byte-identically — hence `?? 0` rather than `?? level - 1`.
    const h = harness({ runs: [THREE_GRAINS] });
    await connectorSync.syncConnector(app, MODEL_3, connector({
        tableId: TABLE.id, mode: 'upsert', keyField: 'id',
        children: [
            { tableId: CHILD_TABLE.id, level: 1, relationField: 'emails_ref', mode: 'upsert', keyField: 'id' },
            { tableId: GRANDCHILD_TABLE.id, level: 2, relationField: 'att_ref', mode: 'upsert', keyField: 'id' },
        ],
    }), { _deps: h._deps });

    const [parentBatch, , grandBatch] = h.log.inserts;
    assert.strictEqual(grandBatch.rows[0].att_ref, parentBatch.ids[1], 'still grain 0');
});

test('children are written parent-first even when declared out of order', async () => {
    // Level 2 must not be written before level 1 — its parent ids would not
    // exist yet and every row would land unrelated.
    const h = harness({ runs: [THREE_GRAINS] });
    await connectorSync.syncConnector(app, MODEL_3, connector({
        tableId: TABLE.id, mode: 'upsert', keyField: 'id',
        children: [
            { tableId: GRANDCHILD_TABLE.id, level: 2, parentLevel: 1, relationField: 'att_ref', mode: 'upsert', keyField: 'id' },
            { tableId: CHILD_TABLE.id, level: 1, parentLevel: 0, relationField: 'emails_ref', mode: 'upsert', keyField: 'id' },
        ],
    }), { _deps: h._deps });

    const [, childBatch, grandBatch] = h.log.inserts;
    assert.deepStrictEqual(childBatch.rows.map((r) => r.ext_id), ['a1', 'a2']);
    assert.strictEqual(grandBatch.rows[0].att_ref, childBatch.ids[1]);
});

// ── Retention takes the FILES with it ───────────────────────────────
// Deleting the row but keeping the blob and its ledger entry would leave the
// actual document — an invoice, an ID scan — in object storage forever while
// the app reports a 90-day policy. That is a compliance claim we would not be
// keeping, which is the same argument that made retention walk child tables.

const FILE_TABLE = {
    id: 'tbl_dddddd',
    key: 'atts',
    name: 'Atts',
    fields: [
        { id: 'fld_300001', key: 'ext_id', name: 'id', type: 'text', unique: true, sourcePath: 'id' },
        { id: 'fld_300002', key: 'received', name: 'receivedAt', type: 'datetime', sourcePath: 'receivedAt' },
        { id: 'fld_300003', key: 'file', name: 'File', type: 'file' },
    ],
};

/** A harness wired for the purge path: expiring rows, a ledger and a bucket. */
function retentionHarness(expiringRows, ledger) {
    const h = harness({ runs: [{ rows: [{ id: 'p1', receivedAt: '2026-08-01T00:00:00Z' }] }] });
    const deleted = { ledger: [], blobs: [] };
    let rows = [...ledger];

    h._deps.compileDeleteOlderThan = (t) => ({ sql: `DELETE FROM ${t.key}`, params: [] });
    h._deps.exec = async () => ({ changes: expiringRows.length });
    h._deps.query = async (_o, _a, sql) => (/SELECT "file"/.test(sql) ? { rows: expiringRows } : { rows: [] });
    h._deps.listAttachments = async () => rows;
    h._deps.deleteAttachment = async (id) => { deleted.ledger.push(id); rows = rows.filter((r) => r.id !== id); return true; };
    h._deps.deleteFile = async (key) => { deleted.blobs.push(key); };
    h._deps.buildAttachmentKey = (owner, appId, sha) => `${owner}/${appId}/${sha}`;
    return { h, deleted };
}

async function runRetention(h) {
    return connectorSync.syncConnector(app, { ...MODEL, tables: [FILE_TABLE] }, connector({
        tableId: FILE_TABLE.id, mode: 'upsert', keyField: 'id',
        incremental: { field: 'receivedAt', format: 'iso' },
        retentionDays: 30,
    }), { _deps: h._deps });
}

test('retention deletes the ledger row AND the blob behind an expired file', async () => {
    const { h, deleted } = retentionHarness(
        [{ file: JSON.stringify({ kind: 'studio_attachment', fileId: 'f1', name: 'a.pdf' }) }],
        [{ id: 'f1', sha256: 'sha-a', size: 10 }],
    );
    await runRetention(h);

    assert.deepStrictEqual(deleted.ledger, ['f1']);
    assert.deepStrictEqual(deleted.blobs, ['owner-1/app-1/sha-a']);
});

test('a blob another row still points at is kept', async () => {
    // Keys are content-addressed by sha256, so two records attaching the same
    // file share ONE blob. Deleting it because one of them expired would break
    // the other — a silent 404 on a file that is still perfectly current.
    const { h, deleted } = retentionHarness(
        [{ file: JSON.stringify({ kind: 'studio_attachment', fileId: 'f1' }) }],
        [{ id: 'f1', sha256: 'shared', size: 10 }, { id: 'f2', sha256: 'shared', size: 10 }],
    );
    await runRetention(h);

    assert.deepStrictEqual(deleted.ledger, ['f1'], 'its own ledger row still goes');
    assert.deepStrictEqual(deleted.blobs, [], 'the bytes stay — f2 still needs them');
});

test('a pending mailbox descriptor leaves nothing of ours to delete', async () => {
    const { h, deleted } = retentionHarness(
        [{ file: JSON.stringify({ kind: 'mailbox_attachment', messageId: 'm1', attachmentId: 'a1' }) }],
        [{ id: 'f1', sha256: 'sha-a', size: 10 }],
    );
    await runRetention(h);

    assert.deepStrictEqual(deleted.ledger, []);
    assert.deepStrictEqual(deleted.blobs, []);
});

// ── File descriptors survive the write path with EXACTLY one encoding ────────

test('a file descriptor round-trips the full write path with ONE JSON.parse', () => {
    // The bug this pins was a pair: coerceForField (here) serialised the
    // descriptor to JSON text, and the query compiler's coerceValue serialised
    // that text AGAIN. The stored value was a JSON string containing a JSON
    // string; one parse returned a string, `.kind` was undefined, and preview,
    // materialize and the AI read all found "no descriptor" on a row that
    // plainly had one — the exact "cannot open the PDF" bug.
    const queryCompiler = require('./queryCompiler');
    const table = {
        id: 'tbl_att001', key: 'attachments', name: 'Attachments',
        fields: [
            { id: 'fld_fn01', key: 'filename', type: 'text' },
            { id: 'fld_fi01', key: 'file', type: 'file' },
        ],
    };
    const descriptor = {
        kind: 'mailbox_attachment', connectorId: 'conn_x', messageId: 'm1',
        attachmentId: 'a1', name: 'factuur.pdf', mime: 'application/pdf', size: 231504, isInline: false,
    };

    // Connector emit → column mapping (real coerceForField)…
    const mapped = connectorSync.mapRowToColumns({ filename: 'factuur.pdf', file: descriptor }, table);
    // …→ the compiler (real coerceValue). The LAST param is the file column.
    const { params } = queryCompiler.compileInsert(table, mapped, {});
    const stored = params[params.length - 1];

    assert.strictEqual(typeof stored, 'string', 'a file column is stored as TEXT');
    assert.deepStrictEqual(JSON.parse(stored), descriptor, 'ONE parse gives back the descriptor — not another string');
});

test('a source that hands PRE-SERIALISED JSON text still lands single-encoded', () => {
    // Some upstream APIs return JSON-in-a-string themselves; unwrapping it in
    // coerceForField is what keeps the invariant when we don't control the emit.
    const queryCompiler = require('./queryCompiler');
    const table = {
        id: 'tbl_att002', key: 'attachments2', name: 'Attachments',
        fields: [{ id: 'fld_fi02', key: 'file', type: 'file' }],
    };
    const descriptor = { kind: 'mailbox_attachment', attachmentId: 'a1', messageId: 'm1' };

    const mapped = connectorSync.mapRowToColumns({ file: JSON.stringify(descriptor) }, table);
    const { params } = queryCompiler.compileInsert(table, mapped, {});
    assert.deepStrictEqual(JSON.parse(params[params.length - 1]), descriptor);
});

// ── Dependents: tables the connector does not WRITE but must purge ──────────
// The quote-intake gap: app-written line-item and activity tables link to the
// synced conversation by a TEXT thread key, which neither retention mode can
// follow. Because planRetention only walked sync.children, those tables landed
// in neither `steps` nor `unreachable` — invisible to the save-gate AND to the
// purge, so their rows (soon: customer CAD drawings) outlived the policy as
// orphans. `sync.dependents` is how a connector declares them.

const LINES_TABLE = {
    id: 'tbl_eeeeee',
    key: 'quote_lines',
    name: 'Quote lines',
    fields: [
        { id: 'fld_400001', key: 'thread_key', name: 'Thread', type: 'text' },
        { id: 'fld_400002', key: 'added_at', name: 'Added', type: 'datetime' },
        { id: 'fld_400003', key: 'drawing', name: 'Drawing', type: 'file' },
    ],
};
const ACTIVITY_TABLE = {
    id: 'tbl_ffffff',
    key: 'activity',
    name: 'Activity',
    fields: [
        { id: 'fld_500001', key: 'request', name: 'Request', type: 'relation', relation: { table: TABLE.id } },
        { id: 'fld_500002', key: 'detail', name: 'Detail', type: 'text' },
    ],
};

test('a dependent with a date column of its own is purged on it — old rows go, young rows stay', async () => {
    const purges = [];
    // Simulate the compiled delete against a fake dependent table so the WINDOW
    // is observable, not just the call: one row far past 30 days, one from today.
    const young = new Date().toISOString();
    const depRows = [{ added_at: '2026-01-01T00:00:00.000Z' }, { added_at: young }];
    const h = harness({ runs: [{ rows: [{ id: 'p1', receivedAt: '2026-08-01T00:00:00Z' }] }] });
    h._deps.compileDeleteOlderThan = (table, _a, opts) => {
        purges.push({ table: table.key, field: opts.field });
        return { sql: `DELETE:${table.key}:${opts.field}`, params: [opts.cutoffIso], where: '1=1', whereParams: [] };
    };
    h._deps.exec = async (_o, _a, sql, params) => {
        const [verb, tableKey, field] = sql.split(':');
        if (verb !== 'DELETE' || tableKey !== 'quote_lines') return { changes: 0 };
        const before = depRows.length;
        for (let i = depRows.length - 1; i >= 0; i--) if (depRows[i][field] < params[0]) depRows.splice(i, 1);
        return { changes: before - depRows.length };
    };

    const res = await connectorSync.syncConnector(app, { ...MODEL, tables: [TABLE, LINES_TABLE] }, connector({
        tableId: TABLE.id, mode: 'upsert', keyField: 'id',
        incremental: { field: 'receivedAt', format: 'iso' },
        retentionDays: 30,
        dependents: [{ tableId: LINES_TABLE.id, retentionField: 'added_at' }],
    }), { _deps: h._deps });

    assert.deepStrictEqual(purges, [
        { table: 'emails', field: 'received' },
        { table: 'quote_lines', field: 'added_at' },
    ], 'the dependent is purged on ITS declared column, after the primary');
    assert.deepStrictEqual(depRows.map((r) => r.added_at), [young], 'older than the window purged, younger survived');
    assert.strictEqual(res.purged, 1);
});

test('a cascade dependent goes when its parent goes — via the relation, parent-first', async () => {
    const purges = [];
    const h = harness({ runs: [{ rows: [{ id: 'p1', receivedAt: '2026-08-01T00:00:00Z' }] }] });
    h._deps.compileDeleteOlderThan = (table, _a, opts) => {
        purges.push({ table: table.key, mode: 'column', field: opts.field });
        return { sql: 'DELETE', params: [], where: '1=1', whereParams: [] };
    };
    h._deps.compileDeleteOrphans = (table, _a, opts) => {
        purges.push({ table: table.key, mode: 'cascade', parent: opts.parentTableMeta.key, relationField: opts.relationField });
        return { sql: 'DELETE', params: [], where: '1=1', whereParams: [] };
    };
    h._deps.exec = async () => ({ changes: 1 });

    await connectorSync.syncConnector(app, { ...MODEL, tables: [TABLE, ACTIVITY_TABLE] }, connector({
        tableId: TABLE.id, mode: 'upsert', keyField: 'id',
        incremental: { field: 'receivedAt', format: 'iso' },
        retentionDays: 30,
        dependents: [{ tableId: ACTIVITY_TABLE.id, relationField: 'request', parentTableId: TABLE.id, retentionCascade: true }],
    }), { _deps: h._deps });

    assert.deepStrictEqual(purges, [
        { table: 'emails', mode: 'column', field: 'received' },
        { table: 'activity', mode: 'cascade', parent: 'emails', relationField: 'request' },
    ], 'the cascade runs AFTER the parent purge it inherits its age from');
});

test('planRetention: dependents ride the same plan, after the primary and every child', () => {
    const datedChild = {
        ...CHILD_TABLE,
        fields: [...CHILD_TABLE.fields, { id: 'fld_100009', key: 'received', name: 'receivedAt', type: 'datetime', sourcePath: 'receivedAt' }],
    };
    const plan = connectorSync.planRetention({ tables: [TABLE, datedChild, LINES_TABLE, ACTIVITY_TABLE] }, connector({
        tableId: TABLE.id,
        incremental: { field: 'receivedAt', format: 'iso' },
        retentionDays: 30,
        children: [{ tableId: datedChild.id, level: 1, relationField: 'emails_ref' }],
        dependents: [
            { tableId: ACTIVITY_TABLE.id, relationField: 'request', parentTableId: TABLE.id, retentionCascade: true },
            { tableId: LINES_TABLE.id, retentionField: 'added_at' },
        ],
    }));
    assert.deepStrictEqual(plan.unreachable, []);
    assert.deepStrictEqual(plan.steps.map((s) => [s.table.key, s.mode]),
        [['emails', 'column'], ['attachments', 'column'], ['activity', 'cascade'], ['quote_lines', 'column']],
        'dependents keep declared order, after the primary and the children');
});

test('planRetention: a dependent that neither dates nor cascades is UNREACHABLE — the gap is visible now', () => {
    // The quote-intake shape before this existed: linked by a text thread_key,
    // no date column declared, no relation to follow. It used to land in
    // neither steps nor unreachable, so the save-gate never fired and the rows
    // outlived the purge as orphans.
    const bare = connectorSync.planRetention({ tables: [TABLE, LINES_TABLE] }, connector({
        tableId: TABLE.id, incremental: { field: 'receivedAt', format: 'iso' }, retentionDays: 30,
        dependents: [{ tableId: LINES_TABLE.id }],
    }));
    assert.deepStrictEqual(bare.unreachable, ['quote_lines']);

    // A TEXT column does not count either: the connector never writes a
    // dependent, so there is no controlled stamp format to trust — comparing an
    // ISO cutoff against app-typed text would purge on string luck.
    const textDated = connectorSync.planRetention({ tables: [TABLE, LINES_TABLE] }, connector({
        tableId: TABLE.id, incremental: { field: 'receivedAt', format: 'iso' }, retentionDays: 30,
        dependents: [{ tableId: LINES_TABLE.id, retentionField: 'thread_key' }],
    }));
    assert.deepStrictEqual(textDated.unreachable, ['quote_lines']);

    // A cascade at a table this connector never purges can never see an orphan.
    const strayParent = connectorSync.planRetention({ tables: [TABLE, LINES_TABLE, ACTIVITY_TABLE] }, connector({
        tableId: TABLE.id, incremental: { field: 'receivedAt', format: 'iso' }, retentionDays: 30,
        dependents: [{ tableId: ACTIVITY_TABLE.id, relationField: 'request', parentTableId: LINES_TABLE.id, retentionCascade: true }],
    }));
    assert.deepStrictEqual(strayParent.unreachable, ['activity']);
});

// ── Dependents' FILES ride the same purge ───────────────────────────────────
// collectExpiredFiles operates on the emitted steps generically, so a file
// column on a dependent table (the CAD drawing on a quote line) is collected
// before the rows go — and the sha refcount spans tables, since the ledger is
// app-wide.

/** Like retentionHarness, but with expiring rows per TABLE. */
function dependentFilesHarness({ attsExpiring, linesExpiring, ledger }) {
    const h = harness({ runs: [{ rows: [{ id: 'p1', receivedAt: '2026-08-01T00:00:00Z' }] }] });
    const deleted = { ledger: [], blobs: [] };
    let rows = [...ledger];

    h._deps.compileDeleteOlderThan = (t) => ({ sql: `DELETE FROM ${t.key}`, params: [], where: '1=1', whereParams: [] });
    h._deps.exec = async () => ({ changes: 1 });
    h._deps.query = async (_o, _a, sql) => {
        if (/FROM "atts"/.test(sql)) return { rows: attsExpiring };
        if (/FROM "quote_lines"/.test(sql)) return { rows: linesExpiring };
        return { rows: [] };
    };
    h._deps.listAttachments = async () => rows;
    h._deps.deleteAttachment = async (id) => { deleted.ledger.push(id); rows = rows.filter((r) => r.id !== id); return true; };
    h._deps.deleteFile = async (key) => { deleted.blobs.push(key); };
    h._deps.buildAttachmentKey = (owner, appId, sha) => `${owner}/${appId}/${sha}`;
    return { h, deleted };
}

async function runDependentRetention(h) {
    return connectorSync.syncConnector(app, { ...MODEL, tables: [FILE_TABLE, LINES_TABLE] }, connector({
        tableId: FILE_TABLE.id, mode: 'upsert', keyField: 'id',
        incremental: { field: 'receivedAt', format: 'iso' },
        retentionDays: 30,
        dependents: [{ tableId: LINES_TABLE.id, retentionField: 'added_at' }],
    }), { _deps: h._deps });
}

const depDesc = (fileId) => JSON.stringify({ kind: 'studio_attachment', fileId });

test("a dependent's expired file loses its ledger row, but a blob another table still names survives", async () => {
    const { h, deleted } = dependentFilesHarness({
        attsExpiring: [],                                   // the primary row holding f2 is still live
        linesExpiring: [{ drawing: depDesc('f1') }],        // the quote line with the drawing expires
        ledger: [{ id: 'f1', sha256: 'shared', size: 10 }, { id: 'f2', sha256: 'shared', size: 10 }],
    });
    await runDependentRetention(h);

    assert.deepStrictEqual(deleted.ledger, ['f1'], "the dependent's ledger row goes — its file column WAS collected");
    assert.deepStrictEqual(deleted.blobs, [], 'the bytes stay — a live row in the OTHER table still names that sha');
});

test('when the last reference falls — across two tables in one purge — the blob goes too', async () => {
    const { h, deleted } = dependentFilesHarness({
        attsExpiring: [{ file: depDesc('f2') }],
        linesExpiring: [{ drawing: depDesc('f1') }],
        ledger: [{ id: 'f1', sha256: 'shared', size: 10 }, { id: 'f2', sha256: 'shared', size: 10 }],
    });
    await runDependentRetention(h);

    assert.deepStrictEqual(deleted.ledger, ['f2', 'f1'], 'primary step first, dependent after');
    assert.deepStrictEqual(deleted.blobs, ['owner-1/app-1/shared'], 'gone exactly once, when the LAST reference fell');
});
