/**
 * transcriptionStore — the list-row aggregates the library rail reads
 * (Bee Flow Builder redesign, Sep 2026, Track M1).
 *
 * The rail's meta line says "27 jul · 1:01 · 14 acties open" without the list
 * ever shipping `action_items`; and a failed note's reason is a field of its
 * own instead of a `summary` that is not one. Both are computed in SQL, on
 * BOTH query branches (super admin / normal user), and both must be tolerant
 * of a JSON scalar in `action_items` — the same one-bad-row rule
 * parseJsonArray already enforces on the read side.
 *
 * Same fake `db` harness as transcriptionStore.insights.test.js: query text and
 * params are captured, nothing reaches Postgres.
 *
 * Run: cd server && node --test --test-force-exit stores/transcriptionStore.list.aggregates.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const state = { calls: [], runResult: { rowCount: 1, rows: [] }, oneRow: null, allRows: [] };

const dbPath = require.resolve('../db');
require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
        exec: async (sql) => { state.calls.push({ fn: 'exec', sql }); },
        run: async (sql, params) => { state.calls.push({ fn: 'run', sql, params }); return state.runResult; },
        getOne: async (sql, params) => { state.calls.push({ fn: 'getOne', sql, params }); return state.oneRow; },
        getAll: async (sql, params) => { state.calls.push({ fn: 'getAll', sql, params }); return state.allRows; },
    },
};

const store = require('./transcriptionStore');

beforeEach(() => {
    state.calls = [];
    state.runResult = { rowCount: 1, rows: [] };
    state.oneRow = null;
    state.allRows = [];
});

const lastList = () => [...state.calls].reverse().find((c) => /FROM transcriptions/.test(c.sql || ''));

const BRANCHES = [
    { isSuperAdmin: true },
    { orgIds: ['org-1'], userGroupIds: ['g1'] },
    { orgIds: ['org-1'] },
    {},
];

test('getTranscriptions: actions_total / actions_open / failure_reason are selected on every branch', async () => {
    for (const opts of BRANCHES) {
        state.calls = [];
        state.allRows = [];
        await store.getTranscriptions('u1', opts);
        const { sql } = lastList();
        assert.match(sql, /AS actions_total\b/, `actions_total for ${JSON.stringify(opts)}`);
        assert.match(sql, /AS actions_open\b/, `actions_open for ${JSON.stringify(opts)}`);
        // The failure reason is no longer computed in SQL: it lives in
        // `summary`, which is now encrypted, and LEFT() over an envelope
        // returns the head of a ciphertext. The list carries the summary
        // column instead and derives the reason after decrypting it — so what
        // has to be pinned here is that the SOURCE is selected on every branch.
        assert.match(sql, /AS summary_snippet\b/, `summary preview for ${JSON.stringify(opts)}`);
        assert.match(sql, /summary_snippet_enc\b/,
            `the stored (encrypted) summary preview must be selected for ${JSON.stringify(opts)}`);
        // The counts must never ship the array itself: the column may only
        // appear inside the aggregate expressions, not as a bare selection.
        assert.doesNotMatch(sql, /,\s*action_items\s*,/, `action_items must not be a bare column for ${JSON.stringify(opts)}`);
    }
});

test('getTranscriptions: the aggregates tolerate a non-array action_items and read `done` as text', async () => {
    await store.getTranscriptions('u1', { isSuperAdmin: true });
    const { sql } = lastList();
    // A JSON scalar in the column must count as an empty list, not error.
    assert.match(sql, /jsonb_typeof\(action_items\) = 'array'/);
    // `done` is compared as text — a ::boolean cast on a stray "yes" would
    // throw and take the whole list down for everyone.
    assert.match(sql, /COALESCE\(ai->>'done', 'false'\) <> 'true'/);
    assert.doesNotMatch(sql, /'done'\)::boolean/);
});

test('getTranscriptions: failureReason is the summary ONLY for failed notes', async () => {
    // Same promise as before, now kept in Node because the column it reads is
    // encrypted. Pinned behaviourally rather than by SQL text, so it holds
    // whichever side computes it.
    state.allRows = [
        { id: 't-1', user_id: 'u1', status: 'completed', summary_snippet: 'A good meeting.' },
        { id: 't-2', user_id: 'u1', status: 'failed', summary_snippet: 'Transcription failed: recording empty' },
        { id: 't-3', user_id: 'u1', status: 'processing', summary_snippet: '' },
    ];
    const [done, failed, processing] = await store.getTranscriptions('u1', { isSuperAdmin: true });
    assert.strictEqual(done.failureReason, null, 'a completed note has no reason');
    assert.strictEqual(failed.failureReason, 'Transcription failed: recording empty');
    assert.strictEqual(processing.failureReason, null);
});

test('getTranscriptions: the summary preview is capped at the same 400 characters SQL used to cut', async () => {
    // The cap moved from LEFT(summary, 400) into Node. Losing it would ship
    // every meeting's entire summary on every list row.
    const { SUMMARY_SNIPPET_CHARS } = require('./transcriptCrypto');
    assert.strictEqual(SUMMARY_SNIPPET_CHARS, 400);
    state.allRows = [{ id: 't-1', user_id: 'u1', status: 'failed', summary_snippet: 'x'.repeat(1200) }];
    const [row] = await store.getTranscriptions('u1', { isSuperAdmin: true });
    assert.strictEqual(row.summarySnippet.length, 400);
    assert.strictEqual(row.failureReason.length, 400);
});

test('getTranscriptions: the row carries actionsTotal / actionsOpen / failureReason as numbers and a nullable string', async () => {
    state.allRows = [
        { id: 't-1', user_id: 'u1', title: 'Open', status: 'completed', actions_total: '3', actions_open: '2', summary_snippet: null },
        { id: 't-2', user_id: 'u1', title: 'Failed', status: 'failed', actions_total: 0, actions_open: 0, summary_snippet: 'Transcription failed: recording empty' },
    ];
    const [open, failed] = await store.getTranscriptions('u1', { isSuperAdmin: true });
    // pg returns COUNT(*) as text unless cast; the mapper normalises anyway.
    assert.strictEqual(open.actionsTotal, 3);
    assert.strictEqual(open.actionsOpen, 2);
    assert.strictEqual(open.failureReason, null);
    assert.strictEqual(failed.actionsTotal, 0);
    assert.strictEqual(failed.actionsOpen, 0);
    assert.strictEqual(failed.failureReason, 'Transcription failed: recording empty');
});

test('getTranscriptions: a payload that did not select the aggregates carries no aggregate keys', async () => {
    // Other callers of mapRow (getSeriesPrevious, the single-note shape) do
    // not select them; the mapper must not invent a 0 that reads as "no
    // actions" for a note that simply was not asked.
    state.allRows = [{ id: 't-1', user_id: 'u1', title: 'T' }];
    const [row] = await store.getTranscriptions('u1', { isSuperAdmin: true });
    assert.ok(!('actionsTotal' in row));
    assert.ok(!('actionsOpen' in row));
    assert.ok(!('failureReason' in row));
});

test('getTranscriptions: the ACL predicate and the limit/offset params are unchanged by the aggregates', async () => {
    await store.getTranscriptions('u1', { limit: 20, offset: 40, orgIds: ['org-1'], userGroupIds: ['g1'] });
    const { sql, params } = lastList();
    assert.deepStrictEqual(params.slice(0, 3), ['u1', 20, 40]);
    assert.match(sql, /WHERE user_id = \$1 OR shared_with @> \$4::jsonb OR \(is_published = true AND organization_id = ANY\(\$5::text\[\]\) AND \(shared_groups = '\[\]'::jsonb OR shared_groups \?\| \$6::text\[\]\)\)/);
    assert.match(sql, /LIMIT \$2 OFFSET \$3/);
});
