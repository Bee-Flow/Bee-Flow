/**
 * BFSF-356 — non-exclusive fan-out, OPT-IN per node.
 *
 * The ticket asks for a router whose outputs are NOT mutually exclusive: every
 * output is "a filter with its own destination", each is asked independently,
 * and a record that matches two of them travels both paths ("contains land"
 * and "contains water" both fire for a record that has both). The engine was
 * strictly first-match-wins — `cases.find()` — so a record could only ever
 * take one path.
 *
 * Turning that into `cases.filter()` unconditionally would change every switch
 * in every customer database: records that take one path today would start
 * taking several, which for a routing node means duplicate emails, duplicate
 * tickets and duplicate API writes for customers who changed nothing. So the
 * fan-out is an explicit per-step field:
 *
 *   step.matchMode ABSENT or 'first'  → today's behaviour, byte for byte
 *   step.matchMode === 'all'          → every output asked independently
 *   anything else                     → 'first' (defence in depth; the
 *                                       validator rejects it outright)
 *
 * The ABSENT default is the entire compatibility mechanism, which is why the
 * pre-existing execSwitch.* suites are left untouched: they now read as the
 * matchMode:'first' contract.
 *
 * Run: node --test core/automationRunner/execSwitch.matchMode.test.js
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

const { execSwitch, runDag } = require('./engine');

// The ticket's own example: an output per topic, and a record that is about
// both belongs in both.
const PARCELS = [
    { id: 1, note: 'land register update' },
    { id: 2, note: 'water board levy' },
    { id: 3, note: 'land and water permit' },
    { id: 4, note: 'nothing relevant' },
];

function state() {
    return {
        trigger: { output: { note: 'land and water permit' } },
        steps: { src: { output: { rows: PARCELS } } },
        vars: {}, secrets: {}, loop: {}, _templateWarnings: [],
    };
}

const LAND_WATER = [
    { name: 'land', expr: 'contains(item.note, "land")' },
    { name: 'water', expr: 'contains(item.note, "water")' },
];

const listSwitch = (extra = {}) => ({
    id: 'sw', type: 'switch',
    arrayRef: 'steps.src.output.rows',
    cases: LAND_WATER,
    ...extra,
});

// ── The collection path (arrayRef / column expr) ────────────────────────────

test('matchMode ABSENT keeps first-match-wins: a row that matches two outputs takes one', async () => {
    const { output } = await execSwitch(listSwitch(), {}, state());
    assert.deepStrictEqual(output.matchesByCase.land.map(r => r.id), [1, 3]);
    assert.deepStrictEqual(output.matchesByCase.water.map(r => r.id), [2],
        'row 3 is about land AND water, but "land" consumed it — this is the stored contract');
    assert.deepStrictEqual(output.matchesByCase.default.map(r => r.id), [4]);
});

test("matchMode 'first' is spelled-out-identical to the absent field", async () => {
    const absent = (await execSwitch(listSwitch(), {}, state())).output;
    const explicit = (await execSwitch(listSwitch({ matchMode: 'first' }), {}, state())).output;
    assert.deepStrictEqual(explicit, absent);
});

test("matchMode 'all' asks every output independently — no output consumes the row", async () => {
    const { output } = await execSwitch(listSwitch({ matchMode: 'all' }), {}, state());
    assert.deepStrictEqual(output.matchesByCase.land.map(r => r.id), [1, 3]);
    assert.deepStrictEqual(output.matchesByCase.water.map(r => r.id), [2, 3],
        'the land-AND-water row travels BOTH paths — the whole point of the feature');
    assert.deepStrictEqual([...output.branches].sort(), ['case:default', 'case:land', 'case:water']);
    assert.strictEqual(output.matched, 'land,water,default',
        '`matched` names every bucket that fired, not just the first');
});

test('a row that matches NO output is rejected and stays visible in the counters', async () => {
    const { output } = await execSwitch(listSwitch({ matchMode: 'all' }), {}, state());
    // The ticket's counters requirement: `total` is what came in, the default
    // bucket is what matched nothing at all.
    assert.strictEqual(output.total, 4);
    assert.deepStrictEqual(output.matchesByCase.default.map(r => r.id), [4]);
    assert.strictEqual(output.counts.default, 1);
});

test('per-output counts may now sum to MORE than the input — that is the feature, not a bug', async () => {
    const { output } = await execSwitch(listSwitch({ matchMode: 'all' }), {}, state());
    const summed = Object.values(output.counts).reduce((a, b) => a + b, 0);
    assert.strictEqual(summed, 5, 'land 2 + water 2 + default 1');
    assert.ok(summed > output.total, 'a record travelling two paths is counted on both of them');
    // …while first-match still adds up to exactly the input.
    const first = (await execSwitch(listSwitch(), {}, state())).output;
    assert.strictEqual(Object.values(first.counts).reduce((a, b) => a + b, 0), first.total);
});

test('an unrecognised matchMode falls back to first-match in the engine (the validator rejects it)', async () => {
    for (const bogus of ['ALL', 'any', 'every', 'fisrt', true, 1, {}]) {
        const { output } = await execSwitch(listSwitch({ matchMode: bogus }), {}, state());
        assert.deepStrictEqual(output.matchesByCase.water.map(r => r.id), [2],
            `matchMode ${JSON.stringify(bogus)} must not silently become fan-out`);
        assert.strictEqual(output.branches.includes('case:water'), true);
    }
});

test('fan-out still redirects the unmatched rows through defaultBranch', async () => {
    const { output } = await execSwitch(
        listSwitch({ matchMode: 'all', defaultBranch: 'water' }), {}, state(),
    );
    assert.deepStrictEqual(output.matchesByCase.water.map(r => r.id), [2, 3, 4],
        'row 4 matched nothing and was redirected into the named case');
    assert.strictEqual(output.viaDefault, true);
    assert.strictEqual(output.matchesByCase.default, undefined);
});

// ── The scalar path ────────────────────────────────────────────────────────

const scalarSwitch = (extra = {}) => ({
    id: 'sw', type: 'switch',
    cases: [
        { name: 'land', expr: 'contains(trigger.output.note, "land")' },
        { name: 'water', expr: 'contains(trigger.output.note, "water")' },
    ],
    ...extra,
});

test('a first-match scalar switch emits NO `branches` key at all (output shape unchanged)', async () => {
    const { output } = await execSwitch(scalarSwitch(), {}, state());
    assert.strictEqual(output.branch, 'case:land');
    assert.strictEqual(output.matched, 'land');
    assert.strictEqual('branches' in output, false,
        'the stored shape must stay byte-for-byte what it was');
});

test("a scalar 'all' switch collects every matching case into output.branches", async () => {
    const { output } = await execSwitch(scalarSwitch({ matchMode: 'all' }), {}, state());
    assert.deepStrictEqual(output.branches, ['case:land', 'case:water']);
    // `branch` (singular) stays the FIRST of them, so replay, recorded run rows
    // and the canvas keep reading exactly what they always read.
    assert.strictEqual(output.branch, 'case:land');
    assert.strictEqual(output.matched, 'land,water');
});

test("a scalar 'all' switch that matches nothing reports an EMPTY branches list", async () => {
    const s = state();
    s.trigger.output.note = 'unrelated';
    const { output } = await execSwitch(scalarSwitch({ matchMode: 'all' }), {}, s);
    assert.deepStrictEqual(output.branches, []);
    assert.strictEqual(output.branch, 'case:default');
    assert.strictEqual(output.matched, null);
});

test("a scalar 'all' switch still honours a defaultBranch redirect", async () => {
    const s = state();
    s.trigger.output.note = 'unrelated';
    const { output } = await execSwitch(scalarSwitch({ matchMode: 'all', defaultBranch: 'water' }), {}, s);
    assert.strictEqual(output.branch, 'case:water');
    assert.strictEqual(output.viaDefault, true);
    assert.deepStrictEqual(output.branches, [], 'nothing MATCHED — the redirect is not a match');
});

test('value cases fan out too, and a broken rule is still a non-fatal non-match', async () => {
    const s = state();
    s.trigger.output.plan = 'Pro';
    const { output } = await execSwitch({
        id: 'sw', type: 'switch', matchMode: 'all', expr: 'trigger.output.plan',
        cases: [
            { name: 'pro', value: 'PRO' },          // loose, case-insensitive
            { name: 'boom', expr: 'x >' },          // half-typed rule
            { name: 'also', value: 'pro' },
        ],
    }, {}, s);
    assert.deepStrictEqual(output.branches, ['case:pro', 'case:also']);
    assert.ok(output._evalError, 'the broken rule is reported, not swallowed');
});

// ── runDag: fan-out routing + the dead-end breadcrumb ──────────────────────

const note = (id) => ({ id, type: 'notification', title: id, body: 'x', channels: ['notification'] });

function makeDispatcher() {
    const ran = [];
    // Keep the switch's own output too: "which steps ran" is a weak assertion
    // for routing, because first-match ALSO leaves every port non-empty on this
    // fixture. The rows a port received are what actually separates the modes.
    const outputs = {};
    const dispatch = async (step, ctx, runState, mode) => {
        if (step.type === 'switch') {
            const r = await execSwitch(step, ctx, runState, mode);
            outputs[step.id] = r.output;
            return { ...r, startedAt: new Date().toISOString() };
        }
        ran.push(step.id);
        return { output: { ranId: step.id }, startedAt: new Date().toISOString(), inputSnapshot: null };
    };
    return { ran, outputs, dispatch };
}

test('a scalar fan-out switch walks EVERY matched port (runDag reuses the collection union)', async () => {
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [scalarSwitch({ matchMode: 'all' }), note('landStep'), note('waterStep'), note('fallback')],
        edges: [
            { from: 'trg', to: 'sw' },
            { from: 'sw', to: 'landStep', label: 'case:land', caseName: 'land' },
            { from: 'sw', to: 'waterStep', label: 'case:water', caseName: 'water' },
            { from: 'sw', to: 'fallback', label: 'case:default', caseName: 'default' },
        ],
    };
    const { ran, dispatch } = makeDispatcher();
    const s = state();
    await runDag(def, {}, s, 'live', dispatch, { recordSteps: false });
    assert.deepStrictEqual([...ran].sort(), ['landStep', 'waterStep']);
    assert.deepStrictEqual(s._templateWarnings, [], 'both matched ports were wired — nothing dead-ended');
});

test('the same graph on a FIRST-match switch still walks exactly one port', async () => {
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [scalarSwitch(), note('landStep'), note('waterStep')],
        edges: [
            { from: 'trg', to: 'sw' },
            { from: 'sw', to: 'landStep', label: 'case:land', caseName: 'land' },
            { from: 'sw', to: 'waterStep', label: 'case:water', caseName: 'water' },
        ],
    };
    const { ran, dispatch } = makeDispatcher();
    await runDag(def, {}, state(), 'live', dispatch, { recordSteps: false });
    assert.deepStrictEqual(ran, ['landStep'], 'no stored router may start fanning out');
});

// Only the SECOND matching port is wired in this pair. That is deliberate: with
// the FIRST one wired, fan-out and first-match behave identically and the test
// proves nothing (it passed against the pre-change engine). Wiring only "water"
// splits them — first-match never reaches it.
const onlyWaterWired = (extra) => ({
    trigger: { id: 'trg', kind: 'manual' },
    steps: [scalarSwitch(extra), note('waterStep')],
    edges: [
        { from: 'trg', to: 'sw' },
        { from: 'sw', to: 'waterStep', label: 'case:water', caseName: 'water' },
    ],
});

test('a fan-out node with ONE wired matched port runs it and does not trip the dead-end breadcrumb', async () => {
    // The earlier wave leaves a `_templateWarnings` entry when a step routes to
    // a port nothing is wired to. "land" and "water" both matched, only "water"
    // is wired: outEdges is non-empty, so the port that IS wired runs and the
    // node must not be reported as a dead end.
    const { ran, dispatch } = makeDispatcher();
    const s = state();
    await runDag(onlyWaterWired({ matchMode: 'all' }), {}, s, 'live', dispatch, { recordSteps: false });
    assert.deepStrictEqual(ran, ['waterStep'],
        'the second matched port is reachable only because every output is asked');
    assert.deepStrictEqual(s._templateWarnings, [],
        `a wired branch is not a dead end, got: ${JSON.stringify(s._templateWarnings)}`);
});

test('the same graph WITHOUT fan-out never reaches that port and does dead-end', async () => {
    // The bracket for the test above: identical wiring, matchMode absent. "land"
    // wins and is unwired, so nothing downstream runs at all. If this ever goes
    // green with waterStep in `ran`, first-match compatibility has been broken.
    const { ran, dispatch } = makeDispatcher();
    const s = state();
    await runDag(onlyWaterWired({}), {}, s, 'live', dispatch, { recordSteps: false });
    assert.deepStrictEqual(ran, [], 'first-match stops at the unwired "land" port');
    assert.ok(s._templateWarnings.some(w => w.code === 'branch_no_edge' && /switch sw routed to .* no edge carries/.test(w.text)),
        `expected a dead-end breadcrumb, got: ${JSON.stringify(s._templateWarnings)}`);
});

test('a fan-out node whose matched ports are ALL unwired still gets the breadcrumb', async () => {
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [scalarSwitch({ matchMode: 'all' }), note('fallback')],
        edges: [
            { from: 'trg', to: 'sw' },
            // Only the default port is wired; land and water both matched and
            // both dead-end. A MATCHED-but-unwired case is a deliberate dead
            // end (no default rescue), so the run must at least say so.
            { from: 'sw', to: 'fallback', label: 'case:default', caseName: 'default' },
        ],
    };
    const { ran, dispatch } = makeDispatcher();
    const s = state();
    await runDag(def, {}, s, 'live', dispatch, { recordSteps: false });
    assert.deepStrictEqual(ran, []);
    assert.ok(s._templateWarnings.some(w => w.code === 'branch_no_edge' && /switch sw routed to .* no edge carries/.test(w.text)),
        `expected a dead-end breadcrumb, got: ${JSON.stringify(s._templateWarnings)}`);
});

test('a collection fan-out switch feeds every matched case its own rows', async () => {
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [listSwitch({ matchMode: 'all' }), note('landStep'), note('waterStep'), note('rejected')],
        edges: [
            { from: 'trg', to: 'sw' },
            { from: 'sw', to: 'landStep', label: 'case:land', caseName: 'land' },
            { from: 'sw', to: 'waterStep', label: 'case:water', caseName: 'water' },
            { from: 'sw', to: 'rejected', label: 'case:default', caseName: 'default' },
        ],
    };
    const { ran, outputs, dispatch } = makeDispatcher();
    await runDag(def, {}, state(), 'live', dispatch, { recordSteps: false });
    assert.deepStrictEqual([...ran].sort(), ['landStep', 'rejected', 'waterStep'],
        'the rejected rows keep their own visible path');
    // The discriminating assertion. Which STEPS ran cannot tell the modes apart
    // here — under first-match land/water/default are all non-empty too, so this
    // test passed against the pre-change engine. Row 3 ("land and water permit")
    // reaching BOTH ports is something first-match cannot produce: there, "land"
    // consumes it and water sees only row 2.
    assert.deepStrictEqual(outputs.sw.matchesByCase.land.map(r => r.id), [1, 3]);
    assert.deepStrictEqual(outputs.sw.matchesByCase.water.map(r => r.id), [2, 3],
        'row 3 is about land AND water and must reach the water port as well');
    assert.deepStrictEqual(outputs.sw.matchesByCase.default.map(r => r.id), [4],
        'only the row that matched nothing is rejected');
});
