/**
 * Collection-op executors — node-audit A6/A7/A10/A11/A16.
 *
 * Run: node --test core/automationRunner/utilitySteps.collections.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function mock(relPath, exports) {
    const resolved = require.resolve(relPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

mock('../../stores/automationStore', { getAutomation: async () => null, recordRunStep: async () => {} });
mock('../../stores/configStore', {});
mock('../../stores/notificationStore', { createNotification: async () => ({}) });
mock('../../db', { pool: {} });
mock('../aiAgent', { getProviderForModel: async () => null });
mock('../providers', { getAdapter: () => ({}) });
mock('../../automation/codeSandbox', { run: async () => ({}) });

const { execFilter, execLimit, execDedupe, execAggregate, execSummarize } = require('./engine');

const state = (items) => ({ trigger: { output: { items } }, steps: {}, vars: {}, secrets: {}, loop: {}, _templateWarnings: [] });
const REF = 'trigger.output.items';

// ── A6: limit last+0 ─────────────────────────────────────────────────────────

test('limit mode=last count=0 returns NO items (slice(-0) bug)', async () => {
    const r = await execLimit({ arrayRef: REF, count: 0, mode: 'last' }, {}, state([1, 2, 3]));
    assert.deepStrictEqual(r.output, { items: [], count: 0 });
});

test('limit mode=last count=2 returns the last two', async () => {
    const r = await execLimit({ arrayRef: REF, count: 2, mode: 'last' }, {}, state([1, 2, 3]));
    assert.deepStrictEqual(r.output.items, [2, 3]);
});

// ── A11: Limit is exempt from the input cap ──────────────────────────────────

test('limit works on a list larger than the 10k cap; filter still throws', async () => {
    const big = Array.from({ length: 12_000 }, (_, i) => i);
    const r = await execLimit({ arrayRef: REF, count: 100, mode: 'first' }, {}, state(big));
    assert.strictEqual(r.output.count, 100);

    await assert.rejects(
        () => execFilter({ arrayRef: REF, expr: 'item > 0' }, {}, state(big)),
        (e) => e.errorClass === 'collection_too_large' && /Limit step/.test(e.message),
    );
});

// ── A10: unresolved arrayRef is a SKIP, not a green success ──────────────────

test('unresolved arrayRef returns skippedReason on all five ops', async () => {
    const s = state([1]);
    const missing = { arrayRef: 'trigger.output.ghost' };
    for (const [name, fn, extra] of [
        ['filter', execFilter, { expr: 'true' }],
        ['limit', execLimit, { count: 1 }],
        ['dedupe', execDedupe, {}],
        ['aggregate', execAggregate, { field: 'x' }],
        ['summarize', execSummarize, { op: 'sum', field: 'x' }],
    ]) {
        const r = await fn({ ...missing, ...extra }, {}, s);
        assert.strictEqual(r.skippedReason, 'arrayref_unresolved', `${name} must be recorded as skipped`);
        assert.match(r.output.skipped, /found nothing/);
        // BFSF-363: naming the broken path is the whole point — "did not
        // resolve to an array" told the author nothing about WHICH binding.
        assert.match(r.output.skipped, /trigger\.output\.ghost/);
        assert.match(r.output.skipped, /Re-run the step that produces it/);
    }
});

test('a NON-array resolution names the actual type in the skip message', async () => {
    const s = state([1]);
    s.trigger.output.notAList = { a: 1 };
    const r = await execLimit({ arrayRef: 'trigger.output.notAList', count: 1 }, {}, s);
    assert.match(r.output.skipped, /found object/);
});

test('a genuinely empty list is a plain success, NOT a skip', async () => {
    const r = await execFilter({ arrayRef: REF, expr: 'true' }, {}, state([]));
    assert.strictEqual(r.skippedReason, undefined);
    assert.deepStrictEqual(r.output.items, []);
});

// ── A16: dedupe keyField sanity ──────────────────────────────────────────────

test('dedupe with a keyField no item has passes everything through with a warning', async () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const r = await execDedupe({ arrayRef: REF, keyField: 'Id' }, {}, state(items)); // wrong case
    assert.strictEqual(r.output.items.length, 3, 'must NOT collapse to one item');
    assert.strictEqual(r.output.removed, 0);
    assert.match(r.output.warning, /not present on any item/);
});

test('dedupe with a partially-present keyField keeps the old grouping behaviour', async () => {
    const items = [{ id: 1 }, { noId: true }, { id: 1 }, { alsoNoId: true }];
    const r = await execDedupe({ arrayRef: REF, keyField: 'id' }, {}, state(items));
    // 1, missing-group, (dup 1 removed), (dup missing removed)
    assert.strictEqual(r.output.items.length, 2);
    assert.strictEqual(r.output.removed, 2);
});

test('dedupe whole-item mode unchanged', async () => {
    const r = await execDedupe({ arrayRef: REF }, {}, state([1, 2, 1, 3, 2]));
    assert.deepStrictEqual(r.output.items, [1, 2, 3]);
});

// ── A7: summarize count semantics ────────────────────────────────────────────

test('summarize op=count counts ITEMS regardless of field, and reports count honestly', async () => {
    const items = [{ name: 'a' }, { name: 'b' }, { name: 'c' }]; // no numeric field at all
    const r = await execSummarize({ arrayRef: REF, op: 'count' }, {}, state(items));
    assert.strictEqual(r.output.result, 3);
    assert.strictEqual(r.output.count, 3, 'count used to report values.length (0 here) while result said 3');
});

test('summarize numeric ops still report the numeric-value count', async () => {
    const items = [{ amount: 2 }, { amount: 'x' }, { amount: 4 }];
    const r = await execSummarize({ arrayRef: REF, op: 'sum', field: 'amount' }, {}, state(items));
    assert.strictEqual(r.output.result, 6);
    assert.strictEqual(r.output.count, 2);
});

// ── A18: a field no item carries is a SKIP, not a confident wrong number ─────

test('summarize sum over a field absent from every item skips instead of reporting 0', async () => {
    const items = [{ total: 10 }, { total: 20 }]; // author typed "amount"
    const r = await execSummarize({ arrayRef: REF, op: 'sum', field: 'amount' }, {}, state(items));
    assert.strictEqual(r.skippedReason, 'summarize_field_absent');
    assert.strictEqual(r.output.result, null, 'must NOT be 0 — a €0 total reads as a real answer');
    assert.strictEqual(r.output.inputCount, 2);
    assert.match(r.output.skipped, /"amount" is not on any item/);
});

test('summarize avg/min/max over an absent field skip the same way', async () => {
    const items = [{ total: 10 }];
    for (const op of ['avg', 'min', 'max']) {
        const r = await execSummarize({ arrayRef: REF, op, field: 'amount' }, {}, state(items));
        assert.strictEqual(r.skippedReason, 'summarize_field_absent', `${op} must skip`);
        assert.strictEqual(r.output.result, null);
    }
});

test('summarize op=count is exempt — it never reads the field', async () => {
    const r = await execSummarize({ arrayRef: REF, op: 'count', field: 'nope' }, {}, state([{ a: 1 }, { a: 2 }]));
    assert.strictEqual(r.skippedReason, undefined);
    assert.strictEqual(r.output.result, 2);
});

test('summarize with a PARTIALLY present field still totals, and says how much it used', async () => {
    const items = [{ amount: 5 }, { other: 1 }, { amount: 7 }];
    const r = await execSummarize({ arrayRef: REF, op: 'sum', field: 'amount' }, {}, state(items));
    assert.strictEqual(r.skippedReason, undefined);
    assert.strictEqual(r.output.result, 12);
    assert.strictEqual(r.output.usedCount, 2);
    assert.strictEqual(r.output.inputCount, 3);
});

test('summarize over an empty list is a plain success, not a field skip', async () => {
    const r = await execSummarize({ arrayRef: REF, op: 'sum', field: 'amount' }, {}, state([]));
    assert.strictEqual(r.skippedReason, undefined);
    assert.strictEqual(r.output.result, 0);
});

test('aggregate over a field absent from every item skips instead of emitting undefineds', async () => {
    const items = [{ mail: 'a@b.c' }, { mail: 'd@e.f' }];
    const r = await execAggregate({ arrayRef: REF, field: 'email' }, {}, state(items));
    assert.strictEqual(r.skippedReason, 'aggregate_field_absent');
    assert.deepStrictEqual(r.output.values, [], 'used to be [undefined, undefined] with count 2');
    assert.strictEqual(r.output.count, 0);
    assert.match(r.output.skipped, /"email" is not on any item/);
});

test('aggregate with a partially present field reports foundCount alongside count', async () => {
    const items = [{ email: 'a@b.c' }, { other: 1 }];
    const r = await execAggregate({ arrayRef: REF, field: 'email' }, {}, state(items));
    assert.strictEqual(r.skippedReason, undefined);
    assert.strictEqual(r.output.count, 2);
    assert.strictEqual(r.output.foundCount, 1);
    assert.strictEqual(r.output.inputCount, 2);
});

// ── A17: an unknown operator fails loud rather than succeeding with null ──────

test('summarize with an unknown op throws instead of recording a green null', async () => {
    await assert.rejects(
        () => execSummarize({ arrayRef: REF, op: 'median', field: 'amount' }, {}, state([{ amount: 1 }])),
        (e) => e.errorClass === 'summarize_op_unknown' && /median/.test(e.message),
    );
});

// ── Filter counts: what was kept OF what came in ─────────────────────────────

test('filter reports inputCount and rejectedCount alongside the kept items', async () => {
    const r = await execFilter(
        { arrayRef: REF, expr: 'item > 1' }, {},
        state([1, 2, 3]),
    );
    assert.deepStrictEqual(r.output.items, [2, 3]);
    assert.strictEqual(r.output.count, 2);
    assert.strictEqual(r.output.inputCount, 3);
    assert.strictEqual(r.output.rejectedCount, 1);
});

test('filter counts stay coherent when everything is kept or dropped', async () => {
    const all = await execFilter({ arrayRef: REF, expr: 'true' }, {}, state([1, 2]));
    assert.strictEqual(all.output.inputCount, 2);
    assert.strictEqual(all.output.rejectedCount, 0);
    const none = await execFilter({ arrayRef: REF, expr: 'false' }, {}, state([1, 2]));
    assert.strictEqual(none.output.count, 0);
    assert.strictEqual(none.output.rejectedCount, 2);
});
