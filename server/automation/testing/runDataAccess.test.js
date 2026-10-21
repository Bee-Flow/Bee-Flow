'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { makeRunDataAccess } = require('./runDataAccess');

const ME = 'me';

function fakeRes() {
    const res = { statusCode: null, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
}
const reqOf = (userId = ME) => ({ session: { user: { id: userId } } });

/** Runs by id; a journey is the runs sharing a root. */
function setup({ runs, role = 'view', runGuard, managedInfo } = {}) {
    const byId = new Map(runs.map((r) => [r.id, r]));
    const store = {
        getRun: async (id) => byId.get(id) || null,
        getAutomation: async (id) => ({ id, userId: 'owner' }),
        getRunsInChain: async (id) => {
            const run = byId.get(id);
            const root = run.rootRunId || run.id;
            return runs.filter((r) => (r.rootRunId || r.id) === root);
        },
        getLatestRunInChain: async (id) => {
            const run = byId.get(id);
            const root = run.rootRunId || run.id;
            return runs.filter((r) => (r.rootRunId || r.id) === root).at(-1);
        },
    };
    const access = {
        roleFor: async () => ({ role }),
        runGuard: runGuard || (async () => ({ role })),
    };
    return makeRunDataAccess({ store, access, managedInfo });
}

const run = (id, extra = {}) => ({ id, automationId: 'a1', userId: 'owner', status: 'success', parentRunId: null, rootRunId: null, ...extra });

test('a missing run is a 404', async () => {
    const d = setup({ runs: [run('r1')] });
    await assert.rejects(() => d.readableRun(reqOf(), fakeRes(), 'nope'), (e) => e.status === 404 && e.code === 'run_not_found');
});

test('a caller with no role on the automation gets 404, as if the run did not exist', async () => {
    const d = setup({ runs: [run('r1')], role: null });
    await assert.rejects(() => d.readableRun(reqOf(), fakeRes(), 'r1'), (e) => e.status === 404 && e.code === 'run_not_found');
});

test('the run starter needs no role lookup', async () => {
    const d = setup({ runs: [run('r1', { userId: ME })], role: null });
    const found = await d.readableRun(reqOf(), fakeRes(), 'r1');
    assert.strictEqual(found.run.id, 'r1');
});

test('a refusal by the run guard ends the call with null (it answered)', async () => {
    const res = fakeRes();
    const d = setup({ runs: [run('r1')], runGuard: async (_req, r) => { r.status(403).json({ error: 'Forbidden' }); return null; } });
    assert.strictEqual(await d.readableRun(reqOf(), res, 'r1'), null);
    assert.strictEqual(res.statusCode, 403);
});

test('a run on the starter\'s own connections is 403 for anybody else', async () => {
    const d = setup({ runs: [run('r1', { connectionsMode: 'caller', startedByUserId: 'someone' })] });
    await assert.rejects(() => d.readableRun(reqOf(), fakeRes(), 'r1'), (e) => e.status === 403 && e.code === 'caller_run_private');
});

test('the journey: root, legs of this automation the caller may read, and their ids', async () => {
    const runs = [
        run('r1'),
        run('r2', { parentRunId: 'r1', rootRunId: 'r1' }),
        run('r3', { parentRunId: 'r2', rootRunId: 'r1', connectionsMode: 'caller', startedByUserId: 'someone' }),
        run('r4', { parentRunId: 'r2', rootRunId: 'r1', automationId: 'other' }),
    ];
    const d = setup({ runs });
    const found = await d.readableRun(reqOf(), fakeRes(), 'r2');
    assert.strictEqual(found.run.id, 'r2');
    assert.strictEqual(found.root.id, 'r1');
    assert.deepStrictEqual(found.runIds, ['r1', 'r2'], 'another person\'s caller leg and another automation\'s leg are left out');
    assert.deepStrictEqual(found.legs.map((l) => l.id), ['r1', 'r2']);
});

test('assertCapturable refuses a caller-mode leg', async () => {
    const d = setup({ runs: [run('r1', { connectionsMode: 'caller', startedByUserId: ME })] });
    const found = await d.readableRun(reqOf(), fakeRes(), 'r1');
    await assert.rejects(() => d.assertCapturable(found.run, found.legs), (e) => e.status === 409 && e.code === 'caller_run_not_capturable');
});

test('assertCapturable refuses a journey whose latest leg has not finished', async () => {
    const d = setup({ runs: [run('r1', { status: 'success' }), run('r2', { parentRunId: 'r1', rootRunId: 'r1', status: 'awaiting_form' })] });
    const found = await d.readableRun(reqOf(), fakeRes(), 'r1');
    await assert.rejects(() => d.assertCapturable(found.run, found.legs), (e) => e.status === 409 && e.code === 'run_not_finished');
});

test('assertCapturable accepts success, error and cancelled', async () => {
    for (const status of ['success', 'error', 'cancelled']) {
        const d = setup({ runs: [run('r1', { status })] });
        const found = await d.readableRun(reqOf(), fakeRes(), 'r1');
        await d.assertCapturable(found.run, found.legs);
    }
});

test('assertTestDataAllowed refuses a PRD stage, allows others, refuses on a failing lookup', async () => {
    const stageOf = (stage) => setup({ runs: [run('r1')], managedInfo: async () => (stage ? { stage } : null) });
    await assert.rejects(() => stageOf('prd').assertTestDataAllowed({ projectId: 'p' }), (e) => e.status === 409 && e.code === 'test_data_not_on_prd');
    await stageOf('uat').assertTestDataAllowed({ projectId: 'p' });
    await stageOf(null).assertTestDataAllowed({ projectId: 'p' });
    await stageOf(null).assertTestDataAllowed({ projectId: null });
    const failing = setup({ runs: [run('r1')], managedInfo: async () => { throw new Error('db down'); } });
    await assert.rejects(() => failing.assertTestDataAllowed({ projectId: 'p' }), (e) => e.code === 'test_data_not_on_prd');
});
