/**
 * step.repeat: a step run once per item of a v2 Source (execRepeat.js), and
 * the loop it shares with the legacy forEach.
 *
 * Covers the M2 promises: 12 items, a single record (a list of one), an empty
 * list, a list that is not there, the cap, per-item input snapshots, and a
 * pick with `take: 'each'` reading the current item through
 * runState._mappingScope.
 *
 * Run: cd server && node --test core/automationRunner/execRepeat.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { execRepeatStep, repeatItems } = require('./execRepeat');
const { resolveInputs } = require('../../automation/bind');

const OVER = { root: 'steps', id: 'get', path: ['rows'] };
const each = (...path) => ({ kind: 'pick', v: 1, from: { root: 'steps', id: 'get', path: ['rows', ...path] }, take: 'each', as: 'native' });

function state(rows) {
    return { steps: { get: { output: { rows } } }, _templateWarnings: [], _mappingMemo: new Map() };
}

/** A leaf that "sends" what it resolved, so the result shows what each item got. */
const sends = async (step, ctx, subState) => ({ output: resolveInputs(step.inputs, subState) });

function repeatStep(extra = {}) {
    return { id: 'mail', type: 'integration_action', tool: 'gmail_send', repeat: { over: OVER }, inputs: { to: each('email'), n: each('n') }, ...extra };
}

test('12 items: one run each, each pick reading its own item', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ email: `p${i}@example.org`, n: i }));
    const out = await execRepeatStep(repeatStep(), {}, state(rows), 'live', sends);
    assert.equal(out.output.iterations, 12);
    assert.equal(out.output.succeeded, 12);
    assert.equal(out.output.failed, 0);
    assert.deepStrictEqual(out.output.results.map(r => r.output.to), rows.map(r => r.email));
    assert.deepStrictEqual(out.output.results[3], { index: 3, item: rows[3], output: { to: 'p3@example.org', n: 3 }, status: 'success' });
    assert.equal(out.skippedReason, undefined);
    assert.equal(out.output.truncated, undefined);
});

test('a single record is a list of one', async () => {
    const out = await execRepeatStep(repeatStep(), {}, state({ email: 'solo@example.org', n: 1 }), 'live', sends);
    assert.equal(out.output.iterations, 1);
    assert.deepStrictEqual(out.output.results[0].output, { to: 'solo@example.org', n: 1 });
});

test('an empty list runs nothing and is not a skip; a missing list is', async () => {
    const empty = await execRepeatStep(repeatStep(), {}, state([]), 'live', sends);
    assert.deepStrictEqual(empty.output, { iterations: 0, succeeded: 0, failed: 0, results: [] });
    assert.equal(empty.skippedReason, undefined);
    const missing = await execRepeatStep(repeatStep(), {}, { steps: { get: { output: {} } } }, 'live', sends);
    assert.equal(missing.skippedReason, 'overref_unresolved');
    assert.match(missing.output.skipped, /the list it repeats over `steps\.get\.output\.rows` did not resolve to one \(found nothing\)/);
    const nul = await execRepeatStep(repeatStep(), {}, state(null), 'live', sends);
    assert.equal(nul.skippedReason, 'overref_unresolved');
    const bad = await execRepeatStep(repeatStep({ repeat: { over: { root: 'steps', path: [] } } }), {}, state([]), 'live', sends);
    assert.equal(bad.skippedReason, 'overref_unresolved');
});

test('the cap: repeat.max items, and the run says the rest was left', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ email: `p${i}@x.nl` }));
    const out = await execRepeatStep(repeatStep({ repeat: { over: OVER, max: 2 } }), {}, state(rows), 'live', sends);
    assert.equal(out.output.iterations, 2);
    assert.equal(out.output.truncated, true);
    assert.equal(out.output.totalItems, 5);
});

test('a key on a list repeats over every item of every list', async () => {
    const st = { steps: { get: { output: { orders: [{ lines: [{ sku: 'A' }, { sku: 'B' }] }, { lines: [{ sku: 'C' }] }] } } } };
    const over = { root: 'steps', id: 'get', path: ['orders', 'lines'] };
    const sku = { kind: 'pick', v: 1, from: { root: 'steps', id: 'get', path: ['orders', 'lines', 'sku'] }, take: 'each', as: 'native' };
    const out = await execRepeatStep({ id: 'x', type: 'set', repeat: { over }, inputs: { sku } }, {}, st, 'live', sends);
    assert.deepStrictEqual(out.output.results.map(r => r.output.sku), ['A', 'B', 'C']);
    assert.deepStrictEqual(repeatItems(over, st).items.length, 3);
});

test('per-item input snapshots: the first item on top, the next ones under _perItem', async () => {
    const rows = [{ email: 'a@x.nl', n: 1 }, { email: 'b@x.nl', n: 2 }];
    const out = await execRepeatStep(repeatStep(), {}, state(rows), 'live', sends);
    assert.deepStrictEqual(out.forEachInputSnapshot, { to: 'a@x.nl', n: 1, _perItem: [{ index: 1, inputs: { to: 'b@x.nl', n: 2 } }] });
});

test('per-item failures are collected; all failing is a step error with the snapshots', async () => {
    const rows = [{ email: 'a@x.nl' }, { email: 'b@x.nl' }];
    const failSecond = async (step, ctx, sub) => {
        if (sub._mappingScope.index === 1) throw new Error('nope');
        return { output: 'ok' };
    };
    const out = await execRepeatStep(repeatStep(), {}, state(rows), 'live', failSecond);
    assert.equal(out.output.failed, 1);
    assert.equal(out.output.results[1].status, 'error');
    await assert.rejects(
        execRepeatStep(repeatStep(), {}, state(rows), 'live', async () => { throw new Error('down'); }),
        (err) => err.errorClass === 'foreach_all_failed' && err.forEachInputSnapshot.to === 'a@x.nl',
    );
});

test('a dry run over a synthesised list marks the result synthetic', async () => {
    const st = state([{ email: 'a@x.nl' }]);
    st.steps.get.synthesised = true;
    const out = await execRepeatStep(repeatStep(), {}, st, 'dry_run', sends);
    assert.equal(out.dryRunSynthesised, true);
});
