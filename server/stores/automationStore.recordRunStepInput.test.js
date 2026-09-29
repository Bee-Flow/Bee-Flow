/**
 * Regression: a step's recorded INPUT must survive the second write.
 *
 * recordRunStep upserts on (run_id, step_id, attempts). The engine now writes
 * the row TWICE — once at dispatch, `status:'running'` with no input yet, so a
 * public form's progress trail has something to read, and once on completion
 * with the real input and output. Whichever lands second wins the DO UPDATE.
 *
 * The conflict clause did not list `input_json` at all, so the column kept
 * whatever the INSERT put there: the dispatch row's null. Every step of every
 * run went input-less, and the run history's Input panel silently showed
 * nothing — a plain data-loss bug with no error anywhere.
 *
 * COALESCE(EXCLUDED, existing) is the fix and it has to be COALESCE rather than
 * a plain assignment, because the null arrives in the write that lands second
 * just as often as in the one that lands first (a retried attempt re-records).
 *
 * Pure — `../db` is mocked and the emitted SQL is inspected directly.
 */

const test = require('node:test');
const assert = require('node:assert');

const statements = [];
function mock(relPath, exports) {
    const resolved = require.resolve(relPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
mock('../db', {
    run: async (sql, params) => { statements.push({ sql, params }); return { rowCount: 1, rows: [] }; },
    getOne: async () => null,
    getAll: async () => [],
    exec: async () => {},
    getClient: async () => ({}),
    pool: { query: async () => ({ rows: [] }) },
});

const store = require('./automationStore');

const stepWrite = () => statements.find(s => /INSERT INTO automation_run_steps/.test(s.sql));

test('the conflict update preserves an input the row already has', async () => {
    statements.length = 0;
    await store.recordRunStep({
        runId: 'r1', stepId: 's1', stepType: 'ai_step', attempts: 1,
        status: 'running', startedAt: new Date().toISOString(),
        input: null, output: null, error: null,
    });
    const w = stepWrite();
    assert.ok(w, 'recordRunStep writes automation_run_steps');
    const onConflict = w.sql.slice(w.sql.indexOf('ON CONFLICT'));
    assert.match(
        onConflict,
        /input_json\s*=\s*COALESCE\(EXCLUDED\.input_json,\s*automation_run_steps\.input_json\)/,
        'a null input must never overwrite a recorded one',
    );
});

test('a completing write still carries its own input', async () => {
    statements.length = 0;
    await store.recordRunStep({
        runId: 'r1', stepId: 's1', stepType: 'ai_step', attempts: 1,
        status: 'success', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
        input: { prompt: 'hello' }, output: { text: 'hi' }, error: null,
    });
    const w = stepWrite();
    // $9 is input_json in the positional list; COALESCE keeps it when present.
    assert.ok(
        w.params.some(p => typeof p === 'string' && p.includes('"prompt"')),
        'the real input is still sent',
    );
});
