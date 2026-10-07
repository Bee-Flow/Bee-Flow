/**
 * dsrStore — the one-month clock, the one-time extension, identity verification
 * and the timeline. Recording db double: no Postgres, every statement and its
 * parameters are inspected.
 *
 * The things a regulator would ask about are pinned here:
 *   - due_at is received + one calendar month (public form: now; manual
 *     intake: received_at), clamped to the end of a short month;
 *   - an extension is granted ONCE, moves due_at to received + three calendar
 *     months and needs a reason (Art. 12(3));
 *   - every mutation is scoped to the organisation;
 *   - the deadline feed carries no e-mail address (BFSF-441);
 *   - the verify token is single-use.
 *
 * Run: cd server && node --test --test-force-exit stores/dsrStore.test.js
 */

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const { createRecordingDb } = require('../testUtils/mockDb');
const { installResolveStub } = require('../testUtils/stubRequire');
const { addCalendarMonths } = require('../utils/calendarMonths');

const rows = [];
let nextId = 1;

// The double's NOW(): one fixed instant, so a row can sit EXACTLY on a deadline.
const NOW_MS = Date.now();
const D = 86400 * 1000;
const ms = (v) => (v == null ? null : new Date(v).getTime());

/**
 * Translate one SQL boolean term into a JS predicate over a row.
 *
 * getSlaStats is an aggregate the equality matcher cannot answer, and a
 * hand-written mirror of its arithmetic would only prove the mirror. So the
 * double evaluates the expressions the STORE emitted: `overdue` is whatever the
 * shipped SQL says it is. Change the column (due_at → created_at), the operator
 * (`<` → `<=`) or the status set, and the counts this double returns change.
 * Anything outside the grammar throws rather than silently counting nothing.
 */
function sqlTerm(term) {
    let m = term.match(/^([a-z_]+)\s+IN\s*\(([^)]*)\)$/i);
    if (m) {
        const set = m[2].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
        return (r) => set.includes(r[m[1]]);
    }
    m = term.match(/^([a-z_]+)\s*=\s*'([^']*)'$/i);
    if (m) return (r) => r[m[1]] === m[2];
    // <col|COALESCE(a,b)> <op> NOW() [ ± INTERVAL 'N days' ]
    m = term.match(/^(.+?)\s*(<=|>=|<|>)\s*NOW\(\)\s*(?:([-+])\s*\(?\s*INTERVAL\s*'(\d+)\s*days?'\s*\)?)?$/i);
    if (m) {
        const [, ref, op, sign, days] = m;
        const cut = NOW_MS + (sign ? (sign === '-' ? -1 : 1) * Number(days) * D : 0);
        const read = (r) => {
            const co = ref.trim().match(/^COALESCE\(([^)]*)\)$/i);
            if (!co) return ms(r[ref.trim()]);
            for (const part of co[1].split(',').map(s => s.trim())) {
                const v = ms(r[part]);
                if (v != null && !Number.isNaN(v)) return v;
            }
            return null;
        };
        return (r) => {
            const v = read(r);
            if (v == null || Number.isNaN(v)) return false; // NULL <op> x is UNKNOWN → not counted
            return op === '<' ? v < cut : op === '<=' ? v <= cut : op === '>' ? v > cut : v >= cut;
        };
    }
    throw new Error(`dsr mock: unsupported SQL predicate ${JSON.stringify(term)}`);
}
const sqlPredicate = (expr) => {
    const terms = String(expr).split(/\bAND\b/i).map(s => s.trim()).filter(Boolean).map(sqlTerm);
    return (r) => terms.every(fn => fn(r));
};

const mock = createRecordingDb({
    tables: { dsr_requests: rows },
    onQuery(sql, params) {
        // getSlaStats — evaluate the emitted SELECT list against the fixtures.
        if (/^SELECT/i.test(sql) && /FROM dsr_requests/i.test(sql) && /\bAS overdue\b/i.test(sql)) {
            const windowDays = Number(params[2] ?? 365);
            const scoped = rows.filter(r => r.organization_id === params[0]
                && r.request_type === params[1]
                && ms(r.created_at) >= NOW_MS - windowDays * D);
            const out = {};
            for (const m of sql.matchAll(/COUNT\(\*\)\s*FILTER\s*\(\s*WHERE([\s\S]*?)\)::int\s+AS\s+([a-z_]+)/gi)) {
                out[m[2]] = scoped.filter(sqlPredicate(m[1])).length;
            }
            if (/COUNT\(\*\)::int\s+AS\s+total/i.test(sql)) out.total = scoped.length;
            const avg = sql.match(/COALESCE\(\s*AVG\(\s*EXTRACT\(EPOCH FROM \(([a-z_]+) - ([a-z_]+)\)\)\s*\/\s*86400\s*\)\s*FILTER\s*\(\s*WHERE([\s\S]*?)\),\s*0\)\s+AS\s+([a-z_]+)/i);
            if (avg) {
                const hits = scoped.filter(sqlPredicate(avg[3]));
                out[avg[4]] = hits.length
                    ? hits.reduce((s, r) => s + (ms(r[avg[1]]) - ms(r[avg[2]])) / D, 0) / hits.length
                    : 0;
            }
            return { rows: [out], rowCount: 1 };
        }
        if (/^INSERT INTO dsr_requests/i.test(sql)) {
            const cols = sql.match(/\(([\s\S]*?)\)\s*VALUES/i)[1].split(',').map(s => s.trim());
            const vals = sql.match(/VALUES\s*\(([\s\S]*?)\)\s*RETURNING/i)[1].split(',').map(s => s.trim());
            const row = { id: nextId++, timeline: [] };
            cols.forEach((c, i) => {
                const p = vals[i].match(/^\$(\d+)/);
                row[c] = p ? params[Number(p[1]) - 1] : vals[i].replace(/^'|'$/g, '');
            });
            if (typeof row.timeline === 'string') row.timeline = JSON.parse(row.timeline);
            rows.push(row);
            return { rows: [{ id: row.id, created_at: row.created_at, due_at: row.due_at, channel: row.channel, identity_status: row.identity_status }], rowCount: 1 };
        }
        // The one-time extension guard (`extended_at IS NULL`) and the
        // single-use token (`verify_token_hash = $3`) need the extra predicate
        // the equality matcher ignores / cannot see.
        if (/^UPDATE dsr_requests/i.test(sql)) {
            const [org, id] = params;
            const hit = rows.find(r => r.organization_id === org && r.id === id);
            if (!hit) return { rows: [], rowCount: 0 };
            if (/extended_at IS NULL/.test(sql) && hit.extended_at) return { rows: [], rowCount: 0 };
            if (/status = 'pending'/.test(sql) && hit.status !== 'pending') return { rows: [], rowCount: 0 };
            if (/WHERE[\s\S]*verify_token_hash = \$3/.test(sql)) {
                if (hit.verify_token_hash !== params[2]) return { rows: [], rowCount: 0 };
                hit.verify_token_hash = null;
                return { rows: [], rowCount: 1 };
            }
            // apply the SET clause for the columns the assertions read back
            const set = sql.match(/\bSET\b([\s\S]*?)\bWHERE\b/i)[1];
            for (const m of set.matchAll(/([a-z_]+)\s*=\s*(?:\$(\d+)|'([a-z_]+)')/gi)) {
                if (m[1] === 'timeline') continue;
                hit[m[1]] = m[2] ? params[Number(m[2]) - 1] : m[3];
            }
            const tl = set.match(/timeline = COALESCE\(timeline, '\[\]'::jsonb\) \|\| \$(\d+)::jsonb/);
            if (tl) hit.timeline = [...(hit.timeline || []), ...JSON.parse(params[Number(tl[1]) - 1])];
            return { rows: [], rowCount: 1 };
        }
        return undefined;
    },
});
const restore = installResolveStub({ '../db': mock.db });
const store = require('./dsrStore');

let bootDdl = [];
let bootClient = [];
before(async () => {
    await store.initDB();
    // Snapshot both channels here — beforeEach resets the recorder.
    bootClient = mock.calls.client.map(c => c.sql);
    bootDdl = [...mock.calls.exec.map(c => c.sql), ...bootClient];
});
after(() => restore());
beforeEach(() => { rows.length = 0; nextId = 1; mock.reset(); });

const DAY = 86400 * 1000;
const mutations = () => mock.mutations();

// ── DDL ──────────────────────────────────────────────────────────────────

test('boot DDL adds every redesign column, backfills due_at idempotently and adds the due index', () => {
    const ddl = bootDdl.join('\n');
    for (const col of ['channel', 'identity_status', 'identity_verified_at', 'created_by', 'started_at', 'started_by',
        'extended_until', 'extension_reason', 'extended_by', 'extended_at', 'due_at', 'timeline', 'verify_token_hash']) {
        assert.match(ddl, new RegExp(`ADD COLUMN IF NOT EXISTS ${col} `), col);
    }
    assert.match(ddl, /channel TEXT NOT NULL DEFAULT 'public_form'/);
    assert.match(ddl, /identity_status TEXT NOT NULL DEFAULT 'unverified'/);
    assert.match(ddl, /timeline JSONB NOT NULL DEFAULT '\[\]'::jsonb/);
    assert.match(ddl, /UPDATE dsr_requests SET due_at = created_at \+ INTERVAL '1 month' WHERE due_at IS NULL/);
    assert.match(ddl, /CREATE INDEX IF NOT EXISTS idx_dsr_org_due ON dsr_requests\(organization_id, due_at\) WHERE status IN \('pending','in_progress'\)/);
    // The backfill runs inside the same runDdl list (transaction client), after the column exists.
    const addDue = bootClient.findIndex(s => /ADD COLUMN IF NOT EXISTS due_at/.test(s));
    const backfill = bootClient.findIndex(s => /UPDATE dsr_requests SET due_at/.test(s));
    assert.ok(addDue >= 0 && backfill > addDue, 'backfill after the column');
});

// ── intake ───────────────────────────────────────────────────────────────

test('createRequest: due_at = created_at + one calendar month, channel public_form, identity unverified, timeline opens with received', async () => {
    const out = await store.createRequest({ organization_id: 'orgA', subject_email: ' Jan@Example.TEST ', request_type: 'deletion' });
    const row = rows[0];
    assert.strictEqual(row.subject_email, 'jan@example.test', 'normalised');
    assert.strictEqual(row.channel, 'public_form');
    assert.strictEqual(row.identity_status, 'unverified');
    assert.strictEqual(new Date(row.due_at).toISOString(), addCalendarMonths(row.created_at, 1).toISOString());
    assert.strictEqual(out.due_at, row.due_at);
    assert.strictEqual(row.timeline.length, 1);
    assert.strictEqual(row.timeline[0].kind, 'received');
    assert.strictEqual(row.timeline[0].by, null);
    assert.strictEqual(row.timeline[0].channel, 'public_form');
    assert.strictEqual(row.timeline[0].at, new Date(row.created_at).toISOString(), 'received-at equals the clock start');
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
    const row = rows[0];
    assert.strictEqual(out.identity_status, 'verified_manual');
    assert.strictEqual(row.channel, 'letter');
    assert.strictEqual(row.created_by, 'dpo-1');
    assert.strictEqual(new Date(row.created_at).toISOString(), received);
    assert.strictEqual(new Date(row.due_at).toISOString(), '2026-10-01T09:00:00.000Z');
    assert.ok(row.identity_verified_at instanceof Date);
    assert.deepStrictEqual(row.timeline.map(e => e.kind), ['received', 'identity_verified']);
    assert.strictEqual(row.timeline[0].by, 'dpo-1');
    assert.strictEqual(row.timeline[0].text, 'Brief ontvangen per post');
    assert.strictEqual(row.timeline[1].method, 'manual');
    assert.strictEqual(mutations()[0].params[0], 'orgA');
});

test('the clock is one calendar month, not 30 days: received 31 Jan → due end of February', async () => {
    // EDPB Guidelines 01/2022 (Reg. 1182/71): a request received on 31 January
    // runs until the end of 28 February. 30 days would land on 2 March.
    await store.createManual('orgA', {
        subject_email: 'a@example.test', request_type: 'access', received_at: '2026-01-31T10:00:00.000Z', created_by: 'dpo-1',
    });
    assert.strictEqual(new Date(rows[0].due_at).toISOString(), '2026-02-28T10:00:00.000Z');
    // The extension is two further months on top: three calendar months from
    // receipt, 30 April — 90 days would land on 1 May.
    mock.reset();
    await store.extend('orgA', rows[0].id, { reason: 'Complex request', by: 'dpo-1' });
    assert.strictEqual(new Date(rows[0].extended_until).toISOString(), '2026-04-30T10:00:00.000Z');
    assert.strictEqual(rows[0].due_at, rows[0].extended_until);
});

test('createManual guards: org, e-mail, actor, future received_at, bad channel', async () => {
    await assert.rejects(() => store.createManual(null, { subject_email: 'a@b.c', created_by: 'u' }), /organization_id/);
    await assert.rejects(() => store.createManual('o', { created_by: 'u' }), /subject_email/);
    await assert.rejects(() => store.createManual('o', { subject_email: 'a@b.c' }), /created_by/);
    await assert.rejects(() => store.createManual('o', { subject_email: 'a@b.c', created_by: 'u', received_at: new Date(Date.now() + DAY).toISOString() }), /future/);
    await assert.rejects(() => store.createManual('o', { subject_email: 'a@b.c', created_by: 'u', channel: 'fax' }), /invalid channel/);
    assert.strictEqual(rows.length, 0);
});

// ── lifecycle ────────────────────────────────────────────────────────────

async function seed(overrides = {}) {
    await store.createRequest({ organization_id: 'orgA', subject_email: 'x@example.test', request_type: 'access' });
    const row = rows.at(-1); // the row just created, not the first of the test
    Object.assign(row, overrides);
    mock.reset();
    return row;
}

test('start: pending → in_progress with actor + timestamp, timeline "started"; idempotent afterwards', async () => {
    const row = await seed();
    const out = await store.start('orgA', row.id, 'u-7');
    assert.strictEqual(row.status, 'in_progress');
    assert.strictEqual(row.started_by, 'u-7');
    assert.ok(row.started_at instanceof Date);
    assert.deepStrictEqual(out.timeline.map(e => e.kind), ['received', 'started']);
    assert.strictEqual(out.timeline[1].by, 'u-7');
    const upd = mutations().find(m => /UPDATE dsr_requests/.test(m.sql));
    assert.match(upd.sql, /WHERE organization_id = \$1 AND id = \$2 AND status = 'pending'/);

    mock.reset();
    const again = await store.start('orgA', row.id, 'u-8');
    assert.strictEqual(again.started_by, 'u-7', 'a second start changes nothing');
    assert.strictEqual(again.timeline.length, 2, 'no second started event');
    await assert.rejects(() => store.start('orgA', row.id, null), /userId/);
});

test('extend: once only, needs a reason, due_at = extended_until = created_at + three calendar months, timeline "extended"', async () => {
    const row = await seed();
    await assert.rejects(() => store.extend('orgA', row.id, { by: 'u' }), /reason is required/);

    const out = await store.extend('orgA', row.id, { reason: 'Complex request, three systems', by: 'dpo-1' });
    assert.strictEqual(new Date(row.extended_until).toISOString(), addCalendarMonths(row.created_at, 3).toISOString());
    assert.strictEqual(row.due_at, row.extended_until, 'the deadline follows the extension');
    assert.strictEqual(row.extension_reason, 'Complex request, three systems');
    assert.strictEqual(row.extended_by, 'dpo-1');
    assert.ok(row.extended_at instanceof Date);
    const ev = out.timeline.at(-1);
    assert.strictEqual(ev.kind, 'extended');
    assert.strictEqual(ev.text, 'Complex request, three systems');
    assert.strictEqual(ev.until, new Date(row.extended_until).toISOString());
    const upd = mutations().find(m => /UPDATE dsr_requests/.test(m.sql));
    assert.match(upd.sql, /WHERE organization_id = \$1 AND id = \$2 AND extended_at IS NULL/, 'race-safe guard');

    await assert.rejects(() => store.extend('orgA', row.id, { reason: 'again', by: 'dpo-1' }), store.AlreadyExtendedError);
    await assert.rejects(() => store.extend('orgA', row.id, { reason: 'again', by: 'dpo-1' }), /code: 'dsr_already_extended'|already extended/);
    // GDPR Art. 12(3): the extension is by two further months, not "one extension" of an unstated length.
    await assert.rejects(() => store.extend('orgA', row.id, { reason: 'again', by: 'dpo-1' }), { message: /Art\. 12\(3\) allows one extension by two further months/ });
    assert.strictEqual(row.timeline.length, 2, 'the refused attempt left no trace');
});

test('extend: the DB guard alone also refuses (row read as unextended, UPDATE hits nothing)', async () => {
    const row = await seed();
    // Simulate a concurrent extension landing between the read and the UPDATE.
    const realGetOne = mock.db.getOne;
    mock.db.getOne = async (sql, params) => {
        const r = await realGetOne(sql, params);
        if (r) { row.extended_at = new Date(); return { ...r, extended_at: null }; }
        return r;
    };
    try {
        await assert.rejects(() => store.extend('orgA', row.id, { reason: 'x', by: 'u' }), store.AlreadyExtendedError);
    } finally {
        mock.db.getOne = realGetOne;
    }
});

test('extend: unknown request → null; closed request → error', async () => {
    assert.strictEqual(await store.extend('orgA', 999, { reason: 'x' }), null);
    const row = await seed({ status: 'fulfilled' });
    await assert.rejects(() => store.extend('orgA', row.id, { reason: 'x' }), /cannot extend a fulfilled request/);
});

test('verifyIdentity: email_link and manual set the status + stamp and append the event; bad method rejected', async () => {
    const row = await seed();
    const a = await store.verifyIdentity('orgA', row.id, { method: 'email_link' });
    assert.strictEqual(row.identity_status, 'verified_email_link');
    assert.ok(row.identity_verified_at instanceof Date);
    assert.deepStrictEqual(a.timeline.at(-1), { ...a.timeline.at(-1), kind: 'identity_verified', by: null, method: 'email_link' });

    const b = await store.verifyIdentity('orgA', row.id, { method: 'manual', by: 'dpo-1' });
    assert.strictEqual(row.identity_status, 'verified_manual');
    assert.strictEqual(b.timeline.at(-1).by, 'dpo-1');

    await assert.rejects(() => store.verifyIdentity('orgA', row.id, { method: 'telepathy' }), /invalid identity method/);
    await assert.rejects(() => store.verifyIdentity('orgA', row.id, { method: 'manual' }), /by is required/);
});

test('appendTimeline: atomic jsonb append, kind required, text capped, at defaults to now', async () => {
    const row = await seed();
    const long = 'x'.repeat(3000);
    const out = await store.appendTimeline('orgA', row.id, { kind: 'note', text: long, by: 'u-1' });
    const ev = out.timeline.at(-1);
    assert.strictEqual(ev.kind, 'note');
    assert.strictEqual(ev.text.length, 2000);
    assert.strictEqual(ev.by, 'u-1');
    assert.ok(!Number.isNaN(Date.parse(ev.at)));
    const upd = mutations().find(m => /UPDATE dsr_requests/.test(m.sql));
    assert.match(upd.sql, /timeline = COALESCE\(timeline, '\[\]'::jsonb\) \|\| \$3::jsonb/);
    assert.match(upd.sql, /WHERE organization_id = \$1 AND id = \$2/);
    await assert.rejects(() => store.appendTimeline('orgA', row.id, { text: 'no kind' }), /event.kind/);
});

test('updateStatus appends fulfilled/rejected/started events and keeps the legacy COALESCE stamps', async () => {
    const row = await seed();
    const out = await store.updateStatus('orgA', row.id, 'fulfilled', { fulfilledBy: 'u-2', resultSummary: 'Export sent' });
    assert.strictEqual(row.status, 'fulfilled');
    const ev = out.timeline.at(-1);
    assert.strictEqual(ev.kind, 'fulfilled');
    assert.strictEqual(ev.by, 'u-2');
    assert.strictEqual(ev.text, 'Export sent');
    const upd = mutations().find(m => /UPDATE dsr_requests/.test(m.sql));
    assert.match(upd.sql, /fulfilled_at = COALESCE\(\$4, fulfilled_at\)/);
    assert.match(upd.sql, /timeline = COALESCE\(timeline, '\[\]'::jsonb\) \|\| \$8::jsonb/);

    const r2 = await seed();
    await store.updateStatus('orgA', r2.id, 'pending');
    assert.strictEqual(r2.timeline.length, 1, 'pending writes no event');
    await assert.rejects(() => store.updateStatus('orgA', r2.id, 'lost'), /invalid status/);
});

// ── verify token ─────────────────────────────────────────────────────────

test('verify token is single-use: consume matches the hash once, then never again', async () => {
    const row = await seed();
    assert.strictEqual(await store.setVerifyTokenHash('orgA', row.id, 'h-abc'), true);
    assert.strictEqual(row.verify_token_hash, 'h-abc');
    assert.strictEqual(await store.consumeVerifyToken('orgA', row.id, 'wrong'), false);
    assert.strictEqual(await store.consumeVerifyToken('orgA', row.id, 'h-abc'), true);
    assert.strictEqual(row.verify_token_hash, null, 'burned');
    assert.strictEqual(await store.consumeVerifyToken('orgA', row.id, 'h-abc'), false, 'second click finds nothing');
    assert.strictEqual(await store.consumeVerifyToken('orgA', row.id, null), false);
    await assert.rejects(() => store.setVerifyTokenHash('orgA', row.id, ''), /hash/);
    const consume = mutations().find(m => /verify_token_hash = NULL/.test(m.sql));
    assert.match(consume.sql, /WHERE organization_id = \$1 AND id = \$2 AND verify_token_hash = \$3/);
});

// ── reads ────────────────────────────────────────────────────────────────

test('listRequests returns the new columns (e-mail unmasked — masking is the route\'s job) and synthesises legacy timelines', async () => {
    rows.push({
        id: 1, organization_id: 'orgA', request_type: 'access', subject_email: 'old@example.test', status: 'fulfilled',
        created_at: '2026-01-01T00:00:00.000Z', fulfilled_at: '2026-01-10T00:00:00.000Z', fulfilled_by: 'u-9',
        channel: 'public_form', timeline: [],
    });
    rows.push({ id: 2, organization_id: 'orgB', request_type: 'access', subject_email: 'other@example.test', status: 'pending', timeline: [] });
    const list = await store.listRequests('orgA');
    assert.strictEqual(list.length, 1, 'org-scoped');
    const sql = mock.calls.getAll[0].sql;
    for (const col of ['channel', 'identity_status', 'identity_verified_at', 'created_by', 'started_at', 'started_by',
        'extended_until', 'extension_reason', 'extended_by', 'extended_at', 'due_at', 'timeline']) {
        assert.match(sql, new RegExp(`\\b${col}\\b`), col);
    }
    assert.strictEqual(list[0].subject_email, 'old@example.test');
    assert.deepStrictEqual(list[0].timeline.map(e => e.kind), ['received', 'fulfilled'], 'legacy row → synthesised trail');
    assert.strictEqual(list[0].timeline[1].by, 'u-9');
    assert.strictEqual(mutations().length, 0, 'synthesis is read-only');
});

test('listOpenWithDeadlines: open statuses ordered by due_at, org-scoped, and NO subject_email in the SELECT', async () => {
    await store.listOpenWithDeadlines('orgA');
    const c = mock.calls.getAll[0];
    assert.match(c.sql, /WHERE organization_id = \$1 AND status = ANY\(\$2\)/);
    assert.deepStrictEqual(c.params, ['orgA', ['pending', 'in_progress']]);
    assert.match(c.sql, /ORDER BY due_at ASC/);
    assert.ok(!/subject_email/.test(c.sql), 'the deadline feed never selects the address');
    assert.ok(!/SELECT \*/.test(c.sql));
});

test('getSlaStats counts overdue from due_at: not at the deadline, yes one second past it, and an extension moves it', async () => {
    // Rows on both sides of the clock. The double evaluates the FILTER
    // expressions the store emits (see sqlPredicate), so these counts are the
    // shipped SQL's verdict, not a restatement of it.
    const at = (offset) => new Date(NOW_MS + offset);
    const seedRow = (over) => rows.push({
        id: nextId++, organization_id: 'orgA', request_type: 'access',
        status: 'pending', created_at: at(-29 * D), timeline: [], ...over,
    });

    seedRow({ due_at: at(1000) });                                   // A: one second to go
    seedRow({ due_at: at(0), created_at: at(-30 * D) });             // B: EXACTLY at due_at — still in time
    seedRow({ due_at: at(-1000), created_at: at(-30 * D - 1000) });  // C: one second past → overdue
    seedRow({ status: 'in_progress', created_at: at(-40 * D), due_at: at(-10 * D) }); // D: long overdue
    seedRow({ status: 'fulfilled', created_at: at(-40 * D), due_at: at(-10 * D), fulfilled_at: at(-35 * D) }); // E: closed, never overdue
    // F: created 40 d ago — overdue under a created_at + 30 d rule — but the
    // one-time extension moved the deadline out, so it is NOT overdue.
    seedRow({ created_at: at(-40 * D), extended_at: at(-11 * D), extended_until: at(50 * D), due_at: at(50 * D) });

    const stats = await store.getSlaStats('orgA', 'access', 365);
    assert.strictEqual(stats.total, 6);
    assert.strictEqual(stats.open, 5, 'the fulfilled row is not open');
    assert.strictEqual(stats.fulfilled, 1);
    assert.strictEqual(stats.overdue, 2, 'only C and D: the boundary row is in time and the extended row is not overdue');
    assert.strictEqual(stats.nearing, 2, 'A (one second to go) and B (exactly at due_at) are due within 5 days; F, extended 50 days out, is not');
    assert.strictEqual(stats.avg_days_to_fulfil, 5);

    // Flip the extended row's deadline back to where it would sit without the
    // extension: the same row now counts. (If `overdue` stopped reading due_at,
    // this pair could not differ.)
    rows.at(-1).due_at = at(-10 * D);
    assert.strictEqual((await store.getSlaStats('orgA', 'access', 365)).overdue, 3);

    const c = mock.calls.getOne[0];
    assert.strictEqual(c.params[0], 'orgA', 'org-scoped');
    assert.strictEqual(c.params[1], 'access', 'and scoped to the request type');
    assert.deepStrictEqual(
        await store.getSlaStats('nobody', 'access'),
        { total: 0, fulfilled: 0, open: 0, overdue: 0, nearing: 0, avg_days_to_fulfil: 0 },
        'an org with no requests reads zeroes, never a null row',
    );
});

// ── invariants ───────────────────────────────────────────────────────────

test('every mutation carries the organisation as its first parameter and in its WHERE', async () => {
    const row = await seed();
    await store.start('orgA', row.id, 'u');
    await store.verifyIdentity('orgA', row.id, { method: 'email_link' });
    await store.appendTimeline('orgA', row.id, { kind: 'note', text: 'x' });
    await store.extend('orgA', row.id, { reason: 'r', by: 'u' });
    await store.setVerifyTokenHash('orgA', row.id, 'h');
    await store.consumeVerifyToken('orgA', row.id, 'h');
    await store.updateStatus('orgA', row.id, 'fulfilled', { fulfilledBy: 'u' });
    const ms = mutations();
    assert.ok(ms.length >= 7);
    for (const m of ms) {
        assert.match(m.sql, /WHERE organization_id = \$1 AND id = \$2/, m.sql.slice(0, 60));
        assert.strictEqual(m.params[0], 'orgA');
    }
    // and a foreign org cannot touch the row
    mock.reset();
    assert.strictEqual(await store.consumeVerifyToken('orgB', row.id, 'h'), false);
    assert.strictEqual(await store.extend('orgB', row.id, { reason: 'r' }), null);
});

test('constants exported for the routes: channels, identity statuses, SLA months', () => {
    assert.deepStrictEqual(store.VALID_CHANNELS, ['public_form', 'email_dpo', 'phone', 'letter', 'other']);
    assert.deepStrictEqual(store.IDENTITY_STATUSES, ['unverified', 'verified_email_link', 'verified_manual']);
    assert.strictEqual(store.SLA_MONTHS, 1);
    assert.strictEqual(store.EXTENDED_SLA_MONTHS, 3);
});
