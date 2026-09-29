'use strict';

/**
 * "What breaks if I delete this agent?" — the POLICY half.
 *
 * The failure that matters here is the one where NOT KNOWING is reported as
 * NOTHING. A consumer table this install has not got, a scan that errored —
 * either would otherwise make the delete confirmation say "nothing uses this"
 * about an agent two routines run every night, and the person would believe
 * it, because they asked.
 *
 * The queries themselves are proved against real Postgres in
 * agentUsage.pg.test.js; the fake `query()` here never parses SQL, so a scan
 * naming a column that does not exist passes in this file and returns nothing
 * in production. Both suites are needed.
 *
 * Run: cd server && node --test --test-force-exit stores/agent/agentUsage.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    usageForAgent, usageCountsForAgents, unknownUsage, redactForeign, KINDS, SCANS,
} = require('./agentUsage');

/**
 * A fake pg client. `tables` names what exists (everything by default);
 * `rowsFor(kind, ids)` answers a scan; `failOn` makes one throw; `probeFails`
 * kills the existence probe itself.
 */
function db({ tables = KINDS.map(k => SCANS[k].table), rowsFor = () => [], failOn = [], probeFails = false } = {}) {
    const queries = [];
    return {
        queries,
        query: async (sql, params) => {
            if (/to_regclass/.test(sql)) {
                if (probeFails) throw new Error('probe exploded');
                const row = {};
                params.forEach((t, i) => { row[`t${i}`] = tables.includes(t); });
                return { rows: [row] };
            }
            queries.push({ sql, params });
            const kind = KINDS.find(k => SCANS[k].sql === sql);
            if (failOn.includes(kind)) throw new Error(`${kind} is down`);
            return { rows: rowsFor(kind, params[0]) || [] };
        },
    };
}

const TASK_ROW = (agentId) => ({
    agent_id: agentId, id: 'task-1', title: 'Nightly report',
    owner_id: 'u1', last_at: '2026-09-01T00:00:00Z',
});

// ── usageForAgent ───────────────────────────────────────────────────

test('a consumer comes back in the Used-by row shape', async () => {
    const d = db({ rowsFor: (kind, ids) => (kind === 'task' ? [TASK_ROW(ids[0])] : []) });
    const { rows, partial } = await usageForAgent('ag1', { db: d });
    assert.deepStrictEqual(partial, []);
    assert.deepStrictEqual(rows, [{
        kind: 'task', id: 'task-1', title: 'Nightly report',
        role: 'routine', ownerId: 'u1', lastAt: '2026-09-01T00:00:00Z',
    }]);
    assert.ok(!('agentId' in rows[0]), 'with one agent asked, echoing it back is noise');
});

test('a consumer table that does not exist is PARTIAL, never zero', async () => {
    // "App Studio is not installed here" is not the same statement as "no app
    // uses this agent", and only one of them is safe to delete on.
    const d = db({ tables: ['ai_tasks'] });
    const { rows, partial } = await usageForAgent('ag1', { db: d });
    assert.deepStrictEqual(rows, []);
    assert.ok(partial.includes('app'));
    assert.ok(partial.includes('webpage'));
    assert.ok(!partial.includes('task'), 'the one table that IS here was really asked');
});

test('a query that fails is PARTIAL too, and does not abandon the other kinds', async () => {
    const d = db({
        failOn: ['automation'],
        rowsFor: (kind, ids) => (kind === 'task' ? [TASK_ROW(ids[0])] : []),
    });
    const { rows, partial } = await usageForAgent('ag1', { db: d });
    assert.deepStrictEqual(partial, ['automation']);
    assert.strictEqual(rows.length, 1, 'the other five kinds were still asked');
});

test('a probe that itself fails makes EVERY kind unknown', async () => {
    // The narrow direction: one unreadable catalogue must not silently turn
    // into "checked, and nothing uses it".
    const d = db({ probeFails: true });
    const { rows, partial } = await usageForAgent('ag1', { db: d });
    assert.deepStrictEqual(rows, []);
    assert.deepStrictEqual(partial, [...KINDS]);
    assert.strictEqual(d.queries.length, 0, 'nothing was scanned, so nothing may be claimed');
});

test('no id is no work', async () => {
    const d = db();
    assert.deepStrictEqual(await usageForAgent(null, { db: d }), { rows: [], partial: [] });
    assert.deepStrictEqual(await usageForAgent('', { db: d }), { rows: [], partial: [] });
    assert.strictEqual(d.queries.length, 0);
});

test('no agent id ever enters the jsonpath — the ids are bound, the path is a constant', async () => {
    // An agent id is a route parameter. Concatenated into a jsonpath, a value
    // carrying a quote would close the string literal and be parsed as path
    // syntax — an injection into the path, placeholder or not.
    const d = db();
    await usageForAgent('ag" ? (@ == "x', { db: d });
    for (const q of d.queries) {
        if (!/jsonb_path_query/.test(q.sql)) continue;
        assert.match(q.sql, /'\$\.\*\*\.agentId'/, 'the path is a literal constant');
        assert.ok(!/\$1/.test(q.sql.match(/jsonb_path_query\([^)]*\)/)[0]), 'no parameter inside the path call');
        assert.deepStrictEqual(q.params, [['ag" ? (@ == "x']], 'the raw id, bound as text[]');
    }
});

test('a row whose agent_id is null is dropped rather than attributed to someone', async () => {
    const d = db({ rowsFor: (kind) => (kind === 'task' ? [{ ...TASK_ROW(null), agent_id: null }] : []) });
    const { rows } = await usageForAgent('ag1', { db: d });
    assert.deepStrictEqual(rows, []);
});

// ── usageCountsForAgents ────────────────────────────────────────────

test('counts per kind, per agent, from the SAME scan the delete guard runs', async () => {
    const d = db({
        rowsFor: (kind, ids) => {
            if (kind === 'task') return ids.includes('ag1') ? [TASK_ROW('ag1'), { ...TASK_ROW('ag1'), id: 'task-2' }] : [];
            if (kind === 'support') return ids.includes('ag2') ? [{ agent_id: 'ag2', id: 'in-1', title: 'Helpdesk', owner_id: 'u2' }] : [];
            return [];
        },
    });
    const out = await usageCountsForAgents(['ag1', 'ag2', 'ag3'], { db: d });
    assert.deepStrictEqual(out.ag1.counts, { task: 2 });
    assert.deepStrictEqual(out.ag2.counts, { support: 1 });
    assert.deepStrictEqual(out.ag3.counts, {}, 'an agent nothing uses counts nothing');
});

test('the list pills and the delete guard run literally the same statements', async () => {
    // Two query shapes would eventually disagree, and the disagreement people
    // meet is a list saying "used by nothing" beside a delete that refuses.
    const one = db();
    await usageForAgent('ag1', { db: one });
    const many = db();
    await usageCountsForAgents(['ag1', 'ag2'], { db: many });
    assert.deepStrictEqual(
        many.queries.map(q => q.sql),
        one.queries.map(q => q.sql));
    assert.deepStrictEqual(one.queries.map(q => q.params), [KINDS.map(() => [['ag1']])].flat());
});

test('every requested id gets an entry, so a missing key never has to be interpreted', async () => {
    const d = db();
    const out = await usageCountsForAgents(['ag1', 'ag2'], { db: d });
    assert.deepStrictEqual(Object.keys(out).sort(), ['ag1', 'ag2']);
});

test('a kind nobody could answer is unknown for EVERY agent in the batch', async () => {
    // Not "unknown for none of them": the pass either happened or it did not,
    // and the list pill must not read as a verified zero for the rest.
    const d = db({ tables: ['ai_tasks'], rowsFor: (kind, ids) => (kind === 'task' ? [TASK_ROW(ids[0])] : []) });
    const out = await usageCountsForAgents(['ag1', 'ag2'], { db: d });
    assert.ok(out.ag1.partial.includes('app'));
    assert.ok(out.ag2.partial.includes('app'));
    assert.deepStrictEqual(out.ag1.counts, { task: 1 });
});

test('a scan row for an id nobody asked about is ignored, not invented', async () => {
    const d = db({ rowsFor: (kind) => (kind === 'task' ? [TASK_ROW('somebody-else')] : []) });
    const out = await usageCountsForAgents(['ag1'], { db: d });
    assert.deepStrictEqual(Object.keys(out), ['ag1']);
    assert.deepStrictEqual(out.ag1.counts, {});
});

test('nothing in, nothing asked', async () => {
    const d = db();
    assert.deepStrictEqual(await usageCountsForAgents([], { db: d }), {});
    assert.strictEqual(d.queries.length, 0);
});

test('ids are chunked, and every chunk is really asked', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `ag${i}`);
    const d = db({ rowsFor: () => [] });
    await usageCountsForAgents(ids, { db: d });
    const taskCalls = d.queries.filter(q => q.sql === SCANS.task.sql);
    assert.strictEqual(taskCalls.length, 3, '450 ids at 200 per round trip');
    assert.deepStrictEqual(
        taskCalls.flatMap(q => q.params[0]).sort(),
        [...ids].sort(),
        'no id was dropped between chunks');
});

// ── the "I know nothing" value ──────────────────────────────────────

test('unknownUsage is empty counts plus EVERY kind unknown', async () => {
    const u = unknownUsage();
    assert.deepStrictEqual(u.counts, {});
    assert.deepStrictEqual(u.partial, [...KINDS]);
    u.partial.push('tampered');
    assert.deepStrictEqual(unknownUsage().partial, [...KINDS], 'callers get their own copy');
});

// ── redaction ───────────────────────────────────────────────────────

test('a row the asker does not own is counted but not named', async () => {
    const rows = [
        { kind: 'task', id: 't1', title: 'Mine', ownerId: 'u1' },
        { kind: 'task', id: 't2', title: 'A colleague\'s', ownerId: 'u2' },
    ];
    const out = redactForeign(rows, 'u1');
    assert.strictEqual(out[0].title, 'Mine');
    assert.ok(!out[0].foreign);
    assert.strictEqual(out[1].title, null, 'the name goes');
    assert.strictEqual(out[1].foreign, true);
    assert.strictEqual(out.length, 2, 'the count stays honest');
});

test('a foreign row loses its id and its owner too, not only its title', async () => {
    // A routine id the asker cannot open is of no use to them, and `ownerId`
    // names the colleague who built it. "Who in this organisation automates
    // against this agent" is not a question this tab was asked.
    const rows = [{ kind: 'automation', id: 'au1', title: 'Payroll export', role: 'ai_step', ownerId: 'u2', lastAt: '2026-09-01T00:00:00Z' }];
    assert.deepStrictEqual(redactForeign(rows, 'u1'), [{
        kind: 'automation', id: null, title: null, role: 'ai_step',
        ownerId: null, lastAt: null, foreign: true,
    }]);
});

test('an owner-less row, or an asker-less call, is redacted rather than assumed to be yours', async () => {
    const rows = [{ kind: 'app', id: 'a1', title: 'Intake', ownerId: null }];
    assert.strictEqual(redactForeign(rows, 'u1')[0].foreign, true);
    assert.strictEqual(redactForeign([{ kind: 'app', id: 'a1', title: 'Intake', ownerId: 'u1' }], null)[0].foreign, true);
});
