/**
 * An approval routes on its decision (D4a): `approved: false` follows only
 * the 'on_rejected' edge, anything else only the plain (unlabelled /
 * on_success) edges and never 'on_rejected'. The live dispatch and the
 * replay of a resume use the same rule (automationModel/edgeLabels.mts approvalRouteLabel), so
 * a resumed run takes the edge the decision chose.
 *
 * The approval itself is not run here: the dispatcher hands back its output
 * live, and the replay cases inject it the way resume.js does.
 *
 * Run: node --test core/automationRunner/runDag.approvalBranch.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

// The real modules over a recording pool, so nothing opens a connection.
require('../../testUtils/routeHarness').recordDb();

const { runDag } = require('../automationRunner');
const { approvalRouteLabel } = require('../automationModel/edgeLabels.mts');
const { approvalOutput } = require('../automationModel/approvalOutput.mts');

const note = (id) => ({ id, type: 'notification', title: id, body: 'x', channels: ['notification'] });

/** trigger → ap → yes (plain) [+ no (on_rejected)] [+ also (on_success)]. */
function def({ rejected = true, onSuccess = false } = {}) {
    const edges = [{ from: 'trg', to: 'ap' }, { from: 'ap', to: 'yes' }];
    if (rejected) edges.push({ from: 'ap', to: 'no', label: 'on_rejected' });
    if (onSuccess) edges.push({ from: 'ap', to: 'also', label: 'on_success' });
    return {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [{ id: 'ap', type: 'approval', prompt: 'Ok?' }, note('yes'), note('no'), note('also')],
        edges,
    };
}

function baseState() {
    return { trigger: { output: {} }, steps: {}, vars: {}, secrets: {}, loop: {}, _templateWarnings: [] };
}

/** Live: the dispatcher answers the approval with `decision`. */
async function runLive(definition, decision) {
    const ran = [];
    const state = baseState();
    const dispatch = async (step) => {
        ran.push(step.id);
        return { output: step.type === 'approval' ? decision : { ranId: step.id }, startedAt: new Date().toISOString() };
    };
    await runDag(definition, {}, state, 'live', dispatch, { recordSteps: false });
    return { ran: ran.filter(id => id !== 'ap'), warnings: state._templateWarnings };
}

/** Replay: the decision is injected as the boundary's output, as resume.js does. */
async function runReplay(definition, decision) {
    const ran = [];
    const state = baseState();
    state.steps.ap = { output: decision, status: 'success' };
    const dispatch = async (step) => {
        ran.push(step.id);
        return { output: { ranId: step.id }, startedAt: new Date().toISOString() };
    };
    await runDag(definition, {}, state, 'live', dispatch, { recordSteps: false, skipUntilStepId: 'ap' });
    assert.ok(!ran.includes('ap'), 'the boundary step is replayed, never dispatched');
    return { ran, warnings: state._templateWarnings };
}

const approve = approvalOutput({ approved: true, by: 'u1', decidedAt: '2026-11-03T10:00:00Z' });
const reject = approvalOutput({ approved: false, by: 'u1', reason: 'No', decidedAt: '2026-11-03T10:00:00Z' });

test('the routing rule: approval only, and only approved === false', () => {
    assert.strictEqual(approvalRouteLabel({ type: 'approval' }, reject), 'on_rejected');
    assert.strictEqual(approvalRouteLabel({ type: 'approval' }, approve), null);
    // A pinned or synthesised output without an explicit false is an approve.
    assert.strictEqual(approvalRouteLabel({ type: 'approval' }, { approved: undefined }), null);
    assert.strictEqual(approvalRouteLabel({ type: 'approval' }, null), null);
    assert.strictEqual(approvalRouteLabel({ type: 'approval' }, { approved: 'false' }), null);
    // Another step type with the same key routes as before.
    assert.strictEqual(approvalRouteLabel({ type: 'form_page' }, { approved: false }), null);
    assert.strictEqual(approvalRouteLabel({ type: 'set' }, { approved: false }), null);
});

for (const [name, run] of [['live', runLive], ['replay', runReplay]]) {
    test(`${name}: an approve follows the plain edges and never on_rejected`, async () => {
        const { ran } = await run(def({ onSuccess: true }), approve);
        assert.deepStrictEqual(ran.sort(), ['also', 'yes']);
    });

    test(`${name}: a reject follows only on_rejected`, async () => {
        const { ran, warnings } = await run(def({ onSuccess: true }), reject);
        assert.deepStrictEqual(ran, ['no']);
        assert.deepStrictEqual(warnings, []);
    });

    test(`${name}: a reject with no rejected branch runs nothing after the approval, and says so`, async () => {
        const { ran, warnings } = await run(def({ rejected: false }), reject);
        assert.deepStrictEqual(ran, []);
        assert.ok(warnings.some(w => w.includes('approval ap') && w.includes('on_rejected')), `warnings: ${warnings.join(' | ')}`);
    });

    // Parity: a flow without the new label routes exactly as it always did.
    test(`${name}: plain-edge flow, approve → the plain edge, as before`, async () => {
        const { ran, warnings } = await run(def({ rejected: false }), approve);
        assert.deepStrictEqual(ran, ['yes']);
        assert.deepStrictEqual(warnings, []);
    });
}

test('live and replay take the same edge for the same decision', async () => {
    for (const decision of [approve, reject, { approved: true }, { approved: false }]) {
        const live = await runLive(def({ onSuccess: true }), decision);
        const replay = await runReplay(def({ onSuccess: true }), decision);
        assert.deepStrictEqual(live.ran.sort(), replay.ran.sort(), `decision ${JSON.stringify(decision)}`);
    }
});
