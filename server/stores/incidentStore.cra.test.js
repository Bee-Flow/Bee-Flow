// @typecheck
/**
 * incidentStore — the multi-regime register: clock math per regime, the
 * "earliest clock wins" deadline, the CRA / NIS2 / DORA stamps and their org
 * scoping. Against a real Postgres (PGlite behind db.js's pool,
 * testUtils/pglitePool.js) with the store's own schema, and NOW() pinned
 * (testUtils/pgliteClock.js) so the predicates that turn on it are measured at
 * their edges, one second either side.
 *
 * Run: cd server && node --test stores/incidentStore.cra.test.js
 */

'use strict';

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');
const { pinPgliteNow } = require('../testUtils/pgliteClock');
const { insertRow } = require('../testUtils/pgliteSeed');
const { addCalendarMonths } = require('../utils/calendarMonths');

const { pg, close } = usePglitePool();
const store = require('./incidentStore');
const { _resetAllForTests } = require('./lib/storeInit');

const H = 3600 * 1000;
const D = 24 * H;
const SECOND = 1000;
const T0 = new Date('2026-09-10T10:00:00.000Z');
const NOW = new Date('2026-09-11T12:00:00.000Z');
const hoursAfter = (d) => (new Date(d).getTime() - T0.getTime()) / H;
const AT = (ms) => new Date(NOW.getTime() + ms);
const iso = (d) => (d == null ? null : new Date(d).toISOString());

/** @type {{ set: (at: Date | string) => Promise<void>, release: () => Promise<void> }} */
let clock;
before(async () => {
    await store.initDB();
    clock = await pinPgliteNow(pg, NOW);
});
after(close);
beforeEach(async () => {
    await pg.exec('TRUNCATE compliance_incidents RESTART IDENTITY');
    await clock.set(NOW);
});

/** The stored row, as the database holds it. */
async function stored(id) {
    return (await pg.query('SELECT * FROM compliance_incidents WHERE id = $1', [id])).rows[0];
}

/** Row id → transaction id that last wrote it: a row nobody wrote keeps its xmin. */
async function writers() {
    const { rows } = await pg.query('SELECT id, xmin::text AS x FROM compliance_incidents ORDER BY id');
    return Object.fromEntries(rows.map((r) => [r.id, r.x]));
}

/** An incident row as an earlier version of the store (or another writer) left it. */
function putRow(overrides = {}) {
    return insertRow(pg, 'compliance_incidents', {
        organization_id: 'orgA', title: 'seeded', status: 'open', kind: 'breach',
        regimes: ['GDPR'], notes: [], detected_at: new Date(NOW.getTime() - 3 * D),
        deadline_at: null,
        ...overrides,
    });
}

// ── DDL ──────────────────────────────────────────────────────────────────

test('boot DDL adds the register columns with the contract defaults and the kind index', async () => {
    const { rows } = await pg.query(`
        SELECT column_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'compliance_incidents'`);
    const col = Object.fromEntries(rows.map((r) => [r.column_name, r]));
    for (const c of ['kind', 'regimes', 'early_warning_due_at', 'early_warning_sent_at', 'final_report_due_at',
        'final_report_sent_at', 'customer_notified_at', 'reported_via', 'cve_ids', 'affected_products', 'exploited_in_wild']) {
        assert.ok(col[c], c);
    }
    assert.strictEqual(col.kind.is_nullable, 'NO');
    assert.match(col.kind.column_default, /'breach'/);
    assert.strictEqual(col.regimes.is_nullable, 'NO');
    assert.match(col.regimes.column_default, /\["GDPR"\]/);
    // "Nothing is due" has to be expressible, so the roll-up column is nullable.
    assert.strictEqual(col.deadline_at.is_nullable, 'YES');
    const idx = await pg.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_incidents_org_kind'`);
    assert.match(idx.rows[0].indexdef, /\(organization_id, kind, status\)/);
    const row = await insertRow(pg, 'compliance_incidents', { organization_id: 'orgA', title: 'bare', deadline_at: null });
    assert.strictEqual(row.kind, 'breach');
    assert.deepStrictEqual(row.regimes, ['GDPR']);
});

// ── clock math (pure) ────────────────────────────────────────────────────

test('computeClocks: GDPR only → 72 h deadline, no early warning, no final report', () => {
    const c = store.computeClocks(T0, { regimes: ['GDPR'] });
    assert.strictEqual(hoursAfter(c.deadline_at), 72);
    assert.strictEqual(c.early_warning_due_at, null);
    assert.strictEqual(c.final_report_due_at, null);
    assert.strictEqual(c.customer_notice_due_at, null);
});

test('computeClocks: NIS2 → 24 h early warning, 72 h notification, final report +1 calendar month', () => {
    const c = store.computeClocks(T0, { regimes: ['NIS2'] });
    assert.strictEqual(hoursAfter(c.early_warning_due_at), 24);
    assert.strictEqual(hoursAfter(c.notification_due_at), 72);
    assert.strictEqual(c.final_report_due_at.toISOString(), '2026-10-10T10:00:00.000Z');
    assert.strictEqual(hoursAfter(c.deadline_at), 24, 'the early warning is the next thing due');
});

test('computeClocks: CRA → 24 h / 72 h / +14 d', () => {
    const c = store.computeClocks(T0, { regimes: ['CRA'] });
    assert.strictEqual(hoursAfter(c.early_warning_due_at), 24);
    assert.strictEqual(hoursAfter(c.notification_due_at), 72);
    assert.strictEqual(hoursAfter(c.final_report_due_at), 14 * 24);
    assert.strictEqual(hoursAfter(c.deadline_at), 24);
});

test('computeClocks: a CRA severe incident\'s final report is one month after the notification, not 14 days (Art. 14(4)(c))', () => {
    // Not notified yet: from the latest lawful notification, detected + 72 h.
    const open = store.computeClocks(T0, { regimes: ['CRA'], kind: 'security_incident' });
    assert.strictEqual(open.final_report_due_at.toISOString(), '2026-10-13T10:00:00.000Z');
    assert.strictEqual(hoursAfter(open.early_warning_due_at), 24, 'the early warning and the notification are unchanged');
    assert.strictEqual(hoursAfter(open.notification_due_at), 72);
    // Notified: one calendar month from that stamp, clamped at a short month.
    const notified = store.computeClocks(T0, { regimes: ['CRA'], kind: 'breach', notifiedAt: '2026-09-11T08:00:00.000Z' });
    assert.strictEqual(notified.final_report_due_at.toISOString(), '2026-10-11T08:00:00.000Z');
    const jan = store.computeClocks('2027-01-30T10:00:00.000Z', { regimes: ['CRA'], kind: 'security_incident', notifiedAt: '2027-01-31T09:00:00.000Z' });
    assert.strictEqual(jan.final_report_due_at.toISOString(), '2027-02-28T09:00:00.000Z', 'never an overflow into March');
    // A vulnerability keeps the 14-day clock (Art. 14(2)(c)), and so does a call without a kind.
    assert.strictEqual(hoursAfter(store.computeClocks(T0, { regimes: ['CRA'], kind: 'vulnerability' }).final_report_due_at), 14 * 24);
    // On a NIS2 + CRA incident the earlier NIS2 final report still wins.
    const mixed = store.computeClocks(T0, { regimes: ['NIS2', 'CRA'], kind: 'security_incident' });
    assert.strictEqual(mixed.final_report_due_at.toISOString(), '2026-10-10T10:00:00.000Z');
});

test('computeClocks: DORA → customer notice after the org window (default 4 h), and that is the deadline', () => {
    const def = store.computeClocks(T0, { regimes: ['DORA'] });
    assert.strictEqual(hoursAfter(def.customer_notice_due_at), 4);
    assert.strictEqual(hoursAfter(def.deadline_at), 4);
    const custom = store.computeClocks(T0, { regimes: ['DORA'], customerNoticeHours: 2 });
    assert.strictEqual(hoursAfter(custom.customer_notice_due_at), 2);
    const bad = store.computeClocks(T0, { regimes: ['DORA'], customerNoticeHours: /** @type {any} */ ('soon') });
    assert.strictEqual(hoursAfter(bad.customer_notice_due_at), 4, 'garbage falls back to the default');
});

test('computeClocks: several regimes → each clock is the earliest of its regimes; deadline is the earliest of all', () => {
    const c = store.computeClocks(T0, { regimes: ['GDPR', 'NIS2', 'CRA', 'DORA'], customerNoticeHours: 4 });
    assert.strictEqual(hoursAfter(c.early_warning_due_at), 24);
    assert.strictEqual(hoursAfter(c.notification_due_at), 72);
    assert.strictEqual(hoursAfter(c.final_report_due_at), 14 * 24, 'CRA 14 d beats NIS2 one month');
    assert.strictEqual(hoursAfter(c.customer_notice_due_at), 4);
    assert.strictEqual(hoursAfter(c.deadline_at), 4, 'DORA customer notice is the earliest');
    const two = store.computeClocks(T0, { regimes: ['GDPR', 'CRA'] });
    assert.strictEqual(hoursAfter(two.deadline_at), 24);
});

test('normalizeRegimes: upper-cases, dedupes, rejects unknown codes, defaults by kind', () => {
    assert.deepStrictEqual(store.normalizeRegimes(['gdpr', 'GDPR', 'nis2']), ['GDPR', 'NIS2']);
    assert.deepStrictEqual(store.normalizeRegimes(undefined, 'breach'), ['GDPR']);
    assert.deepStrictEqual(store.normalizeRegimes([], 'vulnerability'), ['CRA']);
    assert.deepStrictEqual(store.normalizeRegimes('dora'), ['DORA']);
    assert.throws(() => store.normalizeRegimes(['HIPAA']), /invalid regime "HIPAA"/);
});

// ── createIncident ───────────────────────────────────────────────────────

test('createIncident writes kind, regimes and every clock column', async () => {
    const out = await store.createIncident({
        organization_id: 'orgA', title: 'Auth bypass in connector', kind: 'vulnerability', regimes: ['CRA', 'NIS2'],
        detected_at: T0.toISOString(), severity: 'high',
        cve_ids: ['cve-2026-12345', 'not-a-cve'], affected_products: ['Connector', { name: 'API', version_range: '<2.4' }],
        exploited_in_wild: true, reported_via: 'ENISA_SRP',
    });
    const row = await stored(out.id);
    assert.strictEqual(row.organization_id, 'orgA');
    assert.strictEqual(row.severity, 'high');
    assert.strictEqual(iso(row.detected_at), T0.toISOString());
    assert.strictEqual(hoursAfter(row.deadline_at), 24, 'deadline_at = earliest clock');
    assert.strictEqual(row.kind, 'vulnerability');
    assert.deepStrictEqual(row.regimes, ['CRA', 'NIS2']);
    assert.strictEqual(hoursAfter(row.early_warning_due_at), 24);
    assert.strictEqual(hoursAfter(row.final_report_due_at), 14 * 24);
    assert.strictEqual(row.customer_notice_due_at, null);
    assert.deepStrictEqual(row.cve_ids, ['CVE-2026-12345'], 'only well-formed CVE ids survive');
    assert.deepStrictEqual(row.affected_products, [{ name: 'Connector', version_range: null }, { name: 'API', version_range: '<2.4' }]);
    assert.strictEqual(row.exploited_in_wild, true);
    assert.strictEqual(row.reported_via, 'ENISA_SRP');
    assert.strictEqual(row.status, 'open');
});

test('createIncident: a plain breach stays a 72 h GDPR row (legacy shape); bad kind rejected; DORA uses customerNoticeHours', async () => {
    const out = await store.createIncident({ organization_id: 'orgA', title: 'Leak', detected_at: T0.toISOString() });
    assert.strictEqual(out.kind, 'breach');
    assert.deepStrictEqual(out.regimes, ['GDPR']);
    assert.strictEqual(hoursAfter(out.deadline_at), 72);
    assert.strictEqual(out.early_warning_due_at, null);
    assert.strictEqual(out.exploited_in_wild, null);
    assert.deepStrictEqual(out.cve_ids, []);

    await assert.rejects(() => store.createIncident({ organization_id: 'orgA', title: 'x', kind: /** @type {any} */ ('rumour') }), /invalid kind/);
    await assert.rejects(() => store.createIncident({ organization_id: 'orgA', title: 'x', regimes: ['SOX'] }), /invalid regime/);

    const dora = await store.createIncident({
        organization_id: 'orgA', title: 'Outage at a bank customer', kind: 'security_incident', regimes: ['DORA'],
        detected_at: T0.toISOString(), customerNoticeHours: 6, actively_exploited: false,
    });
    assert.strictEqual(hoursAfter(dora.customer_notice_due_at), 6);
    assert.strictEqual(hoursAfter(dora.deadline_at), 6);
    assert.strictEqual(dora.exploited_in_wild, false, 'actively_exploited alias accepted');
});

// ── stamps ───────────────────────────────────────────────────────────────

async function seed(extra = {}) {
    const r = await store.createIncident({
        organization_id: 'orgA', title: 'Vuln', kind: 'vulnerability', regimes: ['CRA'], detected_at: T0.toISOString(), ...extra,
    });
    return r.id;
}

test('stampCraReport early_warning: stamps once, records the channel, moves open → early_warning_sent', async () => {
    const id = await seed();
    const out = await store.stampCraReport('orgA', id, { stage: 'early_warning', reportedVia: 'MijnNCSC', by: 'u-1' });
    let row = await stored(id);
    assert.strictEqual(iso(row.early_warning_sent_at), NOW.toISOString(), 'stamped by the database clock');
    assert.strictEqual(row.reported_via, 'MijnNCSC');
    assert.strictEqual(row.authority_notified_by, 'u-1');
    assert.strictEqual(row.status, 'early_warning_sent');
    assert.strictEqual(out.status, 'early_warning_sent');

    await clock.set(AT(H));
    await store.stampCraReport('orgA', id, { stage: 'early_warning', reportedVia: 'other', by: 'u-2' });
    row = await stored(id);
    assert.strictEqual(iso(row.early_warning_sent_at), NOW.toISOString(), 'a second stamp an hour later never overwrites');
    assert.strictEqual(row.reported_via, 'other', 'the channel may be corrected');
    assert.strictEqual(row.authority_notified_by, 'u-1', 'the first actor stays');
});

test('stampCraReport full: final report + notification stamped together, reference kept, status → reported', async () => {
    const id = await seed();
    await store.stampCraReport('orgA', id, { stage: 'early_warning', by: 'u-1' });
    await clock.set(AT(2 * H));
    await store.stampCraReport('orgA', id, { stage: 'full', reference: 'SRP-2026-0042', reportedVia: 'ENISA_SRP', by: 'u-2' });
    const row = await stored(id);
    assert.strictEqual(iso(row.final_report_sent_at), iso(AT(2 * H)));
    assert.strictEqual(iso(row.authority_notified_at), iso(AT(2 * H)), 'a final report implies the notification');
    assert.strictEqual(iso(row.early_warning_sent_at), NOW.toISOString(), 'the early warning keeps its own moment');
    assert.strictEqual(row.authority_reference, 'SRP-2026-0042');
    assert.strictEqual(row.authority_notified_by, 'u-1', 'the first actor stays on the row');
    assert.strictEqual(row.status, 'reported');
    await assert.rejects(() => store.stampCraReport('orgA', id, { stage: /** @type {any} */ ('interim') }), /invalid stage/);
});

test('stamps are org-scoped: a foreign organisation hits nothing and reads null', async () => {
    const id = await seed();
    const before = await stored(id);
    const out = await store.stampCraReport('orgB', id, { stage: 'early_warning' });
    assert.strictEqual(out, null);
    const out2 = await store.stampCustomerNotified('orgB', id, 'u-9');
    assert.strictEqual(out2, null);
    const out3 = await store.updateIncident('orgB', id, { status: 'closed' }, 'u-9');
    assert.strictEqual(out3, null);
    assert.deepStrictEqual(await stored(id), before, 'the row of orgA is exactly as it was');
});

test('stampCustomerNotified: first-wins stamp plus a note naming the actor', async () => {
    const id = await seed({ regimes: ['DORA'], kind: 'security_incident' });
    const out = await store.stampCustomerNotified('orgA', id, 'u-3');
    let row = await stored(id);
    assert.strictEqual(iso(row.customer_notified_at), NOW.toISOString());
    assert.strictEqual(row.notes.at(-1).by, 'u-3');
    assert.strictEqual(iso(out.customer_notified_at), NOW.toISOString());
    await clock.set(AT(H));
    await store.stampCustomerNotified('orgA', id, null);
    row = await stored(id);
    assert.strictEqual(iso(row.customer_notified_at), NOW.toISOString(), 'never re-dated');
    assert.strictEqual(row.notes.length, 1, 'no actor, no note');
});

// ── the deadline roll-up moves with the stamps ───────────────────────────
//
// `deadline_at` is "the next thing due to somebody outside the organisation".
// Filing the early warning satisfies the 24-hour clock, so the roll-up has to
// fall through to the 72-hour notification — otherwise a row that was reported
// on time reads as overdue for ever.

test('nextOpenDeadline: only the clocks whose stamp is still missing count', () => {
    const base = {
        status: 'open', kind: 'security_incident', regimes: ['NIS2'], detected_at: T0,
        early_warning_due_at: new Date(T0.getTime() + 24 * H),
        final_report_due_at: new Date('2026-10-10T10:00:00.000Z'),
    };
    assert.strictEqual(hoursAfter(store.nextOpenDeadline(base)), 24, 'nothing filed yet → the early warning');
    assert.strictEqual(
        hoursAfter(store.nextOpenDeadline({ ...base, early_warning_sent_at: new Date() })), 72,
        'early warning filed → the 72-hour notification',
    );
    assert.strictEqual(
        store.nextOpenDeadline({ ...base, early_warning_sent_at: new Date(), authority_notified_at: new Date() }).toISOString(),
        '2026-10-10T10:00:00.000Z',
        'notified → the final report is what is left',
    );
    assert.strictEqual(
        store.nextOpenDeadline({
            ...base, early_warning_sent_at: new Date(), authority_notified_at: new Date(), final_report_sent_at: new Date(),
        }),
        null,
        'every clock met → nothing is due, not a past timestamp',
    );
    assert.strictEqual(store.nextOpenDeadline({ ...base, status: 'closed' }), null, 'a closed incident owes nothing');
});

test('stampCraReport early_warning moves deadline_at from the 24 h clock to the 72 h one', async () => {
    const row = await store.createIncident({
        organization_id: 'orgA', title: 'NIS2 incident', kind: 'security_incident',
        regimes: ['NIS2'], detected_at: T0.toISOString(),
    });
    assert.strictEqual(hoursAfter(row.deadline_at), 24, 'at intake the early warning is next');

    const out = await store.stampCraReport('orgA', row.id, { stage: 'early_warning', by: 'u-1' });
    assert.strictEqual(hoursAfter(out.deadline_at), 72, 'the filed 24 h clock no longer sets the deadline');
    assert.strictEqual(hoursAfter((await stored(row.id)).deadline_at), 72, 'and it is persisted');
});

test('stampCraReport full clears deadline_at once every CRA clock is stamped', async () => {
    const id = await seed();
    await store.stampCraReport('orgA', id, { stage: 'early_warning' });
    const out = await store.stampCraReport('orgA', id, { stage: 'full', reference: 'SRP-1' });
    assert.strictEqual(out.deadline_at, null, 'nothing is outstanding any more');
    assert.strictEqual((await stored(id)).deadline_at, null);
});

test('stampCustomerNotified clears the DORA customer clock', async () => {
    const dora = await store.createIncident({
        organization_id: 'orgA', title: 'Outage', kind: 'security_incident', regimes: ['DORA'],
        detected_at: T0.toISOString(), customerNoticeHours: 4,
    });
    assert.strictEqual(hoursAfter(dora.deadline_at), 4);
    const out = await store.stampCustomerNotified('orgA', dora.id, 'u-3');
    assert.strictEqual(out.deadline_at, null, 'the customers were told — nothing else is due under DORA');
    assert.strictEqual((await stored(dora.id)).deadline_at, null);
});

// ── reads ────────────────────────────────────────────────────────────────

test('listOpenClocks: every not-closed row with all clock columns, org-scoped, earliest deadline first', async () => {
    const gdpr = await store.createIncident({ organization_id: 'orgA', title: 'a', regimes: ['GDPR'], detected_at: T0.toISOString() });
    const vuln = await store.createIncident({ organization_id: 'orgA', title: 'b', kind: 'vulnerability', detected_at: T0.toISOString() });
    const closed = await store.createIncident({ organization_id: 'orgA', title: 'c', detected_at: T0.toISOString() });
    await store.createIncident({ organization_id: 'orgB', title: 'd', kind: 'vulnerability', detected_at: T0.toISOString() });
    await store.updateIncident('orgA', closed.id, { status: 'closed' });

    const list = await store.listOpenClocks('orgA');
    assert.deepStrictEqual(list.map((r) => r.id), [vuln.id, gdpr.id], 'the 24 h clock before the 72 h one; closed and orgB left out');
    for (const col of ['kind', 'regimes', 'early_warning_due_at', 'early_warning_sent_at', 'final_report_due_at',
        'final_report_sent_at', 'customer_notice_due_at', 'customer_notified_at', 'authority_notified_at', 'reported_via',
        'exploited_in_wild', 'cve_ids', 'affected_products']) {
        assert.ok(col in list[0], col);
    }
});

test('listIncidents filters by status and kind and honours the limit; getDeadlineStats counts open vulnerabilities', async () => {
    const v1 = await putRow({ kind: 'vulnerability', status: 'open', detected_at: AT(-H) });
    const v2 = await putRow({ kind: 'vulnerability', status: 'open', detected_at: AT(-2 * H) });
    await putRow({ kind: 'vulnerability', status: 'assessing' });
    await putRow({ kind: 'breach', status: 'open' });
    await putRow({ kind: 'vulnerability', status: 'open', organization_id: 'orgB' });

    const got = await store.listIncidents('orgA', { kind: 'vulnerability', status: 'open', limit: 10 });
    assert.deepStrictEqual(got.map((r) => r.id), [v1.id, v2.id], 'newest detection first');
    assert.strictEqual((await store.listIncidents('orgA', { kind: 'vulnerability', status: 'open', limit: 1 })).length, 1);
    assert.strictEqual((await store.listIncidents('orgA')).length, 4);
    await assert.rejects(() => store.listIncidents('orgA', { kind: 'rumour' }), /invalid kind/);

    // An early warning keeps the row open.
    await putRow({ kind: 'breach', status: 'early_warning_sent' });
    assert.strictEqual((await store.getDeadlineStats('orgA')).open, 5);
});

// ── the read side: the predicates that DECIDE, at their boundaries ───────
//
// `overdue_unnotified`, the 24-hour window and the notifier's own filter each
// turn on a comparison against NOW(). Every row below sits one second either
// side of an edge, or exactly on it, against the pinned database clock.

test('getDeadlineStats: overdue starts one tick PAST the deadline — a row standing exactly on it is not yet late', async () => {
    await putRow({ deadline_at: AT(-SECOND) });
    await putRow({ deadline_at: AT(0) });
    await putRow({ deadline_at: AT(SECOND) });

    const s = await store.getDeadlineStats('orgA');
    assert.strictEqual(s.overdue_unnotified, 1, 'only the row a second past its deadline');
    assert.strictEqual(s.nearing_deadline, 2, 'the other two are inside the 24-hour window');
    assert.strictEqual(s.open, 3);
    // The two buckets partition the open rows: nothing is both late and nearing.
    assert.strictEqual(s.overdue_unnotified + s.nearing_deadline, s.open);
});

test('getDeadlineStats: the nearing window is half-open — the row exactly 24 hours out belongs to tomorrow', async () => {
    await putRow({ deadline_at: AT(24 * H - SECOND) });
    await putRow({ deadline_at: AT(24 * H) });
    await putRow({ deadline_at: AT(24 * H + SECOND) });

    const s = await store.getDeadlineStats('orgA');
    assert.strictEqual(s.nearing_deadline, 1, 'only the row a second inside the window');
    assert.strictEqual(s.overdue_unnotified, 0);
    assert.strictEqual(s.open, 3, 'the other two are open, just not urgent');
});

test('getDeadlineStats: a notified row, a closed row and a row with nothing due are counted by neither deadline predicate', async () => {
    // The `authority_notified_at IS NULL` half of both predicates, isolated:
    // same open status, same overdue deadline, but the notification is filed.
    await putRow({ status: 'early_warning_sent', authority_notified_at: AT(-2 * H), deadline_at: AT(-D) });
    // A closed incident is out of the open bucket altogether.
    await putRow({ status: 'closed', deadline_at: AT(-D) });
    // Every clock met, so deadline_at is NULL: NULL < NOW() is never true, and
    // this row must not read as permanently overdue.
    await putRow({ status: 'assessing', deadline_at: null });
    // Another organisation's overdue row is never counted.
    await putRow({ organization_id: 'orgB', deadline_at: AT(-D) });

    const s = await store.getDeadlineStats('orgA');
    assert.strictEqual(s.overdue_unnotified, 0);
    assert.strictEqual(s.nearing_deadline, 0);
    assert.strictEqual(s.open, 2, 'the notified row and the null-deadline row are still open');
});

test('getDeadlineStats: vulnerabilities_open counts every not-closed vulnerability, whatever its clocks say', async () => {
    await putRow({ kind: 'vulnerability', status: 'reported', deadline_at: null });
    await putRow({ kind: 'vulnerability', status: 'open', deadline_at: AT(D) });
    await putRow({ kind: 'vulnerability', status: 'closed', deadline_at: AT(-D) });
    await putRow({ kind: 'breach', status: 'open', deadline_at: AT(D) });
    await putRow({ kind: 'vulnerability', status: 'open', organization_id: 'orgB', deadline_at: AT(D) });

    const s = await store.getDeadlineStats('orgA');
    assert.strictEqual(s.vulnerabilities_open, 2, 'reported still counts, closed does not, another org never does');
});

test('getDeadlineStats: the Art. 33 counts run from detected_at + 72 h, for GDPR incidents only', async () => {
    // A GDPR+NIS2 incident at hour 25: its 24 h early warning is past due, so
    // the roll-up deadline_at is overdue, but the 72 h Art. 33 deadline is not.
    await putRow({ regimes: ['GDPR', 'NIS2'], detected_at: AT(-25 * H), deadline_at: AT(-H) });
    // A CRA-only vulnerability past its early warning is never a GDPR matter.
    await putRow({ kind: 'vulnerability', regimes: ['CRA'], detected_at: AT(-80 * H), deadline_at: AT(-56 * H) });
    // GDPR incidents a second past detected_at + 72 h, exactly on it, and 22 h before it.
    await putRow({ regimes: ['GDPR'], detected_at: AT(-72 * H - SECOND), deadline_at: AT(-SECOND) });
    await putRow({ regimes: ['GDPR'], detected_at: AT(-72 * H), deadline_at: AT(0) });
    await putRow({ regimes: ['GDPR'], detected_at: AT(-50 * H), deadline_at: AT(22 * H) });
    // Notified long after its 72 h: no longer overdue.
    await putRow({ regimes: ['GDPR'], status: 'early_warning_sent', detected_at: AT(-100 * H), authority_notified_at: AT(-30 * H), deadline_at: null });

    const s = await store.getDeadlineStats('orgA');
    assert.strictEqual(s.overdue_unnotified, 3, 'the roll-up: the early warning, the CRA clock and the late GDPR row');
    assert.strictEqual(s.gdpr_overdue_unnotified, 1, 'only the GDPR row a second past detected_at + 72 h');
    assert.strictEqual(s.gdpr_nearing_deadline, 2, 'the row on the dot and the one 22 h out; the GDPR+NIS2 row is 47 h out');
});

test('listNeedingAttention: the notifier picks up everything due inside 24 hours, and stops exactly at the edge', async () => {
    const overdue = await putRow({ deadline_at: AT(-3 * H) });
    const inside = await putRow({ deadline_at: AT(24 * H - SECOND) });
    await putRow({ deadline_at: AT(24 * H) });
    await putRow({ deadline_at: AT(24 * H + SECOND) });
    await putRow({ deadline_at: null, status: 'assessing' });
    await putRow({ deadline_at: AT(-3 * H), authority_notified_at: AT(-H), status: 'early_warning_sent' });
    await putRow({ deadline_at: AT(-3 * H), status: 'closed' });
    await putRow({ deadline_at: AT(-3 * H), organization_id: 'orgB' });

    const list = await store.listNeedingAttention('orgA');
    assert.deepStrictEqual(list.map((r) => r.id), [overdue.id, inside.id], 'earliest deadline first');
});

test('hasRecentAutoIncident asks per org and per source inside the window', async () => {
    await putRow({ source: 'dlp_signal', detected_at: AT(-5 * H) });
    assert.strictEqual(await store.hasRecentAutoIncident('orgA', 'dlp_signal', 6), true);
    assert.strictEqual(await store.hasRecentAutoIncident('orgA', 'dlp_signal', 4), false, 'detected before the window');
    assert.strictEqual(await store.hasRecentAutoIncident('orgA', 'other_signal', 6), false, 'another source');
    assert.strictEqual(await store.hasRecentAutoIncident('orgB', 'dlp_signal', 6), false, 'another organisation');
});

// ── updateIncident's server-side stamps ──────────────────────────────────

test('a CRA severe incident is created with the one-month final clock and re-dated when the notification is stamped', async () => {
    const row = await store.createIncident({
        organization_id: 'orgA', title: 'Ransomware on the build server', kind: 'security_incident', regimes: ['CRA'],
        detected_at: T0.toISOString(),
    });
    assert.strictEqual(iso((await stored(row.id)).final_report_due_at), '2026-10-13T10:00:00.000Z', 'detected + 72 h + 1 month, not + 14 d');
    await store.updateIncident('orgA', row.id, { status: 'authority_notified' }, 'u-7');
    const after = await stored(row.id);
    assert.strictEqual(iso(after.authority_notified_at), NOW.toISOString());
    assert.strictEqual(iso(after.final_report_due_at), addCalendarMonths(NOW, 1).toISOString(), 'one month from the recorded notification');
});

test('a CRA vulnerability keeps its 14-day final clock through the notification stamp', async () => {
    const id = await seed();
    await store.updateIncident('orgA', id, { status: 'authority_notified' }, 'u-7');
    assert.strictEqual(hoursAfter((await stored(id)).final_report_due_at), 14 * 24);
});

test('updateIncident: status=authority_notified stamps the time and the actor itself, first-wins', async () => {
    const id = await seed({ kind: 'breach', regimes: ['GDPR'] });
    assert.strictEqual((await stored(id)).authority_notified_at, null, 'nothing stamped at intake');

    const out = await store.updateIncident('orgA', id, { status: 'authority_notified', authority_reference: 'AP-2026-1' }, 'u-7');
    let row = await stored(id);
    assert.strictEqual(iso(row.authority_notified_at), NOW.toISOString(), 'the store stamps the moment — the caller never sends it');
    assert.strictEqual(row.authority_notified_by, 'u-7');
    assert.strictEqual(row.authority_reference, 'AP-2026-1');
    assert.strictEqual(row.status, 'authority_notified');
    assert.strictEqual(out.deadline_at, null, 'Art. 33 satisfied → nothing is due to anyone outside');

    await clock.set(AT(H));
    await store.updateIncident('orgA', id, { status: 'authority_notified' }, 'u-9');
    row = await stored(id);
    assert.strictEqual(iso(row.authority_notified_at), NOW.toISOString(), 'a second save never re-dates the notification');
    assert.strictEqual(row.authority_notified_by, 'u-7', 'nor re-attributes it');
    assert.strictEqual(row.authority_reference, 'AP-2026-1', 'an omitted reference keeps the stored one');
});

test('updateIncident: subjects_notified stamps its own pair and does NOT satisfy the authority clock', async () => {
    const id = await seed({ kind: 'breach', regimes: ['GDPR'], high_risk: true });
    const out = await store.updateIncident('orgA', id, { status: 'subjects_notified' }, 'u-8');
    const row = await stored(id);
    assert.strictEqual(iso(row.subjects_notified_at), NOW.toISOString());
    assert.strictEqual(row.subjects_notified_by, 'u-8');
    assert.strictEqual(row.authority_notified_at, null, 'Art. 34 is not Art. 33');
    assert.strictEqual(hoursAfter(out.deadline_at), 72, 'so the 72-hour notification is still the next thing due');
});

test('updateIncident: a status that stamps nothing leaves every timestamp alone', async () => {
    const id = await seed({ kind: 'breach', regimes: ['GDPR'] });
    await store.updateIncident('orgA', id, { status: 'assessing', note: 'reviewing the logs', severity: 'high' }, 'u-1');
    const row = await stored(id);
    assert.strictEqual(row.status, 'assessing');
    assert.strictEqual(row.severity, 'high');
    assert.strictEqual(row.title, 'Vuln', 'an omitted title keeps the stored one');
    assert.strictEqual(row.authority_notified_at, null);
    assert.strictEqual(row.subjects_notified_at, null);
    assert.strictEqual(row.notes.at(-1).text, 'reviewing the logs');
});

// ── the one-time backfill of rows stamped before the recompute existed ────

/** Written before deadline_at moved with the stamps: the clock each row was CREATED with is still on it. */
const STALE_NIS2 = () => ({
    kind: 'security_incident', regimes: ['NIS2'], status: 'early_warning_sent', detected_at: T0,
    early_warning_due_at: new Date(T0.getTime() + 24 * H),
    final_report_due_at: new Date('2026-10-10T10:00:00.000Z'),
    early_warning_sent_at: new Date(T0.getTime() + 20 * H),
    deadline_at: new Date(T0.getTime() + 24 * H),
});
const SEVERE_CRA = () => ({
    kind: 'security_incident', regimes: ['CRA'], status: 'early_warning_sent', detected_at: T0,
    early_warning_due_at: new Date(T0.getTime() + 24 * H), early_warning_sent_at: new Date(T0.getTime() + 20 * H),
    authority_notified_at: new Date('2026-09-12T09:00:00.000Z'),
    final_report_due_at: new Date(T0.getTime() + 14 * D),
    deadline_at: new Date(T0.getTime() + 14 * D),
});

test('both backfills run inside the boot step, not as a separate migration', async () => {
    const stale = await putRow(STALE_NIS2());
    const severe = await putRow(SEVERE_CRA());
    _resetAllForTests();   // a second boot of the same process
    await store.initDB();
    assert.strictEqual(hoursAfter((await stored(stale.id)).deadline_at), 72);
    assert.strictEqual(iso((await stored(severe.id)).final_report_due_at), '2026-10-12T09:00:00.000Z');
});

test('backfillDeadlines re-points already-stamped rows at their next open clock and clears the finished ones', async () => {
    const stale = await putRow(STALE_NIS2());
    const finished = await putRow({
        kind: 'vulnerability', regimes: ['CRA'], status: 'reported', detected_at: T0,
        early_warning_due_at: new Date(T0.getTime() + 24 * H),
        final_report_due_at: new Date(T0.getTime() + 14 * D),
        early_warning_sent_at: new Date(T0.getTime() + 18 * H),
        authority_notified_at: new Date(T0.getTime() + 40 * H),
        final_report_sent_at: new Date(T0.getTime() + 10 * D),
        deadline_at: new Date(T0.getTime() + 24 * H),
    });
    const closed = await putRow({ status: 'closed', detected_at: T0, deadline_at: new Date(T0.getTime() + 72 * H) });
    const untouched = await putRow({ detected_at: T0, deadline_at: new Date(T0.getTime() + 72 * H) });
    const beforeRows = (await pg.query('SELECT * FROM compliance_incidents ORDER BY id')).rows;
    const beforeWriters = await writers();
    await clock.set(AT(H));   // a write that stamped updated_at would now show

    const res = await store.backfillDeadlines();
    assert.deepStrictEqual(res, { scanned: 3, moved: 3 }, 'the unstamped open row is not even a candidate');
    assert.strictEqual(hoursAfter((await stored(stale.id)).deadline_at), 72, 'the filed 24 h clock gives way to the 72 h notification');
    assert.strictEqual((await stored(finished.id)).deadline_at, null, 'every CRA clock stamped → nothing is due at all');
    assert.strictEqual((await stored(closed.id)).deadline_at, null, 'a closed incident owes nothing');
    assert.strictEqual(hoursAfter((await stored(untouched.id)).deadline_at), 72);
    assert.strictEqual((await writers())[untouched.id], beforeWriters[untouched.id], 'an unstamped row is not even written');

    // Correcting a derived roll-up is not an edit of the incident: every other
    // column, updated_at included, is exactly as it was.
    const afterRows = (await pg.query('SELECT * FROM compliance_incidents ORDER BY id')).rows;
    const strip = ({ deadline_at, ...rest }) => rest;
    assert.deepStrictEqual(afterRows.map(strip), beforeRows.map(strip));
});

test('backfillDeadlines is safe to run twice: the second pass writes nothing', async () => {
    await putRow(STALE_NIS2());
    const finished = await putRow({
        kind: 'vulnerability', regimes: ['CRA'], status: 'reported', detected_at: T0,
        early_warning_sent_at: new Date(T0.getTime() + 18 * H),
        authority_notified_at: new Date(T0.getTime() + 40 * H),
        final_report_sent_at: new Date(T0.getTime() + 10 * D),
        deadline_at: new Date(T0.getTime() + 24 * H),
    });
    await store.backfillDeadlines();
    const once = await writers();

    const second = await store.backfillDeadlines();
    assert.strictEqual(second.moved, 0, 'nothing moves on a second run');
    assert.deepStrictEqual(await writers(), once, 'and nothing is written at all');
    assert.strictEqual(second.scanned, 1, 'the row it cleared has left the candidate set for good');
    assert.strictEqual((await stored(finished.id)).deadline_at, null);
});

test('backfillCraIncidentFinals re-dates severe incidents stored with the 14-day clock, once', async () => {
    const severe = await putRow(SEVERE_CRA());
    const vuln = await putRow({
        kind: 'vulnerability', regimes: ['CRA'], detected_at: T0,
        final_report_due_at: new Date(T0.getTime() + 14 * D), deadline_at: new Date(T0.getTime() + 24 * H),
    });
    const filed = await putRow({
        kind: 'breach', regimes: ['CRA'], detected_at: T0, final_report_sent_at: new Date(T0.getTime() + 5 * D),
        final_report_due_at: new Date(T0.getTime() + 14 * D), deadline_at: null,
    });
    const updatedBefore = iso((await stored(severe.id)).updated_at);
    await clock.set(AT(H));   // a write that stamped updated_at would now show

    const res = await store.backfillCraIncidentFinals();
    assert.deepStrictEqual(res, { scanned: 1, moved: 1 }, 'only the unfiled severe incident is a candidate');
    const row = await stored(severe.id);
    assert.strictEqual(iso(row.final_report_due_at), '2026-10-12T09:00:00.000Z', 'one month after the notification');
    assert.strictEqual(iso(row.deadline_at), '2026-10-12T09:00:00.000Z', 'the roll-up follows');
    assert.strictEqual(iso(row.updated_at), updatedBefore, 'a derived clock correction is not an edit of the incident');
    assert.strictEqual(hoursAfter((await stored(vuln.id)).final_report_due_at), 14 * 24, 'a vulnerability keeps its clock');
    assert.strictEqual(hoursAfter((await stored(filed.id)).final_report_due_at), 14 * 24, 'a filed final report is history');

    const once = await writers();
    const second = await store.backfillCraIncidentFinals();
    assert.strictEqual(second.moved, 0);
    assert.deepStrictEqual(await writers(), once, 'a second run writes nothing');
});

test('constants exported for the routes and the checks', () => {
    assert.deepStrictEqual(store.VALID_KINDS, ['breach', 'security_incident', 'vulnerability']);
    assert.ok(store.VALID_STATUSES.includes('early_warning_sent'));
    assert.ok(store.VALID_STATUSES.includes('reported'));
    assert.deepStrictEqual(store.VALID_REGIMES, ['GDPR', 'NIS2', 'CRA', 'DORA']);
    assert.strictEqual(store.DEADLINE_HOURS, 72);
    assert.strictEqual(store.DEFAULT_CUSTOMER_NOTICE_HOURS, 4);
});
