/**
 * Unit tests for execDateTime's input resolution.
 *
 * New behaviour: `step.input` / `step.input2` are resolved as ref paths
 * first (bind.walkPath); when the path does NOT resolve, the raw string is
 * treated as a LITERAL date ("2026-07-01" now works without a ref). An
 * unresolvable non-date string keeps today's error stub, and a resolvable
 * path always takes precedence over literal interpretation.
 *
 * Heavy deps are pre-mocked via the require cache (same approach as
 * ../automationRunner.aistep.test.js).
 *
 * Run: node --test core/automationRunner/utilitySteps.datetime.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function mock(relPath, exports) {
    const resolved = require.resolve(relPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

mock('../../stores/automationStore', {});
mock('../../stores/configStore', { getConfig: async () => null });
mock('../../stores/notificationStore', { createNotification: async () => {} });
mock('../../db', { pool: { query: async () => ({ rows: [] }) } });
mock('../aiAgent', {
    getProviderForModel: async () => ({ providerType: 'test', url: '', apiKey: 'k' }),
    getAIConfig: async () => ({ model: 'test-model' }),
});
mock('../providers', { getAdapter: () => ({}) });
mock('./safety', {
    GuardrailBlockError: class GuardrailBlockError extends Error {},
    resolveAutomationPolicy: async () => ({}),
    buildAuditBase: () => ({}),
    guardAiInput: async () => ({ tokenMap: {} }),
    guardAiOutput: async (content) => ({ content, tokenMap: {} }),
    guardToolInput: async (v) => ({ value: v, tokenMap: {} }),
    guardToolOutput: async (v) => ({ result: v, tokenMap: {} }),
    restoreForEgress: (v) => v,
    prepareForEgress: (v) => v,
    restoreForRunState: (v) => v,
    logEgress: async () => {},
});

const { execDateTime } = require('./engine');

const runState = {
    trigger: { output: { when: '2026-07-01T10:00:00.000Z' } },
    steps: {},
    vars: {},
};

test('resolvable ref path still wins', async () => {
    const { output } = await execDateTime({ op: 'parse', input: 'trigger.output.when' }, {}, runState);
    assert.strictEqual(output.iso, '2026-07-01T10:00:00.000Z');
});

test('literal ISO date is accepted when the path does not resolve', async () => {
    const { output } = await execDateTime({ op: 'parse', input: '2026-07-01' }, {}, runState);
    assert.ok(output.iso, 'expected a parsed date');
    assert.ok(output.iso.startsWith('2026-07-01') || output.iso.startsWith('2026-06-30'), output.iso);
});

test('literal dates work for diff too', async () => {
    const { output } = await execDateTime(
        { op: 'diff', input: '2026-07-01T00:00:00Z', input2: '2026-07-03T00:00:00Z', unit: 'days' },
        {}, runState,
    );
    assert.strictEqual(output.value, 2);
});

// A17 contract change: an unresolvable input used to return an error STUB
// ({iso:null, error}) that runDag recorded as a green SUCCESS while every
// downstream binding read null. It now throws with a stable errorClass, so
// the failure routes through on_error edges / run-error recording like any
// other loud step failure.
test('unresolvable non-date string throws loudly (no silent success)', async () => {
    await assert.rejects(
        () => execDateTime({ op: 'parse', input: 'steps.gone.output.when' }, {}, runState),
        (e) => e.errorClass === 'datetime_unresolved_input' && /did not resolve/.test(e.message),
    );
});

test('a path that resolves to a non-date value still errors (no literal fallback)', async () => {
    const state = { ...runState, trigger: { output: { when: { nested: true } } } };
    await assert.rejects(
        () => execDateTime({ op: 'parse', input: 'trigger.output.when' }, {}, state),
        (e) => e.errorClass === 'datetime_unresolved_input',
    );
});

test('diff with an unresolvable second input throws with the same class', async () => {
    await assert.rejects(
        () => execDateTime({ op: 'diff', unit: 'days', input: '2026-01-01', input2: 'steps.gone.output.x' }, {}, runState),
        (e) => e.errorClass === 'datetime_unresolved_input' && /input2/.test(e.message),
    );
});

// ── list mode (BFSF-375) ───────────────────────────────────────────────────
//
// Dropping a whole column of dates into "Input date" used to hand `toDate` an
// array of 17 strings, which parses as nothing, so the step failed with
// "did not resolve to a parseable date" — a dead end for anything working
// through a query result. With `arrayRef` the step now walks the table and
// ADDS A COLUMN, keeping every column the rows already had.

const listState = {
    trigger: { output: {} },
    steps: {
        search: {
            output: {
                results: [
                    { id: 'A-1', updated: '2026-08-18T12:17:48.312Z', priority: 'Normal' },
                    { id: 'A-2', updated: '2026-08-11T09:24:38.772Z', priority: 'Critical' },
                ],
            },
        },
    },
    vars: {},
};

test('list mode adds a column and keeps the ones already there', async () => {
    const { output } = await execDateTime(
        { op: 'extract', part: 'day', arrayRef: 'steps.search.output.results', input: 'item.updated' },
        {}, listState,
    );
    assert.strictEqual(output.count, 2);
    assert.strictEqual(output.items.length, 2);
    // The row survives whole…
    assert.strictEqual(output.items[0].id, 'A-1');
    assert.strictEqual(output.items[0].priority, 'Normal');
    // …and gains the requested part, named after it.
    assert.strictEqual(output.items[0].day, 18);
    assert.strictEqual(output.items[1].day, 11);
});

test('the new column can be named', async () => {
    const { output } = await execDateTime(
        { op: 'extract', part: 'day', target: 'dagnummer', arrayRef: 'steps.search.output.results', input: 'item.updated' },
        {}, listState,
    );
    assert.strictEqual(output.items[0].dagnummer, 18);
    assert.strictEqual(output.items[0].day, undefined);
});

test('the column is named after the operation when there is no part', async () => {
    const { output } = await execDateTime(
        { op: 'format', format: 'yyyy-MM-dd', arrayRef: 'steps.search.output.results', input: 'item.updated' },
        {}, listState,
    );
    assert.strictEqual(output.items[0].formatted, '2026-08-18');
});

test('a source list that does not resolve is skipped, not thrown', async () => {
    const res = await execDateTime(
        { op: 'extract', part: 'day', arrayRef: 'steps.nope.output.results', input: 'item.updated' },
        {}, listState,
    );
    assert.strictEqual(res.skippedReason, 'arrayref_unresolved');
    assert.deepStrictEqual(res.output.items, []);
    assert.match(res.output.skipped, /did not resolve/);
});

test('one unreadable row is nulled and counted, never fatal', async () => {
    const mixed = {
        ...listState,
        steps: { search: { output: { results: [
            { id: 'A-1', updated: '2026-08-18T12:17:48.312Z' },
            { id: 'A-2', updated: 'not a date at all' },
        ] } } },
    };
    const { output } = await execDateTime(
        { op: 'extract', part: 'day', arrayRef: 'steps.search.output.results', input: 'item.updated' },
        {}, mixed,
    );
    assert.strictEqual(output.items.length, 2);
    assert.strictEqual(output.items[0].day, 18);
    assert.strictEqual(output.items[1].day, null);
    assert.match(output.warning, /1 of 2 rows/);
});

test('pointing at the wrong column skips instead of emitting a table of nulls', async () => {
    // Every row failing is not bad data, it is the wrong column — say so.
    const res = await execDateTime(
        { op: 'extract', part: 'day', arrayRef: 'steps.search.output.results', input: 'item.priority' },
        {}, listState,
    );
    assert.strictEqual(res.skippedReason, 'datetime_unresolved_input');
    assert.deepStrictEqual(res.output.items, []);
    assert.match(res.output.skipped, /item\.priority/);
});

test('rows of plain scalars still work', async () => {
    const scalars = {
        ...listState,
        steps: { search: { output: { results: ['2026-08-18T12:17:48.312Z', '2026-08-11T09:24:38.772Z'] } } },
    };
    const { output } = await execDateTime(
        { op: 'extract', part: 'day', arrayRef: 'steps.search.output.results', input: 'item' },
        {}, scalars,
    );
    assert.strictEqual(output.items[0].value, '2026-08-18T12:17:48.312Z');
    assert.strictEqual(output.items[0].day, 18);
});

test('single mode is untouched by any of this', async () => {
    const { output } = await execDateTime({ op: 'parse', input: 'trigger.output.when' }, {}, runState);
    assert.strictEqual(output.iso, '2026-07-01T10:00:00.000Z');
    assert.strictEqual(output.items, undefined);
});

// ── a column saved WITHOUT list mode ───────────────────────────────────────
//
// The builder converts a dropped column into list mode in the field's
// onChange. A step saved before that — or imported, or written by the AI
// builder — still has the `[*]` path in `input` and no `arrayRef`. It failed
// with the original error; it now runs as the list mode it stands for.

test('a `[*]` column in input without arrayRef runs as list mode', async () => {
    const { output } = await execDateTime(
        { op: 'extract', part: 'day', input: 'steps.search.output.results[*].updated' },
        {}, listState,
    );
    assert.strictEqual(output.count, 2);
    assert.strictEqual(output.items[0].id, 'A-1');
    assert.strictEqual(output.items[0].day, 18);
    assert.strictEqual(output.items[1].day, 11);
});

test('a list of bare dates without arrayRef runs as list mode too', async () => {
    const scalars = {
        ...listState,
        steps: { search: { output: { results: ['2026-08-18T12:17:48.312Z', '2026-08-11T09:24:38.772Z'] } } },
    };
    const { output } = await execDateTime(
        { op: 'extract', part: 'day', input: 'steps.search.output.results[*]' },
        {}, scalars,
    );
    assert.deepStrictEqual(output.items.map((r) => r.day), [18, 11]);
});

test('diff over two columns of the same list reads both per row', async () => {
    const twoCols = {
        ...listState,
        steps: { search: { output: { results: [
            { created: '2026-08-10T00:00:00Z', updated: '2026-08-18T00:00:00Z' },
            { created: '2026-08-01T00:00:00Z', updated: '2026-08-11T00:00:00Z' },
        ] } } },
    };
    const { output } = await execDateTime(
        {
            op: 'diff', unit: 'days',
            input: 'steps.search.output.results[*].created',
            input2: 'steps.search.output.results[*].updated',
        },
        {}, twoCols,
    );
    assert.deepStrictEqual(output.items.map((r) => r.diff), [8, 10]);
});

test('an explicit arrayRef is taken as written', async () => {
    // Already list mode: the author addresses the row scope by hand, so a
    // `[*]` path there is theirs to keep (and fails per row, as before).
    const res = await execDateTime(
        { op: 'extract', part: 'day', arrayRef: 'steps.search.output.results', input: 'steps.search.output.results[*].updated' },
        {}, listState,
    );
    assert.strictEqual(res.skippedReason, 'datetime_unresolved_input');
});

test('`now` with a stale column left in its input stays a single date', async () => {
    // `now` never read `input`, so this step succeeded before; it must keep
    // its single-date output rather than turn into a table.
    const { output } = await execDateTime(
        { op: 'now', input: 'steps.search.output.results[*].updated' },
        {}, listState,
    );
    assert.ok(typeof output.iso === 'string' && output.iso.length > 0);
    assert.strictEqual(output.items, undefined);
});
