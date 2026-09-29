/**
 * Rule-style switch cases + an explicit list source — the runtime half of the
 * unified "Filter & Route" node. A case may carry its own boolean `expr`
 * instead of a `value`, and `arrayRef` makes the whole step work through a
 * list with each row bound as `item`.
 *
 * Run: node --test core/automationRunner/execSwitch.rules.test.js
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

const { execSwitch } = require('./engine');

const ROWS = [
    { id: 1, subject: 'Nextcloud ISV contract', amount: 4200 },
    { id: 2, subject: 'Weekly digest', amount: 12 },
    { id: 3, subject: 'Re: isv renewal', amount: 900 },
];

function state() {
    return {
        trigger: { output: { plan: 'Pro' } },
        steps: { g1: { output: { results: ROWS } } },
        vars: {}, secrets: {}, loop: {}, _templateWarnings: [],
    };
}

test('rule cases decide on their own expression (no step-level expr needed)', async () => {
    const { output } = await execSwitch({
        id: 'sw', type: 'switch',
        cases: [
            { name: 'big', expr: 'steps.g1.output.results[0].amount > 1000' },
            { name: 'small', expr: 'steps.g1.output.results[0].amount <= 1000' },
        ],
    }, {}, state());
    assert.strictEqual(output.branch, 'case:big');
    assert.strictEqual(output.matched, 'big');
});

test('rule and value cases coexist on one step; first match wins', async () => {
    const { output } = await execSwitch({
        id: 'sw', type: 'switch',
        expr: 'trigger.output.plan',
        cases: [
            { name: 'rule', expr: 'trigger.output.plan == "Enterprise"' },
            { name: 'value', value: 'pro' }, // case-insensitive value match
        ],
    }, {}, state());
    assert.strictEqual(output.branch, 'case:value');
});

test('a broken rule counts as "no match" and reports _evalError instead of throwing', async () => {
    const { output } = await execSwitch({
        id: 'sw', type: 'switch',
        cases: [{ name: 'boom', expr: 'item.amount >' }], // half-typed rule
        defaultBranch: null,
    }, {}, state());
    assert.strictEqual(output.branch, 'case:default');
    assert.ok(output._evalError, 'the evaluation failure is surfaced, not swallowed');
});

test('arrayRef puts the step in list mode: rules see each row as `item`', async () => {
    const { output } = await execSwitch({
        id: 'sw', type: 'switch',
        arrayRef: 'steps.g1.output.results',
        cases: [
            { name: 'isv', expr: 'contains(item.subject, "ISV")' },
            { name: 'big', expr: 'item.amount > 100' },
        ],
    }, {}, state());
    assert.strictEqual(output.mode, 'collection');
    // Row 1 and row 3 hit the (case-insensitive) ISV rule; row 2 falls through
    // both rules and lands in the default bucket.
    assert.deepStrictEqual(output.matchesByCase.isv.map(r => r.id), [1, 3]);
    assert.deepStrictEqual(output.matchesByCase.big, []);
    assert.deepStrictEqual(output.matchesByCase.default.map(r => r.id), [2]);
    assert.deepStrictEqual([...output.branches].sort(), ['case:default', 'case:isv']);
    assert.strictEqual(output.total, 3);
});

test('list mode with ONE rule is a filter: only the matching rows continue', async () => {
    const { output } = await execSwitch({
        id: 'sw', type: 'switch',
        arrayRef: 'steps.g1.output.results',
        cases: [{ name: 'keep', expr: 'item.amount > 500' }],
    }, {}, state());
    assert.deepStrictEqual(output.matchesByCase.keep.map(r => r.id), [1, 3]);
    assert.deepStrictEqual(output.counts, { keep: 2, default: 1 });
});

test('an unresolvable source list is SKIPPED, not a green empty success', async () => {
    const res = await execSwitch({
        id: 'sw', type: 'switch',
        arrayRef: 'steps.nope.output.items',
        cases: [{ name: 'keep', expr: 'true' }],
    }, {}, state());
    assert.strictEqual(res.skippedReason, 'arrayref_unresolved');
    assert.strictEqual(res.output.total, 0);
});

test('scalar value matching still ignores case', async () => {
    const { output } = await execSwitch({
        id: 'sw', type: 'switch', expr: 'trigger.output.plan',
        cases: [{ name: 'pro', value: 'PRO' }],
    }, {}, state());
    assert.strictEqual(output.branch, 'case:pro');
});

// ── W4-13: list mode has to EVALUATE the step-level expr ───────────────────
//
// In list mode `values` was just the row array, so a VALUE case compared its
// `value` against the WHOLE row object — `{} == "vip"` is false for every row,
// and a switch built from value cases sent everything to default. The scalar
// path evaluates `expr`; the column path (`…results[*].subject`) reads the
// named field off each row; this is the same idea for the third source shape,
// evaluated in the per-row scope a RULE case already sees.

const TICKETS = [
    { id: 1, prio: 'urgent' },
    { id: 2, prio: 'normal' },
    { id: 3, prio: 'urgent' },
];

function ticketState() {
    return {
        trigger: { output: {} },
        steps: { t: { output: { rows: TICKETS } } },
        vars: {}, secrets: {}, loop: {}, _templateWarnings: [],
    };
}

test('list mode + VALUE cases compare against the step expr, not the whole row', async () => {
    const { output } = await execSwitch({
        id: 'sw', type: 'switch',
        arrayRef: 'steps.t.output.rows',
        expr: 'item.prio',
        cases: [{ name: 'hot', value: 'urgent' }, { name: 'cold', value: 'normal' }],
    }, {}, ticketState());

    assert.deepStrictEqual(output.matchesByCase.hot.map(r => r.id), [1, 3]);
    assert.deepStrictEqual(output.matchesByCase.cold.map(r => r.id), [2]);
    assert.strictEqual(output.matchesByCase.default, undefined, 'nothing falls through any more');
});

test('list mode with no expr still matches scalar rows by value (unchanged)', async () => {
    const state = ticketState();
    state.steps.t.output.words = ['alpha', 'beta'];
    const { output } = await execSwitch({
        id: 'sw', type: 'switch',
        arrayRef: 'steps.t.output.words',
        cases: [{ name: 'a', value: 'alpha' }],
    }, {}, state);
    assert.deepStrictEqual(output.matchesByCase.a, ['alpha']);
    assert.deepStrictEqual(output.matchesByCase.default, ['beta']);
});

test('an expr that addresses nothing on the row falls back to the row itself', async () => {
    const state = ticketState();
    state.steps.t.output.words = ['alpha', 'beta'];
    const { output } = await execSwitch({
        id: 'sw', type: 'switch',
        arrayRef: 'steps.t.output.words',
        expr: 'item.nope',              // resolves to undefined for every row
        cases: [{ name: 'a', value: 'alpha' }],
    }, {}, state);
    assert.deepStrictEqual(output.matchesByCase.a, ['alpha'], 'back-compat: the row is still the cell');
});

test('rule cases keep deciding on their own even when a step expr exists', async () => {
    const { output } = await execSwitch({
        id: 'sw', type: 'switch',
        arrayRef: 'steps.t.output.rows',
        expr: 'item.prio',
        cases: [{ name: 'byRule', expr: 'item.id > 2' }],
    }, {}, ticketState());
    assert.deepStrictEqual(output.matchesByCase.byRule.map(r => r.id), [3]);
});

test('a defaultBranch redirect in LIST mode is marked viaDefault', async () => {
    const { output } = await execSwitch({
        id: 'sw', type: 'switch',
        arrayRef: 'steps.t.output.rows',
        expr: 'item.prio',
        cases: [{ name: 'hot', value: 'urgent' }, { name: 'cold', value: 'nothing-matches-this' }],
        defaultBranch: 'cold',
    }, {}, ticketState());
    assert.deepStrictEqual(output.matchesByCase.cold.map(r => r.id), [2], 'unmatched rows went to the named case');
    assert.strictEqual(output.viaDefault, true,
        'runDag needs the marker to rescue those rows when "cold" turns out to have no edge');
});

test('no redirect means no viaDefault marker', async () => {
    const { output } = await execSwitch({
        id: 'sw', type: 'switch',
        arrayRef: 'steps.t.output.rows',
        expr: 'item.prio',
        cases: [{ name: 'hot', value: 'urgent' }],
    }, {}, ticketState());
    assert.strictEqual(output.viaDefault, undefined);
});
