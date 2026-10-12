const test = require('node:test');
const assert = require('node:assert');

const { runPollDiff, makePassCtx, BudgetExhausted, _internals } = require('./pollDiff');

/**
 * The generic poll-and-diff producer. These tests are written against a
 * made-up "acme" integration on purpose: if they pass, an integration can add a
 * working app_event trigger without a line of code in the platform, which is
 * the whole point of the trigger-source declarations.
 */

// A declaration exactly as an integration would ship it.
const acmeEvent = (over = {}) => ({
    id: 'widget.changed',
    label: 'Widget changed',
    fields: ['sku', 'state'],
    sample: { sku: 'W-1', state: 'idle' },
    scope: 'user',
    source: {
        kind: 'poll_diff',
        tool: 'acme_list_widgets',
        args: { limit: 100 },
        requiresIntegration: 'acme',
        itemsPath: 'widgets',
        idPath: 'sku',
        changePaths: ['state'],
        firstRun: 'anchor',
        minIntervalMs: 30_000,
        cacheTtlMs: 0,
        maxItemsPerTick: 25,
        maxTrackedItems: 200,
        trackValues: true,
        emit: { mode: 'item', map: { sku: 'sku', state: 'state' }, includeChanges: true },
        ...over,
    },
});

function harness({ result, entitled = true, sub = {} } = {}) {
    const calls = [];
    const saved = [];
    const passCtx = makePassCtx({
        toolBudget: 40,
        executeTool: async (tool, args, ctx) => {
            calls.push({ tool, args, userId: ctx.userId, userAuth: ctx.userAuth });
            return typeof result === 'function' ? result(calls.length) : result;
        },
        resolveEntitlements: async () => (entitled === 'degraded'
            ? { degraded: true, effective: { integration: new Set() } }
            : { effective: { integration: new Set(entitled ? ['acme'] : []) } }),
    });
    const store = { updateSubscription: async (id, patch) => { saved.push({ id, ...patch }); } };
    const subscription = { id: 'sub-1', userId: 'user-1', lastCursor: null, ...sub };
    return { passCtx, store, calls, saved, subscription };
}

const widgets = (list) => ({ widgets: list });
const run = (h, eventDef = acmeEvent()) => runPollDiff(h.subscription, eventDef, h.passCtx, { automationStore: h.store });

// A cursor records when it last really called the tool, and a subscription may
// not poll again inside its minimum interval. Tests that want a second poll
// have to move that stamp back, exactly as wall-clock time would.
const aged = (cursor) => JSON.stringify({ ...JSON.parse(cursor), t: 0 });

test('a brand-new integration produces events with no platform code', async () => {
    // Anchor, then flip one widget's state.
    const h = harness({ result: widgets([{ sku: 'W-1', state: 'idle' }, { sku: 'W-2', state: 'idle' }]) });
    const first = await run(h);
    assert.deepStrictEqual(first.events, [], 'first poll anchors and emits nothing');

    const h2 = harness({
        result: widgets([{ sku: 'W-1', state: 'running' }, { sku: 'W-2', state: 'idle' }]),
        sub: { lastCursor: aged(h.saved[0].lastCursor) },
    });
    const second = await run(h2);
    assert.strictEqual(second.events.length, 1);
    assert.strictEqual(second.events[0].sku, 'W-1');
    assert.deepStrictEqual(second.events[0].changedKeys, ['state']);
    assert.deepStrictEqual(second.events[0].previous, { state: 'idle' });
    assert.deepStrictEqual(second.events[0].current, { state: 'running' });
});

test('activating an automation never fires once per pre-existing item', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ sku: `W-${i}`, state: 'idle' }));
    const h = harness({ result: widgets(many) });
    const { events } = await run(h);
    assert.deepStrictEqual(events, []);
    assert.strictEqual(h.saved.length, 1, 'but it does record where it started');
});

test('the tool is called as the subscriber, with the id MCP dispatch reads', async () => {
    const h = harness({ result: widgets([]) });
    await run(h);
    assert.strictEqual(h.calls[0].userId, 'user-1');
    // toolExecution resolves the MCP caller from userAuth, never context.userId.
    assert.strictEqual(h.calls[0].userAuth.userId, 'user-1');
    assert.deepStrictEqual(h.calls[0].args, { limit: 100 });
});

test('identical polls collapse per user — but never across users', async () => {
    const ev = acmeEvent({ cacheTtlMs: 60_000 });
    const h = harness({ result: widgets([{ sku: 'W-1', state: 'idle' }]) });
    await runPollDiff({ id: 's1', userId: 'user-1', lastCursor: null }, ev, h.passCtx, { automationStore: h.store });
    await runPollDiff({ id: 's2', userId: 'user-1', lastCursor: null }, ev, h.passCtx, { automationStore: h.store });
    assert.strictEqual(h.calls.length, 1, 'two subs of one user share the call');

    await runPollDiff({ id: 's3', userId: 'user-2', lastCursor: null }, ev, h.passCtx, { automationStore: h.store });
    assert.strictEqual(h.calls.length, 2, 'a different user never reads the cached result');
    assert.strictEqual(h.calls[1].userId, 'user-2');
});

test('re-ordering an array of data points is not a change', async () => {
    const ev = acmeEvent({
        changePaths: [{ path: 'status', keyBy: 'code', pick: 'value' }],
        emit: { mode: 'item', map: { sku: 'sku' }, includeChanges: true },
    });
    const a = [{ code: 'x', value: 1 }, { code: 'y', value: 2 }];
    const b = [{ code: 'y', value: 2 }, { code: 'x', value: 1 }];

    const h = harness({ result: widgets([{ sku: 'W-1', status: a }]) });
    await run(h, ev);
    const h2 = harness({ result: widgets([{ sku: 'W-1', status: b }]), sub: { lastCursor: aged(h.saved[0].lastCursor) } });
    const { events } = await run(h2, ev);
    assert.deepStrictEqual(events, [], 'same values, different order');

    const h3 = harness({
        result: widgets([{ sku: 'W-1', status: [{ code: 'x', value: 9 }, { code: 'y', value: 2 }] }]),
        sub: { lastCursor: aged(h.saved[0].lastCursor) },
    });
    const changed = await run(h3, ev);
    assert.strictEqual(changed.events.length, 1);
    assert.deepStrictEqual(changed.events[0].changedKeys, ['status.x']);
});

test('the cursor stays inside its byte budget on a huge account', async () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ sku: `W-${i}`, state: 'idle' }));
    const h = harness({ result: widgets(many) });
    await run(h);
    const cursor = h.saved[0].lastCursor;
    assert.ok(Buffer.byteLength(cursor) <= _internals.MAX_CURSOR_BYTES,
        `cursor is ${Buffer.byteLength(cursor)} bytes`);
    assert.strictEqual(JSON.parse(cursor).trunc, true, 'and says it truncated');
});

test('a truncated listing suppresses appear-events instead of flapping', async () => {
    const ev = acmeEvent({ emitOnAppear: true, maxTrackedItems: 2 });
    const h = harness({ result: widgets([{ sku: 'A', state: 'x' }, { sku: 'B', state: 'x' }, { sku: 'C', state: 'x' }]) });
    await run(h, ev);
    const h2 = harness({
        result: widgets([{ sku: 'D', state: 'x' }, { sku: 'E', state: 'x' }, { sku: 'F', state: 'x' }]),
        sub: { lastCursor: aged(h.saved[0].lastCursor) },
    });
    const { events } = await run(h2, ev);
    assert.deepStrictEqual(events, []);
});

test('hitting the per-tick cap defers work instead of losing it', async () => {
    const ev = acmeEvent({ maxItemsPerTick: 5 });
    const before = Array.from({ length: 12 }, (_, i) => ({ sku: `W-${i}`, state: 'idle' }));
    const after = Array.from({ length: 12 }, (_, i) => ({ sku: `W-${i}`, state: 'running' }));

    const h = harness({ result: widgets(before) });
    await run(h, ev);
    let cursor = aged(h.saved[0].lastCursor);

    const seen = [];
    for (let tick = 0; tick < 4; tick += 1) {
        const hi = harness({ result: widgets(after), sub: { lastCursor: cursor } });
        const { events } = await run(hi, ev);
        seen.push(...events.map(e => e.sku));
        cursor = aged(hi.saved[0].lastCursor);
    }
    assert.strictEqual(new Set(seen).size, 12, 'every changed widget fired exactly once');
    assert.strictEqual(seen.length, 12, 'and none fired twice');
});

test('the minimum interval short-circuits before any external call', async () => {
    const fresh = JSON.stringify({ v: 1, k: 'pd', t: Date.now(), h: [] });
    const h = harness({ result: widgets([]), sub: { lastCursor: fresh } });
    const { skipped } = await run(h);
    assert.strictEqual(skipped, 'interval');
    assert.strictEqual(h.calls.length, 0);
});

test('an unreadable cursor re-anchors rather than re-firing everything', async () => {
    for (const bad of ['not json', '{"v":99}', JSON.stringify({ v: 1, k: 'other', h: [] })]) {
        const h = harness({ result: widgets([{ sku: 'W-1', state: 'idle' }]), sub: { lastCursor: bad } });
        const { events } = await run(h);
        assert.deepStrictEqual(events, [], `re-anchored on ${bad}`);
        assert.ok(h.saved[0].lastCursor, 'and wrote a fresh cursor');
    }
});

test('a tool failure surfaces and leaves the cursor untouched', async () => {
    // toolExecution swallows MCP errors into { error } instead of throwing; if
    // that leaked through as data the poll would look like "no changes" forever.
    const h = harness({ result: { error: 'upstream exploded' } });
    await assert.rejects(() => run(h), /upstream exploded/);
    assert.strictEqual(h.saved.length, 0, 'no cursor advance on failure');
});

test('an MCP result arrives as a JSON string and is still diffed', async () => {
    const h = harness({ result: { result: JSON.stringify(widgets([{ sku: 'W-1', state: 'idle' }])) } });
    await run(h);
    assert.strictEqual(h.saved.length, 1);
    assert.strictEqual(JSON.parse(h.saved[0].lastCursor).h.length, 1);
});

test('a revoked integration stops the polling; a degraded resolver does not accuse the user', async () => {
    const revoked = harness({ result: widgets([]), entitled: false });
    assert.strictEqual((await run(revoked)).skipped, 'no_capability');
    assert.strictEqual(revoked.calls.length, 0, 'no call is made for an integration the user lost');

    const degraded = harness({ result: widgets([]), entitled: 'degraded' });
    assert.strictEqual((await run(degraded)).skipped, 'degraded');
});

test('the per-pass call budget defers rather than failing the subscription', async () => {
    const h = harness({ result: widgets([]) });
    h.passCtx.toolBudget = 0;
    await assert.rejects(() => run(h), (e) => e instanceof BudgetExhausted);
});

test('items with no resolvable id are ignored, not treated as one item', async () => {
    const h = harness({ result: widgets([{ state: 'idle' }, { sku: '', state: 'idle' }, { sku: 'W-1', state: 'idle' }]) });
    await run(h);
    assert.strictEqual(JSON.parse(h.saved[0].lastCursor).h.length, 1);
});

// ── contentWatch: a filter-picked target switches what is watched ───────
//
// google-sheets is the real consumer: no spreadsheetId in the filter → the
// base spec diffs the file list; a picked spreadsheet → the variant polls the
// sheet's rows and diffs them by position. These tests use the acme shape so
// the mechanism is proven without the integration.

const acmeContentWatch = () => acmeEvent({
    contentWatch: {
        when: 'widgetId',
        tool: 'acme_get_widget_rows',
        buildArgs: (filter) => ({ widgetId: filter.widgetId }),
        itemsPath: 'values',
        idPath: '$index',
        changePaths: ['$'],
        emit: { mode: 'item', map: { row: '$', rowIndex: '$index' }, includeChanges: true },
        emitFromFilter: { widgetId: 'widgetId' },
    },
});

test('without the filter key the base spec is used, untouched', async () => {
    const h = harness({ result: widgets([{ sku: 'W-1', state: 'idle' }]), sub: { filter: {} } });
    await run(h, acmeContentWatch());
    assert.strictEqual(h.calls[0].tool, 'acme_list_widgets');
    assert.deepStrictEqual(h.calls[0].args, { limit: 100 });
});

test('a filter-picked target switches the tool and derives args from the filter', async () => {
    const h = harness({ result: { values: [['a', 1], ['b', 2]] }, sub: { filter: { widgetId: 'W-9' } } });
    const first = await run(h, acmeContentWatch());
    assert.strictEqual(h.calls[0].tool, 'acme_get_widget_rows');
    assert.deepStrictEqual(h.calls[0].args, { widgetId: 'W-9' });
    assert.deepStrictEqual(first.events, [], 'first poll anchors');

    const h2 = harness({
        result: { values: [['a', 1], ['b', 3], ['c', 4]] },
        sub: { filter: { widgetId: 'W-9' }, lastCursor: aged(h.saved[0].lastCursor) },
    });
    const second = await run(h2, acmeContentWatch());
    assert.strictEqual(second.events.length, 1, 'a new row is not a change of a watched row');
    assert.deepStrictEqual(second.events[0].row, ['b', 3]);
    assert.strictEqual(second.events[0].rowIndex, 1);
    assert.strictEqual(second.events[0].widgetId, 'W-9', 'emitFromFilter echoes the watched target');
    assert.deepStrictEqual(second.events[0].previous, { '$': ['b', 2] });
    assert.deepStrictEqual(second.events[0].current, { '$': ['b', 3] });
});

test('resolveEffectiveSource leaves a spec without contentWatch alone', () => {
    const src = acmeEvent().source;
    assert.strictEqual(_internals.resolveEffectiveSource(src, { widgetId: 'W-1' }), src);
    assert.strictEqual(_internals.resolveEffectiveSource(src, null), src);
});
