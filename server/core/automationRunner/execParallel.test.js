/**
 * Parallel branches actually EXECUTE their steps — W4-9 / W4-10.
 *
 * execParallel builds each branch as a throwaway sub-DAG: the branch's step
 * array plus edges synthesized by buildLinearEdges, rooted at a made-up trigger
 * id. The two ids have to agree, and they did not: the sub-definition said
 * `trigger.id = '__parallel_root__'` while buildLinearEdges hardcoded
 * '__loop_root__' as the source of its first edge. Nothing was reachable from
 * the root, the queue drained on the first turn, and EVERY branch reported
 * `{status: 'success', output: null}` — a parallel node that executed zero
 * steps while the run finished green. There was no runtime test for
 * execParallel at all, which is how it stayed that way.
 *
 * The second half is the same class of bug one level down: buildLinearEdges was
 * brancher-aware for `condition` and `switch` but not `guard`, even though
 * runDag routes a guard identically and execGuard ALWAYS answers 'then'/'else'.
 * So a guard inside a loop body or a parallel branch dead-ended every step
 * after it.
 *
 * Run: node --test core/automationRunner/execParallel.test.js
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

const { execParallel, buildLinearEdges, LOOP_ROOT_ID, PARALLEL_ROOT_ID } = require('./engine');

function state() {
    return { trigger: { output: {} }, steps: {}, vars: {}, secrets: {}, loop: {}, _templateWarnings: [] };
}

/** Records every step id it is asked to run; branchers answer their label. */
function makeDispatcher(branchAnswers = {}) {
    const ran = [];
    const dispatch = async (step) => {
        ran.push(step.id);
        const branch = branchAnswers[step.id];
        return {
            output: branch ? { branch, ranId: step.id } : { ranId: step.id },
            startedAt: new Date().toISOString(),
            inputSnapshot: null,
        };
    };
    return { ran, dispatch };
}

const note = (id) => ({ id, type: 'notification', title: id, body: 'x', channels: ['notification'] });

test('every branch dispatches its steps (they used to all run empty and report success)', async () => {
    const { ran, dispatch } = makeDispatcher();
    const step = {
        id: 'par', type: 'parallel',
        branches: [[note('b0s1'), note('b0s2')], [note('b1s1')]],
    };
    const { output } = await execParallel(step, {}, state(), 'live', dispatch);

    // Sorted: branches run concurrently, so the interleaving is not the contract.
    assert.deepStrictEqual([...ran].sort(), ['b0s1', 'b0s2', 'b1s1'], 'all branch steps ran');
    assert.strictEqual(output.branches.length, 2);
    assert.deepStrictEqual(output.branches.map(b => b.status), ['success', 'success']);
    assert.deepStrictEqual(output.branches[0].output, { ranId: 'b0s2' }, 'branch 0 reports its LAST step, not null');
    assert.deepStrictEqual(output.branches[1].output, { ranId: 'b1s1' });
});

test('an empty branch list is still a no-op success', async () => {
    const { ran, dispatch } = makeDispatcher();
    const { output } = await execParallel({ id: 'par', type: 'parallel', branches: [] }, {}, state(), 'live', dispatch);
    assert.deepStrictEqual(output.branches, []);
    assert.deepStrictEqual(ran, []);
});

test('a failing branch is reported per-branch, and failOnAnyBranchError still throws', async () => {
    const boom = async (step) => {
        if (step.id === 'bad') throw new Error('branch blew up');
        return { output: { ranId: step.id }, startedAt: new Date().toISOString() };
    };
    const step = { id: 'par', type: 'parallel', branches: [[note('ok1')], [note('bad')]] };
    const { output } = await execParallel(step, {}, state(), 'live', boom);
    assert.strictEqual(output.branches[0].status, 'success');
    assert.strictEqual(output.branches[1].status, 'error');
    assert.match(output.branches[1].error, /branch blew up/);

    await assert.rejects(
        () => execParallel({ ...step, failOnAnyBranchError: true }, {}, state(), 'live', boom),
        /Parallel branch 1 failed/,
    );
});

// ── W4-10: guard is a brancher everywhere, not in two places out of three ──

test('buildLinearEdges continues a body past a GUARD on its "then" port', () => {
    const edges = buildLinearEdges([
        { id: 'g', type: 'guard' },
        { id: 'after', type: 'notification' },
    ]);
    assert.deepStrictEqual(edges, [
        { from: LOOP_ROOT_ID, to: 'g' },
        { from: 'g', to: 'after', label: 'then' },
    ]);
});

test('a guard inside a parallel branch does not dead-end the rest of the branch', async () => {
    const { ran, dispatch } = makeDispatcher({ g: 'then' });
    const step = {
        id: 'par', type: 'parallel',
        branches: [[{ id: 'g', type: 'guard' }, note('afterGuard')]],
    };
    await execParallel(step, {}, state(), 'live', dispatch);
    assert.deepStrictEqual(ran, ['g', 'afterGuard'],
        'the step after the guard ran — an unlabelled edge could never match "then"');
});

test('a guard answering "else" ends its branch, same contract as a condition', async () => {
    const { ran, dispatch } = makeDispatcher({ g: 'else' });
    const step = {
        id: 'par', type: 'parallel',
        branches: [[{ id: 'g', type: 'guard' }, note('afterGuard')]],
    };
    await execParallel(step, {}, state(), 'live', dispatch);
    assert.deepStrictEqual(ran, ['g'], '"else" is the exit port in a linear body');
});

test('buildLinearEdges roots the chain at the id its caller will use', () => {
    const steps = [{ id: 'first', type: 'notification' }];
    assert.strictEqual(buildLinearEdges(steps)[0].from, LOOP_ROOT_ID, 'loop bodies keep the historic default');
    assert.strictEqual(buildLinearEdges(steps, PARALLEL_ROOT_ID)[0].from, PARALLEL_ROOT_ID);
});
