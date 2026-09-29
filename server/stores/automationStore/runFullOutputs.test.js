/**
 * The full copy of a truncated step output (BFSF-435).
 *
 * What is pinned:
 *   - an output under the row cap is stored as it is, and no copy is made;
 *   - an output over it keeps a copy FIRST and only then names it on the
 *     sentinel — a sentinel never points at a copy that does not exist;
 *   - the copy is the value after the row's own clean pass (NUL stripping);
 *   - the sentinel stays a sentinel for every guard that refuses one;
 *   - above the copy limit, with copies switched off, or when the write
 *     fails, the row gets the plain sentinel it always got;
 *   - the copy round-trips through the table unchanged.
 *
 * Pure: the save and the db facade are injected. (Requiring the module
 * constructs the pg Pool but does not connect.)
 *
 * Run: cd server && node --test stores/automationStore/runFullOutputs.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { persistableOutput, createRunFullOutputs } = require('./runFullOutputs');
const { isTruncatedOutput, fullOutputRefOf, DEFAULT_MAX_BYTES } = require('../../automation/payloadTruncation');

const REF = { runId: 'run-1', stepId: 'http1', attempts: 1 };
const big = () => ({ status: 200, data: { items: Array.from({ length: 4000 }, (_, i) => ({ id: i, text: 'x'.repeat(80) })) } });

function recordingSave() {
    const calls = [];
    const save = async (args) => { calls.push(args); };
    return { calls, save };
}

test('an output under the cap is stored as it is, and no copy is made', async () => {
    const { calls, save } = recordingSave();
    const value = { rows: [1, 2, 3] };
    assert.equal(await persistableOutput({ value, ref: REF, save }), value);
    assert.equal(calls.length, 0);
});

test('an output over the cap keeps its copy and the sentinel names it', async () => {
    const { calls, save } = recordingSave();
    const value = big();
    const out = await persistableOutput({ value, ref: REF, save, maxBytes: 8 * 1024 * 1024 });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].value, value, 'the copy is the whole output');
    assert.ok(calls[0].originalBytes > DEFAULT_MAX_BYTES);
    assert.equal(isTruncatedOutput(out), true, 'the row still holds a sentinel, not data');
    assert.deepEqual(fullOutputRefOf(out), REF);
});

test('the copy is taken after the row\'s own clean pass', async () => {
    const { calls, save } = recordingSave();
    const clean = (v) => ({ ...v, cleaned: true });
    await persistableOutput({ value: big(), ref: REF, save, clean });
    assert.equal(calls[0].value.cleaned, true);
});

test('a later attempt\'s copy is keyed to that attempt', async () => {
    const { calls, save } = recordingSave();
    const out = await persistableOutput({ value: big(), ref: { ...REF, attempts: 3 }, save });
    assert.equal(calls[0].attempts, 3);
    assert.equal(fullOutputRefOf(out).attempts, 3);
});

test('above the copy limit, or with copies off, the row gets the plain sentinel', async () => {
    for (const maxBytes of [DEFAULT_MAX_BYTES + 1, 0]) {
        const { calls, save } = recordingSave();
        const out = await persistableOutput({ value: big(), ref: REF, save, maxBytes });
        assert.equal(calls.length, 0, `maxBytes=${maxBytes}: nothing kept`);
        assert.equal(isTruncatedOutput(out), true);
        assert.equal(fullOutputRefOf(out), null, 'no ref to a copy that does not exist');
    }
});

test('a failed write costs the copy, never the step row', async () => {
    const save = async () => { throw new Error('disk full'); };
    const out = await persistableOutput({ value: big(), ref: REF, save });
    assert.equal(isTruncatedOutput(out), true);
    assert.equal(fullOutputRefOf(out), null);
});

// ── The table, over a fake db facade ───────────────────────────────────────

function fakeDb() {
    const rows = new Map();
    const key = (p) => `${p[0]}|${p[1]}|${p[2]}`;
    return {
        rows,
        initDB: async () => {},
        run: async (sql, params) => {
            assert.match(sql, /INSERT INTO automation_run_full_outputs/);
            assert.match(sql, /ON CONFLICT \(run_id, step_id, attempts\) DO UPDATE/, 'a re-recorded attempt replaces its copy');
            rows.set(key(params), { output_gz: params[3], original_bytes: params[4] });
            return { rowCount: 1 };
        },
        getOne: async (_sql, params) => rows.get(key(params)) || null,
    };
}

test('a kept copy round-trips unchanged, and is stored compressed', async () => {
    const db = fakeDb();
    const store = createRunFullOutputs(db);
    const value = big();
    const serialized = Buffer.byteLength(JSON.stringify(value));
    await store.saveRunFullOutput({ ...REF, value, originalBytes: serialized });

    const stored = [...db.rows.values()][0];
    assert.ok(Buffer.isBuffer(stored.output_gz));
    assert.ok(stored.output_gz.length < serialized / 4, `gzip keeps it small (${stored.output_gz.length} of ${serialized} bytes)`);
    assert.equal(stored.original_bytes, serialized);
    assert.deepEqual(await store.getRunFullOutput(REF.runId, REF.stepId, REF.attempts), value);
});

test('no copy reads as null — for another attempt, another step, or no ids at all', async () => {
    const store = createRunFullOutputs(fakeDb());
    await store.saveRunFullOutput({ ...REF, value: big(), originalBytes: 1 });
    assert.equal(await store.getRunFullOutput(REF.runId, REF.stepId, 2), null);
    assert.equal(await store.getRunFullOutput(REF.runId, 'other'), null);
    assert.equal(await store.getRunFullOutput('', REF.stepId), null);
});
