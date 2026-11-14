// @typecheck
/**
 * recordRunStep stores VALID JSON in output_json / input_json even when a
 * string value contains a real NUL byte or the literal 6-char text
 * backslash-u0000, against a real Postgres: the whole schema of the boot
 * ladder on PGlite (testUtils/pgliteTemplate.js ladderPglite) behind db.js's
 * pool. A NUL in a jsonb value makes Postgres refuse the insert and kills step
 * persistence for the whole run, so here the jsonb insert itself is the check.
 *
 * Run: cd server && node --test stores/automationStore.recordRunStepNul.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');

const { usePglitePool } = require('../testUtils/pglitePool');
const { ladderPglite } = require('../testUtils/pgliteTemplate');

const { pg, close } = usePglitePool(ladderPglite());
const store = require('./automationStore');
const { isTruncatedOutput } = require('./automationStore/payloadTruncation');

const NUL = String.fromCharCode(0);

test.before(async () => {
    // The step rows are under test, not their run: foreign keys stay out of the way.
    await pg.exec('SET session_replication_role = replica');
});
test.after(close);

let seq = 0;
/** Record one step with `output` and read back what Postgres stored. */
async function storedOutput(output) {
    seq += 1;
    const stepId = `s${seq}`;
    await store.recordRunStep({
        runId: 'r1', stepId, stepType: 'ai_step', status: 'success',
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
        input: null, output,
    });
    const { rows } = await pg.query('SELECT output_json FROM automation_run_steps WHERE run_id = $1 AND step_id = $2', ['r1', stepId]);
    assert.strictEqual(rows.length, 1, 'the step row landed');
    const v = rows[0].output_json;
    return { stepId, value: typeof v === 'string' ? JSON.parse(v) : v };
}

test('output containing the literal text \\u0000 is stored and keeps the text', async () => {
    const { value } = await storedOutput({ note: 'path\\u0000end' });
    assert.strictEqual(value.note, 'path\\u0000end', 'literal backslash-u0000 text is preserved');
});

test('output containing a real NUL byte is stored with the NUL stripped, nested values included', async () => {
    const { value } = await storedOutput({ text: 'before' + NUL + 'after', nested: { arr: ['x' + NUL + 'y'] } });
    assert.strictEqual(value.text, 'beforeafter');
    assert.strictEqual(value.nested.arr[0], 'xy');
});

test('ordinary output is unchanged', async () => {
    const { value } = await storedOutput({ count: 3, items: [{ id: 'a' }], flag: true });
    assert.deepStrictEqual(value, { count: 3, items: [{ id: 'a' }], flag: true });
});

test('an output over the cap keeps a NUL-free full copy, and the row names it', async () => {
    const items = Array.from({ length: 4000 }, (_, i) => ({ id: i, text: 'row' + NUL + 'x'.repeat(80) }));
    const { stepId, value } = await storedOutput({ items });
    assert.ok(isTruncatedOutput(value), 'the row itself holds the sentinel');
    assert.deepStrictEqual(value.fullOutputRef, { runId: 'r1', stepId, attempts: 1 });

    const { rows } = await pg.query('SELECT * FROM automation_run_full_outputs WHERE run_id = $1 AND step_id = $2', ['r1', stepId]);
    assert.strictEqual(rows.length, 1, 'the full copy is kept beside the row');
    const packed = Object.values(rows[0]).find((v) => v instanceof Uint8Array);
    const copy = JSON.parse(zlib.gunzipSync(Buffer.from(packed)).toString('utf8'));
    assert.strictEqual(copy.items.length, 4000, 'the whole output, not a sample');
    assert.strictEqual(copy.items[0].text.indexOf(NUL), -1, 'the copy went through the same NUL pass as the row');
});
