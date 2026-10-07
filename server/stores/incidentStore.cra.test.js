/**
 * incidentStore — the multi-regime register: clock math per regime, the
 * "earliest clock wins" deadline, the CRA / NIS2 / DORA stamps and their org
 * scoping. Recording db double (testUtils/mockDb): no Postgres, every
 * statement and its parameters are inspected.
 *
 * Run: cd server && node --test --test-force-exit stores/incidentStore.cra.test.js
 */

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const { createRecordingDb } = require('../testUtils/mockDb');
const { installResolveStub } = require('../testUtils/stubRequire');
const { addCalendarMonths } = require('../utils/calendarMonths');

const rows = [];
let nextId = 1;
const mock = createRecordingDb({
    tables: { compliance_incidents: rows },
    onQuery(sql, params) {
        if (/^INSERT INTO compliance_incidents/i.test(sql)) {
            const cols = sql.match(/\(([\s\S]*?)\)\s*VALUES/i)[1].split(',').map(s => s.trim());
            const vals = sql.match(/VALUES\s*\(([\s\S]*?)\)\s*RETURNING/i)[1].split(',').map(s => s.trim());
            const row = { id: nextId++, status: 'open', notes: [] };
            cols.forEach((c, i) => {
                const p = vals[i].match(/^\$(\d+)/);
                row[c] = p ? params[Number(p[1]) - 1] : vals[i];
            });
            for (const j of ['regimes', 'cve_ids', 'affected_products']) {
                if (typeof row[j] === 'string') row[j] = JSON.parse(row[j]);
            }
            rows.push(row);
            return { rows: [{ ...row }], rowCount: 1 };
        }
        if (/^UPDATE compliance_incidents/i.test(sql)) {
            const [org, id] = params;
            const hit = rows.find(r => r.organization_id === org && r.id === id);
            if (!hit) return { rows: [], rowCount: 0 };
            // Model the first-wins COALESCE(col, NOW()) stamps and the status CASE.
            const set = sql.match(/\bSET\b([\s\S]*?)\bWHERE\b/i)[1];
            for (const m of set.matchAll(/([a-z_]+) = COALESCE\(\1, NOW\(\)\)/g)) {
                if (!hit[m[1]]) hit[m[1]] = new Date();
            }
            for (const m of set.matchAll(/([a-z_]+) = COALESCE\(\$(\d+), \1\)/g)) {
                const v = params[Number(m[2]) - 1];
                if (v != null) hit[m[1]] = v;
            }
            for (const m of set.matchAll(/([a-z_]+) = COALESCE\(\1, \$(\d+)\)/g)) {
                const v = params[Number(m[2]) - 1];
                if (hit[m[1]] == null && v != null) hit[m[1]] = v;
            }
            const st = set.match(/status = CASE WHEN status IN \(([^)]*)\) THEN '([a-z_]+)'/);
            if (st) {
                const from = st[1].split(',').map(s => s.trim().replace(/'/g, ''));
                if (from.includes(hit.status)) hit.status = st[2];
            }
            // The server-side status stamps: `col = CASE WHEN $n = '<status>'
            // AND col IS NULL THEN NOW()|$m ELSE col END` — first-wins, and only
            // when the status being written is the one that triggers them.
            for (const m of set.matchAll(/([a-z_]+) = CASE WHEN \$(\d+) = '([a-z_]+)' AND \1 IS NULL THEN (NOW\(\)|\$(\d+)) ELSE \1 END/g)) {
                const [, col, statusParam, triggerStatus, thenExpr, thenParam] = m;
                if (params[Number(statusParam) - 1] !== triggerStatus) continue;
                if (hit[col] != null) continue;
                const value = thenExpr === 'NOW()' ? new Date() : params[Number(thenParam) - 1];
                if (value != null) hit[col] = value;
            }
            const plainStatus = set.match(/\bstatus = \$(\d+)/);
            if (plainStatus) hit.status = params[Number(plainStatus[1]) - 1];
            const notes = set.match(/notes = COALESCE\(notes, '\[\]'::jsonb\) \|\| \$(\d+)::jsonb/);
            if (notes) hit.notes = [...(hit.notes || []), ...JSON.parse(params[Number(notes[1]) - 1])];
            const notesSet = set.match(/notes = \$(\d+)::jsonb/);
            if (notesSet) hit.notes = JSON.parse(params[Number(notesSet[1]) - 1]);
            // The deadline roll-up is a plain overwrite (it moves both ways and
            // becomes NULL once every clock is met), so it needs its own rule.
            const dl = set.match(/deadline_at = \$(\d+)/);
            if (dl) hit.deadline_at = params[Number(dl[1]) - 1];
            // A CRA severe incident's final report is re-dated from the
            // notification (plain overwrite as well).
            const fr = set.match(/final_report_due_at = \$(\d+)/);
            if (fr) hit.final_report_due_at = params[Number(fr[1]) - 1];
            return { rows: [], rowCount: 1 };
        }
        // The three reads the equality matcher cannot decide — they turn on
        // `deadline_at < NOW()`, a 24-hour window and `status = ANY($2)`.
        // Answered by interpreting the STATEMENT's own text (see evalWhere), so
        // the boundary tests below measure the store's SQL, not a restatement.
        if (/^SELECT/i.test(sql) && /\bcompliance_incidents\b/.test(sql)) {
            if (/COUNT\(\*\) FILTER/.test(sql)) return { rows: [deadlineStatsFrom(sql, params)], rowCount: 1 };
            if (/WHERE id > \$1/.test(sql)) { const r = backfillCandidates(sql, params); return { rows: r, rowCount: r.length }; }
            if (/AND deadline_at < NOW\(\) \+ INTERVAL/.test(sql)) { const r = needingAttention(sql, params); return { rows: r, rowCount: r.length }; }
        }
        return undefined;
    },
});
const restore = installResolveStub({ '../db': mock.db });
const store = require('./incidentStore');

let bootDdl = '';
let bootReads = '';
before(async () => {
    await store.initDB();
    bootDdl = [...mock.calls.exec.map(c => c.sql), ...mock.calls.client.map(c => c.sql)].join('\n');
    bootReads = mock.calls.getAll.map(c => c.sql).join('\n');
});
after(() => restore());
beforeEach(() => {
    rows.length = 0;
    nextId = 1;
    NOW = new Date('2026-09-11T12:00:00.000Z');
    mock.reset();
});

const H = 3600 * 1000;
const D = 24 * H;
const T0 = new Date('2026-09-10T10:00:00.000Z');
const hoursAfter = (d) => (new Date(d).getTime() - T0.getTime()) / H;
const mutations = () => mock.mutations();

// ── A predicate interpreter over the statements the store really issues ──────
//
// `getDeadlineStats` and `listNeedingAttention` decide on comparisons the
// shared equality matcher cannot model. Hand-modelling those decisions in the
// double would only ever prove the double (review finding M9). So the double
// PARSES the real SQL instead: change `deadline_at < NOW()` to `<=` in the
// store and the boundary row below moves to the other side of the answer.
// Anything it cannot parse throws, so a new construct fails loudly rather than
// quietly counting as false.

/** The clock the interpreter reads for NOW(); each test pins it. */
let NOW = new Date('2026-09-11T12:00:00.000Z');

/** Split on a boolean keyword at paren depth 0. */
function splitTop(expr, word) {
    const out = [];
    let depth = 0;
    let cur = '';
    for (let i = 0; i < expr.length; i++) {
        const ch = expr[i];
        if (ch === '(') depth += 1;
        if (ch === ')') depth -= 1;
        if (depth === 0 && /\s/.test(ch) && new RegExp(`^${word}\\s`, 'i').test(expr.slice(i + 1))) {
            out.push(cur);
            cur = '';
            i += word.length;
            continue;
        }
        cur += ch;
    }
    out.push(cur);
    return out.map(s => s.trim()).filter(Boolean);
}

function stripOuterParens(expr) {
    let t = expr.trim();
    while (t.startsWith('(') && t.endsWith(')')) {
        let depth = 0;
        let wraps = true;
        for (let i = 0; i < t.length; i++) {
            if (t[i] === '(') depth += 1;
            if (t[i] === ')') depth -= 1;
            if (depth === 0 && i < t.length - 1) { wraps = false; break; }
        }
        if (!wraps) break;
        t = t.slice(1, -1).trim();
    }
    return t;
}

function _ts(v) {
    if (v == null) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function _cmp(a, op, b) {
    switch (op) {
        case '<': return a < b;
        case '<=': return a <= b;
        case '>': return a > b;
        case '>=': return a >= b;
        default: throw new Error(`unknown operator ${op}`);
    }
}

function evalWhere(expr, row, params) {
    const t = stripOuterParens(expr);
    const ors = splitTop(t, 'OR');
    if (ors.length > 1) return ors.some(o => evalWhere(o, row, params));
    const ands = splitTop(t, 'AND');
    if (ands.length > 1) return ands.every(a => evalWhere(a, row, params));
    let m;
    if ((m = /^([a-z_]+) IS NOT NULL$/i.exec(t))) return row[m[1]] != null;
    if ((m = /^([a-z_]+) IS NULL$/i.exec(t))) return row[m[1]] == null;
    if ((m = /^([a-z_]+) = ANY\(\$(\d+)\)$/i.exec(t))) return (params[Number(m[2]) - 1] || []).includes(row[m[1]]);
    if ((m = /^([a-z_]+) = \$(\d+)$/i.exec(t))) return row[m[1]] === params[Number(m[2]) - 1];
    if ((m = /^([a-z_]+) (<|<=|>|>=) \$(\d+)$/i.exec(t))) return _cmp(row[m[1]], m[2], params[Number(m[3]) - 1]);
    if ((m = /^([a-z_]+) = '([^']*)'$/i.exec(t))) return row[m[1]] === m[2];
    if ((m = /^([a-z_]+) <> '([^']*)'$/i.exec(t))) return row[m[1]] !== m[2];
    if ((m = /^([a-z_]+) (<|<=|>|>=) NOW\(\)(?:\s*\+\s*INTERVAL '(\d+) (hours?|days?)')?$/i.exec(t))) {
        const v = _ts(row[m[1]]);
        // NULL <op> anything is UNKNOWN in SQL, and UNKNOWN never satisfies a
        // WHERE or a FILTER. That is the whole reason deadline_at may be NULL.
        if (v == null) return false;
        const bound = NOW.getTime() + (m[3] ? Number(m[3]) * (/^day/i.test(m[4]) ? 24 : 1) * H : 0);
        return _cmp(v, m[2], bound);
    }
    // `regimes @> '["GDPR"]'::jsonb`: the row's regimes hold every listed one.
    if ((m = /^([a-z_]+) @> '(\[[^']*\])'::jsonb$/i.exec(t))) {
        const want = JSON.parse(m[2]);
        const have = Array.isArray(row[m[1]]) ? row[m[1]] : [];
        return want.every(w => have.includes(w));
    }
    // `detected_at + INTERVAL '72 hours' < NOW() [+ INTERVAL '24 hours']`: a
    // clock computed from a column, against the pinned NOW.
    if ((m = /^([a-z_]+) \+ INTERVAL '(\d+) (hours?|days?)' (<|<=|>|>=) NOW\(\)(?:\s*\+\s*INTERVAL '(\d+) (hours?|days?)')?$/i.exec(t))) {
        const v = _ts(row[m[1]]);
        if (v == null) return false;
        const span = (n, unit) => Number(n) * (/^day/i.test(unit) ? 24 : 1) * H;
        const bound = NOW.getTime() + (m[5] ? span(m[5], m[6]) : 0);
        return _cmp(v + span(m[2], m[3]), m[4], bound);
    }
    throw new Error(`the test double cannot evaluate the SQL term "${t}" — teach it, do not skip it`);
}

/** Rows the statement's own trailing WHERE (up to `stop`) admits. */
function scopedRows(sql, params, stop = /$(?![\s\S])/) {
    const body = sql.slice(sql.search(/\bFROM compliance_incidents\b/i));
    const where = body.match(/\bWHERE\b([\s\S]*)/i)[1];
    const idx = where.search(stop);
    const expr = idx >= 0 ? where.slice(0, idx) : where;
    return rows.filter(r => evalWhere(expr, r, params));
}

function deadlineStatsFrom(sql, params) {
    const scoped = scopedRows(sql, params);
    const out = {};
    for (const m of sql.matchAll(/COUNT\(\*\) FILTER \(\s*WHERE ([\s\S]*?)\)::int AS (\w+)/g)) {
        out[m[2]] = scoped.filter(r => evalWhere(m[1], r, params)).length;
    }
    return out;
}

function needingAttention(sql, params) {
    return scopedRows(sql, params, /\bORDER BY\b/i)
        .slice()
        .sort((a, b) => _ts(a.deadline_at) - _ts(b.deadline_at))
        .map(r => ({ ...r }));
}

function backfillCandidates(sql, params) {
    const limit = Number(params[1]);
    return scopedRows(sql, params, /\bORDER BY\b/i)
        .slice()
        .sort((a, b) => a.id - b.id)
        .slice(0, limit)
        .map(r => ({ ...r }));
}

// ── DDL ──────────────────────────────────────────────────────────────────

test('boot DDL adds the register columns with the contract defaults and the kind index', () => {
    for (const col of ['kind', 'regimes', 'early_warning_due_at', 'early_warning_sent_at', 'final_report_due_at',
        'final_report_sent_at', 'customer_notified_at', 'reported_via', 'cve_ids', 'affected_products', 'exploited_in_wild']) {
        assert.match(bootDdl, new RegExp(`ADD COLUMN IF NOT EXISTS ${col} `), col);
    }
    assert.match(bootDdl, /kind TEXT NOT NULL DEFAULT 'breach'/);
    assert.match(bootDdl, /regimes JSONB NOT NULL DEFAULT '\["GDPR"\]'::jsonb/);
    assert.match(bootDdl, /CREATE INDEX IF NOT EXISTS idx_incidents_org_kind ON compliance_incidents\(organization_id, kind, status\)/);
    // "Nothing is due" has to be expressible, so the roll-up column is nullable.
    assert.match(bootDdl, /ALTER COLUMN deadline_at DROP NOT NULL/);
    assert.match(bootDdl, /CREATE TABLE IF NOT EXISTS compliance_incidents/);
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
    const bad = store.computeClocks(T0, { regimes: ['DORA'], customerNoticeHours: 'soon' });
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

test('createIncident writes kind, regimes and every clock column; the v1 bind positions are unchanged', async () => {
    await store.createIncident({
        organization_id: 'orgA', title: 'Auth bypass in connector', kind: 'vulnerability', regimes: ['CRA', 'NIS2'],
        detected_at: T0.toISOString(), severity: 'high',
        cve_ids: ['cve-2026-12345', 'not-a-cve'], affected_products: ['Connector', { name: 'API', version_range: '<2.4' }],
        exploited_in_wild: true, reported_via: 'ENISA_SRP',
    });
    const ins = mutations().find(m => /INSERT INTO compliance_incidents/.test(m.sql));
    assert.strictEqual(ins.params[0], 'orgA');
    assert.strictEqual(ins.params[3], 'high');
    assert.strictEqual(new Date(ins.params[7]).getTime(), T0.getTime(), 'detected_at at $8');
    assert.strictEqual(hoursAfter(ins.params[8]), 24, 'deadline_at at $9 = earliest clock');
    const row = rows[0];
    assert.strictEqual(row.kind, 'vulnerability');
    assert.deepStrictEqual(row.regimes, ['CRA', 'NIS2']);
    assert.strictEqual(hoursAfter(row.early_warning_due_at), 24);
    assert.strictEqual(hoursAfter(row.final_report_due_at), 14 * 24);
    assert.strictEqual(row.customer_notice_due_at, null);
    assert.deepStrictEqual(row.cve_ids, ['CVE-2026-12345'], 'only well-formed CVE ids survive');
    assert.deepStrictEqual(row.affected_products, [{ name: 'Connector', version_range: null }, { name: 'API', version_range: '<2.4' }]);
    assert.strictEqual(row.exploited_in_wild, true);
    assert.strictEqual(row.reported_via, 'ENISA_SRP');
});

test('createIncident: a plain breach stays a 72 h GDPR row (legacy shape); bad kind rejected; DORA uses customerNoticeHours', async () => {
    const out = await store.createIncident({ organization_id: 'orgA', title: 'Leak', detected_at: T0.toISOString() });
    assert.strictEqual(out.kind, 'breach');
    assert.deepStrictEqual(out.regimes, ['GDPR']);
    assert.strictEqual(hoursAfter(out.deadline_at), 72);
    assert.strictEqual(out.early_warning_due_at, null);
    assert.strictEqual(out.exploited_in_wild, null);
    assert.deepStrictEqual(out.cve_ids, []);

    await assert.rejects(() => store.createIncident({ organization_id: 'orgA', title: 'x', kind: 'rumour' }), /invalid kind/);
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
    mock.reset();
    return rows.find(x => x.id === r.id);
}

test('stampCraReport early_warning: stamps once, records the channel, moves open → early_warning_sent', async () => {
    const row = await seed();
    const out = await store.stampCraReport('orgA', row.id, { stage: 'early_warning', reportedVia: 'MijnNCSC', by: 'u-1' });
    assert.ok(row.early_warning_sent_at instanceof Date);
    assert.strictEqual(row.reported_via, 'MijnNCSC');
    assert.strictEqual(row.status, 'early_warning_sent');
    assert.strictEqual(out.status, 'early_warning_sent');
    const upd = mutations().find(m => /UPDATE compliance_incidents/.test(m.sql));
    assert.match(upd.sql, /early_warning_sent_at = COALESCE\(early_warning_sent_at, NOW\(\)\)/, 'first-wins stamp');
    assert.match(upd.sql, /WHERE organization_id = \$1 AND id = \$2/);
    assert.strictEqual(upd.params[0], 'orgA');

    const first = row.early_warning_sent_at;
    await store.stampCraReport('orgA', row.id, { stage: 'early_warning', reportedVia: 'other' });
    assert.strictEqual(row.early_warning_sent_at, first, 'a second stamp never overwrites');
    assert.strictEqual(row.reported_via, 'other', 'the channel may be corrected');
});

test('stampCraReport full: final report + notification stamped together, reference kept, status → reported', async () => {
    const row = await seed();
    await store.stampCraReport('orgA', row.id, { stage: 'early_warning', by: 'u-1' });
    mock.reset();
    await store.stampCraReport('orgA', row.id, { stage: 'full', reference: 'SRP-2026-0042', reportedVia: 'ENISA_SRP', by: 'u-2' });
    assert.ok(row.final_report_sent_at instanceof Date);
    assert.ok(row.authority_notified_at instanceof Date, 'a final report implies the notification');
    assert.strictEqual(row.authority_reference, 'SRP-2026-0042');
    assert.strictEqual(row.authority_notified_by, 'u-1', 'the first actor stays on the row');
    assert.strictEqual(row.status, 'reported');
    const upd = mutations().find(m => /UPDATE compliance_incidents/.test(m.sql));
    assert.match(upd.sql, /WHERE organization_id = \$1 AND id = \$2/);
    await assert.rejects(() => store.stampCraReport('orgA', row.id, { stage: 'interim' }), /invalid stage/);
});

test('stamps are org-scoped: a foreign organisation hits nothing and reads null', async () => {
    const row = await seed();
    const out = await store.stampCraReport('orgB', row.id, { stage: 'early_warning' });
    assert.strictEqual(out, null);
    assert.strictEqual(row.early_warning_sent_at, undefined);
    assert.strictEqual(row.status, 'open');
    const out2 = await store.stampCustomerNotified('orgB', row.id, 'u-9');
    assert.strictEqual(out2, null);
    assert.strictEqual(row.customer_notified_at, undefined);
    for (const m of mutations()) {
        assert.match(m.sql, /WHERE organization_id = \$1 AND id = \$2/);
        assert.strictEqual(m.params[0], 'orgB');
    }
});

test('stampCustomerNotified: first-wins stamp plus a note naming the actor', async () => {
    const row = await seed({ regimes: ['DORA'], kind: 'security_incident' });
    const out = await store.stampCustomerNotified('orgA', row.id, 'u-3');
    assert.ok(row.customer_notified_at instanceof Date);
    assert.strictEqual(row.notes.at(-1).by, 'u-3');
    assert.strictEqual(out.customer_notified_at, row.customer_notified_at);
    const first = row.customer_notified_at;
    await store.stampCustomerNotified('orgA', row.id, null);
    assert.strictEqual(row.customer_notified_at, first);
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
    mock.reset();
    assert.strictEqual(hoursAfter(row.deadline_at), 24, 'at intake the early warning is next');

    const out = await store.stampCraReport('orgA', row.id, { stage: 'early_warning', by: 'u-1' });
    assert.strictEqual(hoursAfter(out.deadline_at), 72, 'the filed 24 h clock no longer sets the deadline');
    assert.strictEqual(hoursAfter(rows.find(r => r.id === row.id).deadline_at), 72, 'and it is persisted');
    const upd = mutations().filter(m => /UPDATE compliance_incidents/.test(m.sql));
    assert.ok(upd.some(m => /deadline_at = \$3/.test(m.sql)), 'the roll-up is written');
    for (const m of upd) assert.match(m.sql, /WHERE organization_id = \$1 AND id = \$2/);
});

test('stampCraReport full clears deadline_at once every CRA clock is stamped', async () => {
    const row = await store.createIncident({
        organization_id: 'orgA', title: 'Vuln', kind: 'vulnerability', regimes: ['CRA'], detected_at: T0.toISOString(),
    });
    await store.stampCraReport('orgA', row.id, { stage: 'early_warning' });
    const out = await store.stampCraReport('orgA', row.id, { stage: 'full', reference: 'SRP-1' });
    assert.strictEqual(out.deadline_at, null, 'nothing is outstanding any more');
    assert.strictEqual(rows.find(r => r.id === row.id).deadline_at, null);
});

test('stampCustomerNotified clears the DORA customer clock', async () => {
    const dora = await store.createIncident({
        organization_id: 'orgA', title: 'Outage', kind: 'security_incident', regimes: ['DORA'],
        detected_at: T0.toISOString(), customerNoticeHours: 4,
    });
    assert.strictEqual(hoursAfter(dora.deadline_at), 4);
    const out = await store.stampCustomerNotified('orgA', dora.id, 'u-3');
    assert.strictEqual(out.deadline_at, null, 'the customers were told — nothing else is due under DORA');
    assert.strictEqual(rows.find(r => r.id === dora.id).deadline_at, null);
});

// ── reads ────────────────────────────────────────────────────────────────

test('listOpenClocks: every not-closed row with all clock columns, org-scoped, earliest deadline first', async () => {
    await store.createIncident({ organization_id: 'orgA', title: 'a', regimes: ['GDPR'], detected_at: T0.toISOString() });
    await store.createIncident({ organization_id: 'orgA', title: 'b', kind: 'vulnerability', detected_at: T0.toISOString() });
    await store.createIncident({ organization_id: 'orgB', title: 'c', kind: 'vulnerability', detected_at: T0.toISOString() });
    rows[0].status = 'closed';
    mock.reset();
    const list = await store.listOpenClocks('orgA');
    const sql = mock.calls.getAll[0].sql;
    assert.match(sql, /WHERE organization_id = \$1 AND status <> 'closed'/);
    assert.match(sql, /ORDER BY deadline_at ASC/);
    for (const col of ['kind', 'regimes', 'early_warning_due_at', 'early_warning_sent_at', 'final_report_due_at',
        'final_report_sent_at', 'customer_notice_due_at', 'customer_notified_at', 'authority_notified_at', 'reported_via', 'exploited_in_wild']) {
        assert.match(sql, new RegExp(`\\b${col}\\b`), col);
    }
    assert.deepStrictEqual(mock.calls.getAll[0].params, ['orgA']);
    // The equality matcher cannot see `<> 'closed'`; the org filter it can.
    assert.ok(list.every(r => r.organization_id === 'orgA'));
});

test('listIncidents accepts kind; getDeadlineStats counts open vulnerabilities', async () => {
    await store.listIncidents('orgA', { kind: 'vulnerability', status: 'open', limit: 10 });
    const q = mock.calls.getAll[0];
    assert.match(q.sql, /AND status = \$2/);
    assert.match(q.sql, /AND kind = \$3/);
    assert.deepStrictEqual(q.params, ['orgA', 'open', 'vulnerability', 10]);
    await assert.rejects(() => store.listIncidents('orgA', { kind: 'rumour' }), /invalid kind/);

    mock.reset();
    await store.getDeadlineStats('orgA');
    const s = mock.calls.getOne[0];
    assert.match(s.sql, /kind = 'vulnerability' AND status <> 'closed'\)::int AS vulnerabilities_open/);
    assert.deepStrictEqual(s.params[1], ['open', 'assessing', 'early_warning_sent'], 'an early warning keeps the row open');
});

// ── the read side: the predicates that DECIDE, at their boundaries ───────
//
// The clock arithmetic above is pinned to the minute. What was not pinned is
// what the aggregates then DO with it: `overdue_unnotified`, the 24-hour
// window and the notifier's own filter each turn on a comparison against
// NOW(), and none of them had an assertion in any form. Every row below sits
// one second either side of an edge, or exactly on it.

const AT = (ms) => new Date(NOW.getTime() + ms);
const SECOND = 1000;

function putRow(overrides = {}) {
    const row = {
        id: nextId++, organization_id: 'orgA', status: 'open', kind: 'breach',
        regimes: ['GDPR'], notes: [], detected_at: new Date(NOW.getTime() - 3 * D),
        deadline_at: null, early_warning_due_at: null, early_warning_sent_at: null,
        final_report_due_at: null, final_report_sent_at: null,
        customer_notice_due_at: null, customer_notified_at: null,
        authority_notified_at: null,
        ...overrides,
    };
    rows.push(row);
    return row;
}

test('getDeadlineStats: overdue starts one tick PAST the deadline — a row standing exactly on it is not yet late', async () => {
    const late = putRow({ deadline_at: AT(-SECOND) });
    const onTheDot = putRow({ deadline_at: AT(0) });
    const soon = putRow({ deadline_at: AT(SECOND) });

    const s = await store.getDeadlineStats('orgA');
    assert.strictEqual(s.overdue_unnotified, 1, 'only the row a second past its deadline');
    assert.strictEqual(s.nearing_deadline, 2, 'the other two are inside the 24-hour window');
    assert.strictEqual(s.open, 3);
    // The two buckets partition the open rows: nothing is both late and nearing.
    assert.strictEqual(s.overdue_unnotified + s.nearing_deadline, s.open);
    assert.ok(late && onTheDot && soon);
});

test('getDeadlineStats: the nearing window is half-open — the row exactly 24 hours out belongs to tomorrow', async () => {
    putRow({ deadline_at: AT(24 * H - SECOND) });
    putRow({ deadline_at: AT(24 * H) });
    putRow({ deadline_at: AT(24 * H + SECOND) });

    const s = await store.getDeadlineStats('orgA');
    assert.strictEqual(s.nearing_deadline, 1, 'only the row a second inside the window');
    assert.strictEqual(s.overdue_unnotified, 0);
    assert.strictEqual(s.open, 3, 'the other two are open, just not urgent');
});

test('getDeadlineStats: a notified row, a closed row and a row with nothing due are counted by neither deadline predicate', async () => {
    // The `authority_notified_at IS NULL` half of both predicates, isolated:
    // same open status, same overdue deadline, but the notification is filed.
    putRow({ status: 'early_warning_sent', authority_notified_at: AT(-2 * H), deadline_at: AT(-D) });
    // A closed incident is out of the open bucket altogether.
    putRow({ status: 'closed', deadline_at: AT(-D) });
    // And the row the whole deadline rewrite exists for: every clock met, so
    // deadline_at is NULL. NULL < NOW() is UNKNOWN, never true — this row must
    // not read as permanently overdue.
    putRow({ status: 'assessing', deadline_at: null });

    const s = await store.getDeadlineStats('orgA');
    assert.strictEqual(s.overdue_unnotified, 0);
    assert.strictEqual(s.nearing_deadline, 0);
    assert.strictEqual(s.open, 2, 'the notified row and the null-deadline row are still open');

    const params = mock.calls.getOne.at(-1).params;
    assert.strictEqual(params[0], 'orgA', 'org-scoped');
});

test('getDeadlineStats: vulnerabilities_open counts every not-closed vulnerability, whatever its clocks say', async () => {
    putRow({ kind: 'vulnerability', status: 'reported', deadline_at: null });
    putRow({ kind: 'vulnerability', status: 'open', deadline_at: AT(D) });
    putRow({ kind: 'vulnerability', status: 'closed', deadline_at: AT(-D) });
    putRow({ kind: 'breach', status: 'open', deadline_at: AT(D) });
    putRow({ kind: 'vulnerability', status: 'open', organization_id: 'orgB', deadline_at: AT(D) });

    const s = await store.getDeadlineStats('orgA');
    assert.strictEqual(s.vulnerabilities_open, 2, 'reported still counts, closed does not, another org never does');
});

test('getDeadlineStats: the Art. 33 counts run from detected_at + 72 h, for GDPR incidents only', async () => {
    // A GDPR+NIS2 incident at hour 25: its 24 h early warning is past due, so
    // the roll-up deadline_at is overdue, but the 72 h Art. 33 deadline is not.
    putRow({ regimes: ['GDPR', 'NIS2'], detected_at: AT(-25 * H), deadline_at: AT(-H) });
    // A CRA-only vulnerability past its early warning is never a GDPR matter.
    putRow({ kind: 'vulnerability', regimes: ['CRA'], detected_at: AT(-80 * H), deadline_at: AT(-56 * H) });
    // GDPR incidents a second past detected_at + 72 h, exactly on it, and 22 h before it.
    putRow({ regimes: ['GDPR'], detected_at: AT(-72 * H - SECOND), deadline_at: AT(-SECOND) });
    putRow({ regimes: ['GDPR'], detected_at: AT(-72 * H), deadline_at: AT(0) });
    putRow({ regimes: ['GDPR'], detected_at: AT(-50 * H), deadline_at: AT(22 * H) });
    // Notified long after its 72 h: no longer overdue.
    putRow({ regimes: ['GDPR'], status: 'early_warning_sent', detected_at: AT(-100 * H), authority_notified_at: AT(-30 * H), deadline_at: null });

    const s = await store.getDeadlineStats('orgA');
    assert.strictEqual(s.overdue_unnotified, 3, 'the roll-up: the early warning, the CRA clock and the late GDPR row');
    assert.strictEqual(s.gdpr_overdue_unnotified, 1, 'only the GDPR row a second past detected_at + 72 h');
    assert.strictEqual(s.gdpr_nearing_deadline, 2, 'the row on the dot and the one 22 h out; the GDPR+NIS2 row is 47 h out');
});

test('listNeedingAttention: the notifier picks up everything due inside 24 hours, and stops exactly at the edge', async () => {
    const overdue = putRow({ deadline_at: AT(-3 * H) });
    const inside = putRow({ deadline_at: AT(24 * H - SECOND) });
    putRow({ deadline_at: AT(24 * H) });
    putRow({ deadline_at: AT(24 * H + SECOND) });
    putRow({ deadline_at: null, status: 'assessing' });
    putRow({ deadline_at: AT(-3 * H), authority_notified_at: AT(-H), status: 'early_warning_sent' });
    putRow({ deadline_at: AT(-3 * H), status: 'closed' });

    const list = await store.listNeedingAttention('orgA');
    assert.deepStrictEqual(list.map(r => r.id), [overdue.id, inside.id], 'earliest deadline first');
    const q = mock.calls.getAll.at(-1);
    assert.deepStrictEqual(q.params, ['orgA', ['open', 'assessing', 'early_warning_sent']]);
});

test('hasRecentAutoIncident asks per org and per source inside the window', async () => {
    await store.hasRecentAutoIncident('orgA', 'dlp_signal', 6);
    const q = mock.calls.getOne.at(-1);
    assert.match(q.sql, /organization_id = \$1 AND source = \$2/);
    assert.match(q.sql, /detected_at >= NOW\(\) - \(\$3 \|\| ' hours'\)::interval/);
    assert.deepStrictEqual(q.params, ['orgA', 'dlp_signal', '6']);
});

// ── updateIncident's server-side stamps ──────────────────────────────────

test('a CRA severe incident is created with the one-month final clock and re-dated when the notification is stamped', async () => {
    const row = await store.createIncident({
        organization_id: 'orgA', title: 'Ransomware on the build server', kind: 'security_incident', regimes: ['CRA'],
        detected_at: T0.toISOString(),
    });
    const stored = rows.find(r => r.id === row.id);
    assert.strictEqual(new Date(stored.final_report_due_at).toISOString(), '2026-10-13T10:00:00.000Z', 'detected + 72 h + 1 month, not + 14 d');
    mock.reset();
    await store.updateIncident('orgA', row.id, { status: 'authority_notified' }, 'u-7');
    assert.ok(stored.authority_notified_at instanceof Date);
    const expected = addCalendarMonths(stored.authority_notified_at, 1);
    assert.strictEqual(new Date(stored.final_report_due_at).toISOString(), expected.toISOString(), 'one month from the recorded notification');
    const writes = mutations().filter(m => /final_report_due_at = \$3/.test(m.sql));
    assert.strictEqual(writes.length, 1);
    assert.match(writes[0].sql, /WHERE organization_id = \$1 AND id = \$2/);
    assert.strictEqual(writes[0].params[0], 'orgA');
});

test('a CRA vulnerability keeps its 14-day final clock through the notification stamp', async () => {
    const row = await seed();
    await store.updateIncident('orgA', row.id, { status: 'authority_notified' }, 'u-7');
    assert.strictEqual(hoursAfter(row.final_report_due_at), 14 * 24);
    assert.ok(!mutations().some(m => /final_report_due_at = \$3/.test(m.sql)), 'never re-dated');
});

test('updateIncident: status=authority_notified stamps the time and the actor itself, first-wins', async () => {
    const row = await seed({ kind: 'breach', regimes: ['GDPR'] });
    assert.strictEqual(row.authority_notified_at ?? null, null, 'nothing stamped at intake');

    const out = await store.updateIncident('orgA', row.id, { status: 'authority_notified', authority_reference: 'AP-2026-1' }, 'u-7');
    assert.ok(row.authority_notified_at instanceof Date, 'the store stamps the moment — the caller never sends it');
    assert.strictEqual(row.authority_notified_by, 'u-7');
    assert.strictEqual(row.authority_reference, 'AP-2026-1');
    assert.strictEqual(row.status, 'authority_notified');
    assert.strictEqual(out.deadline_at, null, 'Art. 33 satisfied → nothing is due to anyone outside');

    const first = row.authority_notified_at;
    await store.updateIncident('orgA', row.id, { status: 'authority_notified' }, 'u-9');
    assert.strictEqual(row.authority_notified_at, first, 'a second save never re-dates the notification');
    assert.strictEqual(row.authority_notified_by, 'u-7', 'nor re-attributes it');
});

test('updateIncident: subjects_notified stamps its own pair and does NOT satisfy the authority clock', async () => {
    const row = await seed({ kind: 'breach', regimes: ['GDPR'], high_risk: true });
    const out = await store.updateIncident('orgA', row.id, { status: 'subjects_notified' }, 'u-8');
    assert.ok(row.subjects_notified_at instanceof Date);
    assert.strictEqual(row.subjects_notified_by, 'u-8');
    assert.strictEqual(row.authority_notified_at ?? null, null, 'Art. 34 is not Art. 33');
    assert.strictEqual(hoursAfter(out.deadline_at), 72, 'so the 72-hour notification is still the next thing due');
});

test('updateIncident: a status that stamps nothing leaves every timestamp alone', async () => {
    const row = await seed({ kind: 'breach', regimes: ['GDPR'] });
    await store.updateIncident('orgA', row.id, { status: 'assessing', note: 'reviewing the logs' }, 'u-1');
    assert.strictEqual(row.status, 'assessing');
    assert.strictEqual(row.authority_notified_at ?? null, null);
    assert.strictEqual(row.subjects_notified_at ?? null, null);
    assert.strictEqual(row.notes.at(-1).text, 'reviewing the logs');
});

// ── the one-time backfill of rows stamped before the recompute existed ────

test('the deadline backfill runs inside the boot step, not as a separate migration', () => {
    assert.match(bootReads, /FROM compliance_incidents[\s\S]*WHERE id > \$1[\s\S]*deadline_at IS NOT NULL/);
});

test('backfillDeadlines re-points already-stamped rows at their next open clock and clears the finished ones', async () => {
    // Written before deadline_at moved with the stamps: the clock each row was
    // CREATED with is still on it, and nothing is ever going to stamp them again.
    const stale = putRow({
        kind: 'security_incident', regimes: ['NIS2'], status: 'early_warning_sent', detected_at: T0,
        early_warning_due_at: new Date(T0.getTime() + 24 * H),
        final_report_due_at: new Date('2026-10-10T10:00:00.000Z'),
        early_warning_sent_at: new Date(T0.getTime() + 20 * H),
        deadline_at: new Date(T0.getTime() + 24 * H),
    });
    const finished = putRow({
        kind: 'vulnerability', regimes: ['CRA'], status: 'reported', detected_at: T0,
        early_warning_due_at: new Date(T0.getTime() + 24 * H),
        final_report_due_at: new Date(T0.getTime() + 14 * D),
        early_warning_sent_at: new Date(T0.getTime() + 18 * H),
        authority_notified_at: new Date(T0.getTime() + 40 * H),
        final_report_sent_at: new Date(T0.getTime() + 10 * D),
        deadline_at: new Date(T0.getTime() + 24 * H),
    });
    const closed = putRow({ status: 'closed', detected_at: T0, deadline_at: new Date(T0.getTime() + 72 * H) });
    const untouched = putRow({ detected_at: T0, deadline_at: new Date(T0.getTime() + 72 * H) });
    mock.reset();

    const res = await store.backfillDeadlines();
    assert.deepStrictEqual(res, { scanned: 3, moved: 3 }, 'the unstamped open row is not even a candidate');
    assert.strictEqual(hoursAfter(stale.deadline_at), 72, 'the filed 24 h clock gives way to the 72 h notification');
    assert.strictEqual(finished.deadline_at, null, 'every CRA clock stamped → nothing is due at all');
    assert.strictEqual(closed.deadline_at, null, 'a closed incident owes nothing');
    assert.strictEqual(hoursAfter(untouched.deadline_at), 72, 'and an unstamped row is left exactly as it was');

    const writes = mutations();
    assert.strictEqual(writes.length, 3, 'one write per row that actually moves');
    for (const w of writes) {
        assert.match(w.sql, /UPDATE compliance_incidents SET deadline_at = \$3/);
        assert.match(w.sql, /WHERE organization_id = \$1 AND id = \$2/, 'org-scoped, one row at a time');
        assert.ok(!/updated_at/.test(w.sql), 'correcting a derived roll-up is not an edit of the incident');
        assert.ok(!/\bstatus\b|\bnotes\b|authority_|subjects_|_sent_at|_due_at/.test(w.sql), 'nothing else is touched');
    }
});

test('backfillDeadlines is safe to run twice: the second pass writes nothing', async () => {
    putRow({
        kind: 'security_incident', regimes: ['NIS2'], status: 'early_warning_sent', detected_at: T0,
        early_warning_due_at: new Date(T0.getTime() + 24 * H),
        final_report_due_at: new Date('2026-10-10T10:00:00.000Z'),
        early_warning_sent_at: new Date(T0.getTime() + 20 * H),
        deadline_at: new Date(T0.getTime() + 24 * H),
    });
    const finished = putRow({
        kind: 'vulnerability', regimes: ['CRA'], status: 'reported', detected_at: T0,
        early_warning_sent_at: new Date(T0.getTime() + 18 * H),
        authority_notified_at: new Date(T0.getTime() + 40 * H),
        final_report_sent_at: new Date(T0.getTime() + 10 * D),
        deadline_at: new Date(T0.getTime() + 24 * H),
    });
    await store.backfillDeadlines();
    const after = rows.map(r => (r.deadline_at ? new Date(r.deadline_at).getTime() : null));
    mock.reset();

    const second = await store.backfillDeadlines();
    assert.strictEqual(second.moved, 0, 'nothing moves on a second run');
    assert.strictEqual(mutations().length, 0, 'and nothing is written at all');
    assert.strictEqual(second.scanned, 1, 'the row it cleared has left the candidate set for good');
    assert.strictEqual(finished.deadline_at, null);
    assert.deepStrictEqual(rows.map(r => (r.deadline_at ? new Date(r.deadline_at).getTime() : null)), after);
});

test('backfillCraIncidentFinals re-dates severe incidents stored with the 14-day clock, once', async () => {
    const severe = putRow({
        kind: 'security_incident', regimes: ['CRA'], status: 'early_warning_sent', detected_at: T0,
        early_warning_due_at: new Date(T0.getTime() + 24 * H), early_warning_sent_at: new Date(T0.getTime() + 20 * H),
        authority_notified_at: new Date('2026-09-12T09:00:00.000Z'),
        final_report_due_at: new Date(T0.getTime() + 14 * D),
        deadline_at: new Date(T0.getTime() + 14 * D),
    });
    const vuln = putRow({
        kind: 'vulnerability', regimes: ['CRA'], detected_at: T0,
        final_report_due_at: new Date(T0.getTime() + 14 * D), deadline_at: new Date(T0.getTime() + 24 * H),
    });
    const filed = putRow({
        kind: 'breach', regimes: ['CRA'], detected_at: T0, final_report_sent_at: new Date(T0.getTime() + 5 * D),
        final_report_due_at: new Date(T0.getTime() + 14 * D), deadline_at: null,
    });
    mock.reset();

    const res = await store.backfillCraIncidentFinals();
    assert.deepStrictEqual(res, { scanned: 1, moved: 1 }, 'only the unfiled severe incident is a candidate');
    assert.strictEqual(new Date(severe.final_report_due_at).toISOString(), '2026-10-12T09:00:00.000Z', 'one month after the notification');
    assert.strictEqual(new Date(severe.deadline_at).toISOString(), '2026-10-12T09:00:00.000Z', 'the roll-up follows');
    assert.strictEqual(hoursAfter(vuln.final_report_due_at), 14 * 24, 'a vulnerability keeps its clock');
    assert.strictEqual(hoursAfter(filed.final_report_due_at), 14 * 24, 'a filed final report is history');
    for (const w of mutations()) {
        assert.match(w.sql, /WHERE organization_id = \$1 AND id = \$2/);
        assert.ok(!/updated_at/.test(w.sql), 'a derived clock correction is not an edit of the incident');
    }

    mock.reset();
    const second = await store.backfillCraIncidentFinals();
    assert.strictEqual(second.moved, 0);
    assert.strictEqual(mutations().length, 0, 'a second run writes nothing');
});

test('the CRA final-report backfill runs inside the boot step', () => {
    assert.match(bootReads, /WHERE id > \$1[\s\S]*kind <> 'vulnerability'[\s\S]*regimes @> '\["CRA"\]'::jsonb/);
});

test('constants exported for the routes and the checks', () => {
    assert.deepStrictEqual(store.VALID_KINDS, ['breach', 'security_incident', 'vulnerability']);
    assert.ok(store.VALID_STATUSES.includes('early_warning_sent'));
    assert.ok(store.VALID_STATUSES.includes('reported'));
    assert.deepStrictEqual(store.VALID_REGIMES, ['GDPR', 'NIS2', 'CRA', 'DORA']);
    assert.strictEqual(store.DEADLINE_HOURS, 72);
    assert.strictEqual(store.DEFAULT_CUSTOMER_NOTICE_HOURS, 4);
});
