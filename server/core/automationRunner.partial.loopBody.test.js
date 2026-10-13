/**
 * Regression test for runPartial() when the targeted step lives inside a LOOP
 * BODY (`loop.body[]`) rather than the root graph.
 *
 * The canvas draws a loop's body inside the container and gives those nodes the
 * runtime's namespaced id ('lp1/B1' — flow/inlineFlowlets.js), which is what the
 * ▶ / Execute button posts. runPartial only searched def.trigger, def.steps and
 * the layers map, so every attempt to run one answered
 *   `runPartial: step lp1/B1 not found in definition`.
 * Now the body is run as its own linear DAG with the first iteration rebuilt
 * around it, and the row is recorded under the id the canvas asked for.
 *
 * Pure in-process `set` steps (binding resolution only) keep this deterministic
 * — no LLM / tool / sandbox / DB.
 *
 * Run: node --test core/automationRunner.partial.loopBody.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { installPartialRunHarness } = require('./automationRunner.partial.testkit');

const { runner, storeStub, reset } = installPartialRunHarness();

/**
 * Root: trigger → src (pinned list) → lp1 (loop over that list).
 * Body: B1 reads the current item, B2 reads B1.
 */
function automationWithLoop(rows = [{ name: 'first' }, { name: 'second' }]) {
    return {
        id: 'auto-1',
        version: 1,
        userId: 'user-1',
        organizationId: null,
        title: 'Loop body partial run',
        triggerType: 'manual',
        definition: {
            trigger: { id: 'trig', type: 'trigger', kind: 'manual' },
            steps: [
                { id: 'src', type: 'set', fields: {}, pinnedOutput: { rows } },
                {
                    id: 'lp1', type: 'loop', itemVar: 'row', maxIterations: 100,
                    overRef: 'steps.src.output.rows',
                    body: [
                        { id: 'B1', type: 'set', fields: { seen: { kind: 'ref', path: 'loop.row.name' } } },
                        { id: 'B2', type: 'set', fields: { echoed: { kind: 'ref', path: 'steps.B1.output.seen' } } },
                    ],
                },
            ],
            edges: [{ from: 'trig', to: 'src' }, { from: 'src', to: 'lp1' }],
        },
    };
}


test('runPartial(only) on a step inside a loop body executes it for the first item', async () => {
    reset();
    const result = await runner.runPartial(automationWithLoop(), 'lp1/B1', { mode: 'only' });

    assert.ok(result, 'returns a finished run row');
    assert.strictEqual(result.status, 'success', `run status (got ${result.status}, error: ${result.error})`);

    const steps = await storeStub.getRunSteps(result.id);
    const b1 = steps.find(s => s.stepId === 'lp1/B1');
    assert.ok(b1, 'recorded under the namespaced id the canvas addressed it by');
    assert.strictEqual(b1.parentStepId, 'lp1', 'and nested under the loop container');
    assert.deepStrictEqual(b1.output, { seen: 'first' }, 'the loop item was seeded from the first element');
});

test('a second Execute in the same body replays what the first one recorded', async () => {
    reset();
    const automation = automationWithLoop();
    const first = await runner.runPartial(automation, 'lp1/B1', { mode: 'only' });
    assert.strictEqual(first.status, 'success', `first run status (got ${first.status}, error: ${first.error})`);

    const second = await runner.runPartial(automation, 'lp1/B2', { mode: 'only' });
    assert.strictEqual(second.status, 'success', `second run status (got ${second.status}, error: ${second.error})`);

    const byId = new Map((await storeStub.getRunSteps(second.id)).map(s => [s.stepId, s]));
    assert.deepStrictEqual(byId.get('lp1/B2')?.output, { echoed: 'first' },
        'B2 resolved against B1\'s recorded output');
    assert.ok(!byId.has('lp1/B1'), 'B1 was replayed, not re-executed');
});

test('the canvas ▶ (mode "upTo") runs the body up to the target', async () => {
    reset();
    const result = await runner.runPartial(automationWithLoop(), 'lp1/B2', { mode: 'upTo' });
    assert.strictEqual(result.status, 'success', `run status (got ${result.status}, error: ${result.error})`);

    const byId = new Map((await storeStub.getRunSteps(result.id)).map(s => [s.stepId, s]));
    assert.strictEqual(byId.get('lp1/B1')?.status, 'success', 'the body step before the target actually ran');
    assert.deepStrictEqual(byId.get('lp1/B2')?.output, { echoed: 'first' }, 'the target ran on fresh data');
});

test('mode "from" runs the target and the rest of the body', async () => {
    reset();
    const result = await runner.runPartial(automationWithLoop(), 'lp1/B1', { mode: 'from' });
    assert.strictEqual(result.status, 'success', `run status (got ${result.status}, error: ${result.error})`);

    const byId = new Map((await storeStub.getRunSteps(result.id)).map(s => [s.stepId, s]));
    assert.deepStrictEqual(byId.get('lp1/B1')?.output, { seen: 'first' }, 'target ran');
    assert.deepStrictEqual(byId.get('lp1/B2')?.output, { echoed: 'first' }, 'and everything after it in the body');
});

test('an empty source list explains what is missing instead of failing on the binding', async () => {
    reset();
    await assert.rejects(
        () => runner.runPartial(automationWithLoop([]), 'lp1/B1', { mode: 'only' }),
        /no items yet.*steps\.src\.output\.rows/is,
    );
});

test('a body step that does not use the item still runs with no items', async () => {
    reset();
    const automation = automationWithLoop([]);
    automation.definition.steps[1].body = [
        { id: 'B1', type: 'set', fields: { fixed: { kind: 'literal', value: 'no-item-needed' } } },
    ];
    const result = await runner.runPartial(automation, 'lp1/B1', { mode: 'only' });
    assert.strictEqual(result.status, 'success', `run status (got ${result.status}, error: ${result.error})`);
});

test('nested loops resolve the item chain outermost-first', async () => {
    reset();
    const automation = automationWithLoop([{ name: 'first', tags: [{ label: 'inner-a' }] }]);
    automation.definition.steps[1].body = [
        {
            id: 'lp2', type: 'loop', itemVar: 'tag', maxIterations: 100,
            overRef: 'loop.row.tags',
            body: [{ id: 'C1', type: 'set', fields: { got: { kind: 'ref', path: 'loop.tag.label' } } }],
        },
    ];
    const result = await runner.runPartial(automation, 'lp1/lp2/C1', { mode: 'only' });
    assert.strictEqual(result.status, 'success', `run status (got ${result.status}, error: ${result.error})`);

    const c1 = (await storeStub.getRunSteps(result.id)).find(s => s.stepId === 'lp1/lp2/C1');
    assert.ok(c1, 'recorded under the full namespaced id');
    assert.deepStrictEqual(c1.output, { got: 'inner-a' }, 'the inner item came from the outer item');
});

test('runPartial still throws for a genuinely unknown namespaced id', async () => {
    reset();
    await assert.rejects(
        () => runner.runPartial(automationWithLoop(), 'lp1/nope', { mode: 'only' }),
        /not found in definition/i,
    );
});
