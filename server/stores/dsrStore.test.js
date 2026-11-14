// @typecheck
/**
 * dsrStore — the one-month clock, the one-time extension, identity verification
 * and the timeline, against a real Postgres (PGlite behind db.js's pool,
 * testUtils/pglitePool.js) with the store's own schema; NOW() is pinned
 * (testUtils/pgliteClock.js) for the SLA counts.
 *
 * The things a regulator would ask about are pinned here:
 *   - due_at is received + one calendar month (public form: now; manual
 *     intake: received_at), clamped to the end of a short month;
 *   - an extension is granted ONCE, moves due_at to received + three calendar
 *     months and needs a reason (Art. 12(3));
 *   - every mutation is scoped to the organisation;
 *   - the deadline feed carries no e-mail address;
 *   - the verify token is single-use.
 *
 * Run: cd server && node --test stores/dsrStore.test.js
 */

'use strict';

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');
const { pinPgliteNow } = require('../testUtils/pgliteClock');
const { insertRow } = require('../testUtils/pgliteSeed');
const { addCalendarMonths } = require('../utils/calendarMonths');

const { pg, close } = usePglitePool();
const store = require('./dsrStore');
const { _resetAllForTests } = require('./lib/storeInit');

const DAY = 86400 * 1000;
const D = DAY;
// The database clock: one fixed instant, so a row can sit EXACTLY on a deadline.
const NOW_MS = Date.parse('2026-09-11T12:00:00.000Z');

before(async () => {
    await store.initDB();
    await pinPgliteNow(pg, new Date(NOW_MS));
});
after(close);
beforeEach(() => pg.exec('TRUNCATE dsr_requests RESTART IDENTITY'));

const stored = async (id) => (await pg.query('SELECT * FROM dsr_requests WHERE id = $1', [id])).rows[0];
const allRows = async () => (await pg.query('SELECT * FROM dsr_requests ORDER BY id')).rows;
const iso = (d) => (d == null ? null : new Date(d).toISOString());

// ── DDL ──────────────────────────────────────────────────────────────────

test('boot DDL adds every redesign column with its default and the partial due index', async () => {
    const { rows } = await pg.query(`SELECT column_name, column_default FROM information_schema.columns WHERE table_name = 'dsr_requests'`);
    const col = Object.fromEntries(rows.map((r) => [r.column_name, r.column_default]));
    for (const c of ['channel', 'identity_status', 'identity_verified_at', 'created_by', 'started_at', 'started_by',
        'extended_until', 'extension_reason', 'extended_by', 'extended_at', 'due_at', 'timeline', 'verify_token_hash']) {
        assert.ok(c in col, c);
    }
    const bare = await insertRow(pg, 'dsr_requests', { request_type: 'access', subject_email: 'a@example.test' });
    assert.strictEqual(bare.channel, 'public_form');
    assert.strictEqual(bare.identity_status, 'unverified');
    assert.deepStrictEqual(bare.timeline, []);
    const idx = await pg.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_dsr_org_due'`);
    assert.match(idx.rows[0].indexdef, /\(organization_id, due_at\) WHERE \(status = ANY \(ARRAY\['pending'::text, 'in_progress'::text\]\)\)/);
});

test('boot backfills due_at = created_at + one calendar month on rows that have none, and leaves the rest', async () => {
    const legacy = await insertRow(pg, 'dsr_requests', { request_type: 'access', subject_email: 'a@example.test', created_at: '2027-01-31T10:00:00.000Z' });
    const dated = await insertRow(pg, 'dsr_requests', {
        request_type: 'access', subject_email: 'b@example.test', created_at: '2026-01-01T00:00:00.000Z', due_at: '2026-04-01T00:00:00.000Z',
    });
    _resetAllForTests();   // a second boot of the same process
    await store.initDB();
    assert.strictEqual(iso((await stored(legacy.id)).due_at), '2027-02-28T10:00:00.000Z', 'Postgres clamps the month too');
    assert.strictEqual(iso((await stored(dated.id)).due_at), '2026-04-01T00:00:00.000Z');
});

// ── intake ───────────────────────────────────────────────────────────────

test('createRequest: due_at = created_at + one calendar month, channel public_form, identity unverified, timeline opens with received', async () => {
    const out = await store.createRequest({ organization_id: 'orgA', subject_email: ' Jan@Example.TEST ', request_type: 'deletion' });
    const row = await stored(out.id);
    assert.strictEqual(row.subject_email, 'jan@example.test', 'normalised');
    assert.strictEqual(row.organization_id, 'orgA');
    assert.strictEqual(row.status, 'pending');
    assert.strictEqual(row.channel, 'public_form');
    assert.strictEqual(row.identity_status, 'unverified');
    assert.strictEqual(iso(row.due_at), addCalendarMonths(row.created_at, 1).toISOString());
    assert.strictEqual(iso(out.due_at), iso(row.due_at));
    assert.strictEqual(row.timeline.length, 1);
    assert.strictEqual(row.timeline[0].kind, 'received');
    assert.strictEqual(row.timeline[0].by, null);
    assert.strictEqual(row.timeline[0].channel, 'public_form');
    assert.strictEqual(row.timeline[0].at, iso(row.created_at), 'received-at equals the clock start');
});

test('createRequest validates type and channel', async () => {
    await assert.rejects(() => store.createRequest({ subject_email: 'a@b.c', request_type: 'revenge' }), /invalid request_type/);
    await assert.rejects(() => store.createRequest({ subject_email: 'a@b.c', channel: 'carrier_pigeon' }), /invalid channel/);
    await assert.rejects(() => store.createRequest({}), /subject_email/);
});

test('createManual: identity verified_manual, clock starts at received_at, actor stamped, two timeline events', async () => {
    const received = '2026-09-01T09:00:00.000Z';
    const out = await store.createManual('orgA', {
        subject_email: 'Piet@example.test', request_type: 'access', channel: 'letter',
        notes: 'Brief ontvangen per post', received_at: received, created_by: 'dpo-1',
    });
    const row = await stored(out.id);
    assert.strictEqual(out.identity_status, 'verified_manual');
    assert.strictEqual(row.organization_id, 'orgA');
    assert.strictEqual(row.channel, 'letter');
    assert.strictEqual(row.created_by, 'dpo-1');
    assert.strictEqual(iso(row.created_at), received);
    assert.strictEqual(iso(row.due_at), '2026-10-01T09:00:00.000Z');
    assert.ok(row.identity_verified_at instanceof Date);
    assert.deepStrictEqual(row.timeline.map((e) => e.kind), ['received', 'identity_verified']);
    assert.strictEqual(row.timeline[0].by, 'dpo-1');
    assert.strictEqual(row.timeline[0].text, 'Brief ontvangen per post');
    assert.strictEqual(row.timeline[1].method, 'manual');
});

test('the clock is one calendar month, not 30 days: received 31 Jan → due end of February', async () => {
    // EDPB Guidelines 01/2022 (Reg. 1182/71): a request received on 31 January
    // runs until the end of 28 February. 30 days would land on 2 March.
    const out = await store.createManual('orgA', {
        subject_email: 'a@example.test', request_type: 'access', received_at: '2026-01-31T10:00:00.000Z', created_by: 'dpo-1',
    });
    assert.strictEqual(iso((await stored(out.id)).due_at), '2026-02-28T10:00:00.000Z');
    // The extension is two further months on top: three calendar months from
    // receipt, 30 April — 90 days would land on 1 May.
    await store.extend('orgA', out.id, { reason: 'Complex request', by: 'dpo-1' });
    const row = await stored(out.id);
    assert.strictEqual(iso(row.extended_until), '2026-04-30T10:00:00.000Z');
    assert.strictEqual(iso(row.due_at), iso(row.extended_until));
});

test('createManual guards: org, e-mail, actor, future received_at, bad channel', async () => {
    await assert.rejects(() => store.createManual(null, { subject_email: 'a@b.c', created_by: 'u' }), /organization_id/);
    await assert.rejects(() => store.createManual('o', { created_by: 'u' }), /subject_email/);
    await assert.rejects(() => store.createManual('o', { subject_email: 'a@b.c' }), /created_by/);
    await assert.rejects(() => store.createManual('o', { subject_email: 'a@b.c', created_by: 'u', received_at: new Date(Date.now() + DAY).toISOString() }), /future/);
    await assert.rejects(() => store.createManual('o', { subject_email: 'a@b.c', created_by: 'u', channel: /** @type {any} */ ('fax') }), /invalid channel/);
    assert.strictEqual((await allRows()).length, 0);
});

// ── lifecycle ────────────────────────────────────────────────────────────

async function seed(overrides = {}) {
    const { id } = await store.createRequest({ organization_id: 'orgA', subject_email: 'x@example.test', request_type: 'access' });
    const cols = Object.keys(overrides);
    if (cols.length) {
        await pg.query(`UPDATE dsr_requests SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...cols.map((c) => overrides[c])]);
    }
    return id;
}

test('start: pending → in_progress with actor + timestamp, timeline "started"; idempotent afterwards', async () => {
    const id = await seed();
    const out = await store.start('orgA', id, 'u-7');
    const row = await stored(id);
    assert.strictEqual(row.status, 'in_progress');
    assert.strictEqual(row.started_by, 'u-7');
    assert.ok(row.started_at instanceof Date);
    assert.deepStrictEqual(out.timeline.map((e) => e.kind), ['received', 'started']);
    assert.strictEqual(out.timeline[1].by, 'u-7');

    const again = await store.start('orgA', id, 'u-8');
    assert.strictEqual(again.started_by, 'u-7', 'a second start changes nothing');
    assert.strictEqual(again.timeline.length, 2, 'no second started event');
    assert.strictEqual((await stored(id)).timeline.length, 2);
    await assert.rejects(() => store.start('orgA', id, null), /userId/);
});

test('extend: once only, needs a reason, due_at = extended_until = created_at + three calendar months, timeline "extended"', async () => {
    const id = await seed();
    await assert.rejects(() => store.extend('orgA', id, { by: 'u' }), /reason is required/);

    const out = await store.extend('orgA', id, { reason: 'Complex request, three systems', by: 'dpo-1' });
    const row = await stored(id);
    assert.strictEqual(iso(row.extended_until), addCalendarMonths(row.created_at, 3).toISOString());
    assert.strictEqual(iso(row.due_at), iso(row.extended_until), 'the deadline follows the extension');
    assert.strictEqual(row.extension_reason, 'Complex request, three systems');
    assert.strictEqual(row.extended_by, 'dpo-1');
    assert.ok(row.extended_at instanceof Date);
    const ev = out.timeline.at(-1);
    assert.strictEqual(ev.kind, 'extended');
    assert.strictEqual(ev.text, 'Complex request, three systems');
    assert.strictEqual(ev.until, iso(row.extended_until));

    await assert.rejects(() => store.extend('orgA', id, { reason: 'again', by: 'dpo-1' }), store.AlreadyExtendedError);
    await assert.rejects(() => store.extend('orgA', id, { reason: 'again', by: 'dpo-1' }), { code: 'dsr_already_extended' });
    // GDPR Art. 12(3): the extension is by two further months, not "one extension" of an unstated length.
    await assert.rejects(() => store.extend('orgA', id, { reason: 'again', by: 'dpo-1' }), { message: /Art\. 12\(3\) allows one extension by two further months/ });
    assert.strictEqual((await stored(id)).timeline.length, 2, 'the refused attempt left no trace');
});

test('extend: the database guard alone also refuses when another extension lands between the read and the UPDATE', async () => {
    const id = await seed();
    const pool = require('../db').pool;
    const realQuery = pool.query;
    let raced = false;
    // The read sees the row unextended; before the store's UPDATE runs, a
    // concurrent extension is really written.
    pool.query = /** @type {any} */ (async (sql, params) => {
        const res = await realQuery.call(pool, sql, params);
        if (!raced && /^\s*SELECT \* FROM dsr_requests/i.test(sql)) {
            raced = true;
            await pg.query(`UPDATE dsr_requests SET extended_at = NOW(), extension_reason = 'the other one' WHERE id = $1`, [id]);
        }
        return res;
    });
    try {
        await assert.rejects(() => store.extend('orgA', id, { reason: 'x', by: 'u' }), store.AlreadyExtendedError);
    } finally {
        pool.query = realQuery;
    }
    assert.ok(raced);
    const row = await stored(id);
    assert.strictEqual(row.extension_reason, 'the other one', 'the first extension stands');
    assert.strictEqual(row.timeline.length, 1, 'and the refused one left no event');
});

test('extend: unknown request → null; closed request → error', async () => {
    assert.strictEqual(await store.extend('orgA', 999, { reason: 'x' }), null);
    const id = await seed({ status: 'fulfilled' });
    await assert.rejects(() => store.extend('orgA', id, { reason: 'x' }), /cannot extend a fulfilled request/);
    await assert.rejects(() => store.extend('orgA', id, { reason: 'x' }), { code: 'dsr_not_open' });
});

test('verifyIdentity: email_link and manual set the status + stamp and append the event; bad method rejected', async () => {
    const id = await seed();
    const a = await store.verifyIdentity('orgA', id, { method: 'email_link' });
    let row = await stored(id);
    assert.strictEqual(row.identity_status, 'verified_email_link');
    assert.ok(row.identity_verified_at instanceof Date);
    assert.deepStrictEqual(a.timeline.at(-1), { ...a.timeline.at(-1), kind: 'identity_verified', by: null, method: 'email_link' });

    const b = await store.verifyIdentity('orgA', id, { method: 'manual', by: 'dpo-1' });
    row = await stored(id);
    assert.strictEqual(row.identity_status, 'verified_manual');
    assert.strictEqual(b.timeline.at(-1).by, 'dpo-1');
    assert.deepStrictEqual(row.timeline.map((e) => e.kind), ['received', 'identity_verified', 'identity_verified']);

    await assert.rejects(() => store.verifyIdentity('orgA', id, { method: /** @type {any} */ ('telepathy') }), /invalid identity method/);
    await assert.rejects(() => store.verifyIdentity('orgA', id, { method: 'manual' }), /by is required/);
});

test('appendTimeline: atomic jsonb append, kind required, text capped, at defaults to now', async () => {
    const id = await seed();
    const long = 'x'.repeat(3000);
    const out = await store.appendTimeline('orgA', id, { kind: 'note', text: long, by: 'u-1' });
    const ev = out.timeline.at(-1);
    assert.strictEqual(ev.kind, 'note');
    assert.strictEqual(ev.text.length, 2000);
    assert.strictEqual(ev.by, 'u-1');
    assert.ok(!Number.isNaN(Date.parse(ev.at)));
    // Two appends that both read the row first: the second must not drop the first.
    await Promise.all([
        store.appendTimeline('orgA', id, { kind: 'note', text: 'a' }),
        store.appendTimeline('orgA', id, { kind: 'note', text: 'b' }),
    ]);
    assert.deepStrictEqual((await stored(id)).timeline.map((e) => e.text ?? e.kind).slice(1), [long.slice(0, 2000), 'a', 'b']);
    await assert.rejects(() => store.appendTimeline('orgA', id, /** @type {any} */ ({ text: 'no kind' })), /event.kind/);
});

test('updateStatus appends fulfilled/rejected events and keeps an earlier fulfilled stamp', async () => {
    const id = await seed();
    const out = await store.updateStatus('orgA', id, 'fulfilled', { fulfilledBy: 'u-2', resultSummary: 'Export sent' });
    const row = await stored(id);
    assert.strictEqual(row.status, 'fulfilled');
    assert.ok(row.fulfilled_at instanceof Date);
    assert.strictEqual(row.fulfilled_by, 'u-2');
    assert.strictEqual(row.result_summary, 'Export sent');
    const ev = out.timeline.at(-1);
    assert.strictEqual(ev.kind, 'fulfilled');
    assert.strictEqual(ev.by, 'u-2');
    assert.strictEqual(ev.text, 'Export sent');

    const r2 = await seed();
    await store.updateStatus('orgA', r2, 'pending');
    assert.strictEqual((await stored(r2)).timeline.length, 1, 'pending writes no event');
    await assert.rejects(() => store.updateStatus('orgA', r2, 'lost'), /invalid status/);
});

// ── verify token ─────────────────────────────────────────────────────────

test('verify token is single-use: consume matches the hash once, then never again', async () => {
    const id = await seed();
    assert.strictEqual(await store.setVerifyTokenHash('orgA', id, 'h-abc'), true);
    assert.strictEqual((await stored(id)).verify_token_hash, 'h-abc');
    assert.strictEqual(await store.consumeVerifyToken('orgA', id, 'wrong'), false);
    assert.strictEqual((await stored(id)).verify_token_hash, 'h-abc', 'a wrong hash burns nothing');
    assert.strictEqual(await store.consumeVerifyToken('orgB', id, 'h-abc'), false, 'nor does another organisation');
    assert.strictEqual(await store.consumeVerifyToken('orgA', id, 'h-abc'), true);
    assert.strictEqual((await stored(id)).verify_token_hash, null, 'burned');
    assert.strictEqual(await store.consumeVerifyToken('orgA', id, 'h-abc'), false, 'second click finds nothing');
    assert.strictEqual(await store.consumeVerifyToken('orgA', id, null), false);
    await assert.rejects(() => store.setVerifyTokenHash('orgA', id, ''), /hash/);
});

// ── reads ────────────────────────────────────────────────────────────────

test('listRequests returns the new columns (e-mail unmasked — masking is the route\'s job) and synthesises legacy timelines', async () => {
    await insertRow(pg, 'dsr_requests', {
        organization_id: 'orgA', request_type: 'access', subject_email: 'old@example.test', status: 'fulfilled',
        created_at: '2026-01-01T00:00:00.000Z', fulfilled_at: '2026-01-10T00:00:00.000Z', fulfilled_by: 'u-9',
    });
    await insertRow(pg, 'dsr_requests', { organization_id: 'orgB', request_type: 'access', subject_email: 'other@example.test' });
    const before = await allRows();
    const list = await store.listRequests('orgA');
    assert.strictEqual(list.length, 1, 'org-scoped');
    for (const col of ['channel', 'identity_status', 'identity_verified_at', 'created_by', 'started_at', 'started_by',
        'extended_until', 'extension_reason', 'extended_by', 'extended_at', 'due_at', 'timeline']) {
        assert.ok(col in list[0], col);
    }
    assert.strictEqual(list[0].subject_email, 'old@example.test');
    assert.deepStrictEqual(list[0].timeline.map((e) => e.kind), ['received', 'fulfilled'], 'legacy row → synthesised trail');
    assert.strictEqual(list[0].timeline[1].by, 'u-9');
    assert.deepStrictEqual(await allRows(), before, 'synthesis is read-only');
});

test('listOpenWithDeadlines: open statuses ordered by due_at, org-scoped, and NO subject_email in a row', async () => {
    const late = await seed({ due_at: new Date(NOW_MS + 2 * D) });
    const early = await seed({ due_at: new Date(NOW_MS + D), status: 'in_progress' });
    await seed({ status: 'fulfilled' });
    await store.createRequest({ organization_id: 'orgB', subject_email: 'b@example.test' });
    const list = await store.listOpenWithDeadlines('orgA');
    assert.deepStrictEqual(list.map((r) => r.id), [early, late]);
    for (const r of list) assert.ok(!('subject_email' in r), 'the deadline feed never carries the address');
});

test('getSlaStats counts overdue from due_at: not at the deadline, yes one second past it, and an extension moves it', async () => {
    const at = (offset) => new Date(NOW_MS + offset);
    const seedRow = (over) => insertRow(pg, 'dsr_requests', {
        organization_id: 'orgA', request_type: 'access', subject_email: 'x@example.test',
        status: 'pending', created_at: at(-29 * D), ...over,
    });

    await seedRow({ due_at: at(1000) });                                   // A: one second to go
    await seedRow({ due_at: at(0), created_at: at(-30 * D) });             // B: EXACTLY at due_at — still in time
    await seedRow({ due_at: at(-1000), created_at: at(-30 * D - 1000) });  // C: one second past → overdue
    await seedRow({ status: 'in_progress', created_at: at(-40 * D), due_at: at(-10 * D) }); // D: long overdue
    await seedRow({ status: 'fulfilled', created_at: at(-40 * D), due_at: at(-10 * D), fulfilled_at: at(-35 * D) }); // E: closed, never overdue
    // F: created 40 d ago — overdue under a created_at + 30 d rule — but the
    // one-time extension moved the deadline out, so it is NOT overdue.
    const f = await seedRow({ created_at: at(-40 * D), extended_at: at(-11 * D), extended_until: at(50 * D), due_at: at(50 * D) });
    // Out of scope: another org, another type, outside the window.
    await seedRow({ organization_id: 'orgB', due_at: at(-D) });
    await seedRow({ request_type: 'deletion', due_at: at(-D) });
    await seedRow({ created_at: at(-400 * D), due_at: at(-370 * D) });

    const stats = await store.getSlaStats('orgA', 'access', 365);
    assert.strictEqual(stats.total, 6);
    assert.strictEqual(stats.open, 5, 'the fulfilled row is not open');
    assert.strictEqual(stats.fulfilled, 1);
    assert.strictEqual(stats.overdue, 2, 'only C and D: the boundary row is in time and the extended row is not overdue');
    assert.strictEqual(stats.nearing, 2, 'A (one second to go) and B (exactly at due_at) are due within 5 days; F, extended 50 days out, is not');
    assert.strictEqual(Number(stats.avg_days_to_fulfil), 5);

    // Put the extended row's deadline back where it would sit without the
    // extension: the same row now counts.
    await pg.query('UPDATE dsr_requests SET due_at = $2 WHERE id = $1', [f.id, at(-10 * D)]);
    assert.strictEqual((await store.getSlaStats('orgA', 'access', 365)).overdue, 3);
    const empty = await store.getSlaStats('nobody', 'access');
    assert.deepStrictEqual({ ...empty, avg_days_to_fulfil: Number(empty.avg_days_to_fulfil) },
        { total: 0, fulfilled: 0, open: 0, overdue: 0, nearing: 0, avg_days_to_fulfil: 0 },
        'an org with no requests reads zeroes, never a null row');
});

// ── invariants ───────────────────────────────────────────────────────────

test('a foreign organisation changes nothing through any mutation', async () => {
    const id = await seed();
    await store.setVerifyTokenHash('orgA', id, 'h');
    const before = await stored(id);
    await store.start('orgB', id, 'u');
    await store.verifyIdentity('orgB', id, { method: 'email_link' });
    await store.appendTimeline('orgB', id, { kind: 'note', text: 'x' });
    assert.strictEqual(await store.extend('orgB', id, { reason: 'r' }), null);
    assert.strictEqual(await store.setVerifyTokenHash('orgB', id, 'h2'), false);
    assert.strictEqual(await store.consumeVerifyToken('orgB', id, 'h'), false);
    await store.updateStatus('orgB', id, 'fulfilled', { fulfilledBy: 'u' });
    assert.deepStrictEqual(await stored(id), before);
});

test('constants exported for the routes: channels, identity statuses, SLA months', () => {
    assert.deepStrictEqual(store.VALID_CHANNELS, ['public_form', 'email_dpo', 'phone', 'letter', 'other']);
    assert.deepStrictEqual(store.IDENTITY_STATUSES, ['unverified', 'verified_email_link', 'verified_manual']);
    assert.strictEqual(store.SLA_MONTHS, 1);
    assert.strictEqual(store.EXTENDED_SLA_MONTHS, 3);
});
