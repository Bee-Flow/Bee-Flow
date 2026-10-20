/**
 * Test data of Automations against a real Postgres (@electric-sql/pglite):
 * fixtures and test cases, golden runs and form scenarios. The store is built
 * with makeAutomationTestingStore over the PGlite handle: no module mocking.
 *
 * Proven:
 *   - the DDL runs twice without complaint (boot runs it on every start);
 *   - CRUD for all three areas, and that a case row never carries fixture values;
 *   - deleting a run removes its fixture, the case stays and reads as unavailable;
 *   - deleting a run removes its golden and scenarios, a replay run is nulled;
 *   - deleting the automation cascades everything;
 *   - a duplicate scenario name answers 409 scenario_name_taken;
 *   - a golden is an upsert on its run.
 *
 * Run: cd server && node --test stores/automationTestingStore.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pgliteDb } = require('../testUtils/pgliteDb');
const { makeAutomationTestingStore, DDL } = require('./automationTestingStore');

const { pg, db } = pgliteDb();
const store = makeAutomationTestingStore(db);

const SECRET = 'fixture-value-zq81';

before(async () => {
    await pg.exec(`
        CREATE TABLE automations (id TEXT PRIMARY KEY);
        CREATE TABLE automation_runs (
            id TEXT PRIMARY KEY,
            automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE
        );
    `);
    await pg.exec(DDL);
    await pg.exec(DDL);
    for (const a of ['a1', 'a2']) await pg.query('INSERT INTO automations (id) VALUES ($1)', [a]);
    for (const [r, a] of [['r1', 'a1'], ['r2', 'a1'], ['r3', 'a1'], ['r4', 'a2']]) {
        await pg.query('INSERT INTO automation_runs (id, automation_id) VALUES ($1, $2)', [r, a]);
    }
});

after(async () => { await pg.close(); });

const count = async (table) => Number((await pg.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n);

test('typed test case: create, read, update, list, count, record result, delete', async () => {
    const created = await store.createTestCase({
        automationId: 'a1', stepId: 's1', name: 'typed', inputKind: 'typed', typedInput: { n: 2 },
        expect: 'success', assertions: [{ id: 'x', op: 'equals', path: '', value: 4 }], createdBy: 'u1',
    });
    assert.match(created.id, /^tc_[0-9a-f]{32}$/);
    assert.deepStrictEqual(created.input, { kind: 'typed', values: { n: 2 } });
    assert.strictEqual(created.expect, 'success');
    assert.strictEqual(created.lastStatus, null);
    assert.strictEqual(created.assertions[0].op, 'equals');

    assert.strictEqual(await store.countTestCases('a1', 's1'), 1);
    assert.strictEqual(await store.countTestCases('a1', 's2'), 0);
    assert.strictEqual((await store.listTestCases('a1', 's1')).length, 1);
    assert.strictEqual((await store.listTestCases('a1', 's2')).length, 0);
    assert.strictEqual((await store.listTestCases('a2')).length, 0);
    assert.strictEqual(await store.getTestCase('a2', created.id), null, 'scoped to its automation');

    const updated = await store.updateTestCase('a1', created.id, { name: 'renamed', expect: 'error', assertions: [] });
    assert.strictEqual(updated.name, 'renamed');
    assert.strictEqual(updated.expect, 'error');
    assert.deepStrictEqual(updated.assertions, []);
    assert.strictEqual(await store.updateTestCase('a2', created.id, { name: 'x' }), null);

    await store.recordTestCaseResult('a1', created.id, { status: 'pass' });
    const after1 = await store.getTestCase('a1', created.id);
    assert.strictEqual(after1.lastStatus, 'pass');
    assert.ok(after1.lastRunAt);

    assert.deepStrictEqual(await store.getTestCaseInput('a1', created.id), { kind: 'typed', values: { n: 2 } });
    assert.strictEqual(await store.getTestCaseInput('a1', 'tc_none'), null);

    assert.strictEqual(await store.deleteTestCase('a2', created.id), false);
    assert.strictEqual(await store.deleteTestCase('a1', created.id), true);
    assert.strictEqual(await store.getTestCase('a1', created.id), null);
});

test('run test case: values only through getTestCaseInput, never in a row', async () => {
    const fx = await store.createFixture({ automationId: 'a1', runId: 'r1', stepId: 's1', input: { secret: SECRET } });
    assert.match(fx.id, /^tfx_[0-9a-f]{32}$/);
    const c = await store.createTestCase({
        automationId: 'a1', stepId: 's1', name: 'from run', inputKind: 'run', fixtureId: fx.id, expect: 'success', assertions: [],
    });
    assert.deepStrictEqual(c.input, { kind: 'run', fixtureId: fx.id, runId: 'r1', available: true });
    assert.ok(!JSON.stringify(c).includes(SECRET));
    assert.ok(!JSON.stringify(await store.listTestCases('a1')).includes(SECRET));
    assert.deepStrictEqual(await store.getTestCaseInput('a1', c.id),
        { kind: 'run', available: true, values: { secret: SECRET }, runId: 'r1', fixtureId: fx.id });
    await store.deleteTestCase('a1', c.id);
});

test('replacing a run input drops the old fixture; switching to typed drops it too', async () => {
    const f1 = await store.createFixture({ automationId: 'a1', runId: 'r1', stepId: 's1', input: { v: 1 } });
    const c = await store.createTestCase({ automationId: 'a1', stepId: 's1', name: 'swap', inputKind: 'run', fixtureId: f1.id });
    const f2 = await store.createFixture({ automationId: 'a1', runId: 'r2', stepId: 's1', input: { v: 2 } });
    const swapped = await store.updateTestCase('a1', c.id, { inputKind: 'run', fixtureId: f2.id });
    assert.strictEqual(swapped.input.fixtureId, f2.id);
    assert.strictEqual(swapped.input.runId, 'r2');
    assert.strictEqual(Number((await pg.query('SELECT COUNT(*)::int AS n FROM automation_test_fixtures WHERE id = $1', [f1.id])).rows[0].n), 0);

    const typed = await store.updateTestCase('a1', c.id, { inputKind: 'typed', typedInput: { v: 3 } });
    assert.deepStrictEqual(typed.input, { kind: 'typed', values: { v: 3 } });
    assert.strictEqual(await count('automation_test_fixtures'), 0);
    await store.deleteTestCase('a1', c.id);
});

test('deleting a case deletes its fixture', async () => {
    const f = await store.createFixture({ automationId: 'a1', runId: 'r1', stepId: 's1', input: { v: 1 } });
    const c = await store.createTestCase({ automationId: 'a1', stepId: 's1', name: 'gone', inputKind: 'run', fixtureId: f.id });
    await store.deleteTestCase('a1', c.id);
    assert.strictEqual(await count('automation_test_fixtures'), 0);
});

test('deleting the run removes the fixture; the case stays, unavailable', async () => {
    await pg.query('INSERT INTO automation_runs (id, automation_id) VALUES ($1, $2)', ['r-exp', 'a1']);
    const f = await store.createFixture({ automationId: 'a1', runId: 'r-exp', stepId: 's1', input: { v: 1 } });
    const c = await store.createTestCase({ automationId: 'a1', stepId: 's1', name: 'expires', inputKind: 'run', fixtureId: f.id });
    await pg.query('DELETE FROM automation_runs WHERE id = $1', ['r-exp']);
    assert.strictEqual(await count('automation_test_fixtures'), 0);
    const row = await store.getTestCase('a1', c.id);
    assert.deepStrictEqual(row.input, { kind: 'run', fixtureId: null, runId: null, available: false });
    assert.deepStrictEqual(await store.getTestCaseInput('a1', c.id), { kind: 'run', available: false });
    await store.deleteTestCase('a1', c.id);
});

test('goldens: create, upsert on run, read, list, replay verdict, delete', async () => {
    const g = await store.createGolden({ automationId: 'a1', runId: 'r1', label: 'first', ignorePaths: ['a.b'], createdBy: 'u1' });
    assert.match(g.id, /^gold_[0-9a-f]{32}$/);
    assert.deepStrictEqual({ label: g.label, ignorePaths: g.ignorePaths, lastReplay: g.lastReplay }, { label: 'first', ignorePaths: ['a.b'], lastReplay: null });

    const again = await store.createGolden({ automationId: 'a1', runId: 'r1', label: 'second', ignorePaths: [], createdBy: 'u2' });
    assert.strictEqual(again.id, g.id, 'one golden per run');
    assert.strictEqual(again.label, 'second');
    assert.deepStrictEqual(again.ignorePaths, []);
    assert.strictEqual(await store.countGoldens('a1'), 1);

    await store.setGoldenReplay(g.id, { status: 'changed', summary: { changed: 2 }, replayRunId: 'r2', errorCode: null });
    const got = await store.getGolden('a1', g.id);
    assert.deepStrictEqual({ ...got.lastReplay, at: typeof got.lastReplay.at }, {
        status: 'changed', summary: { changed: 2 }, errorCode: null, replayRunId: 'r2', at: 'string',
    });
    assert.strictEqual(await store.getGolden('a2', g.id), null);
    assert.strictEqual((await store.getGoldenByRun('r1')).id, g.id);
    assert.strictEqual((await store.listGoldens('a1')).length, 1);

    assert.strictEqual(await store.deleteGoldenByRun('r1'), true);
    assert.strictEqual(await store.deleteGoldenByRun('r1'), false);
});

test('deleting a run deletes its golden and scenarios and nulls a replay pointer', async () => {
    await pg.query('INSERT INTO automation_runs (id, automation_id) VALUES ($1, $2), ($3, $2)', ['r-g', 'a1', 'r-replay']);
    const g = await store.createGolden({ automationId: 'a1', runId: 'r-g', label: null, ignorePaths: [] });
    await store.setGoldenReplay(g.id, { status: 'same', replayRunId: 'r-replay' });
    const s = await store.createFormScenario({
        automationId: 'a1', sourceRunId: 'r-g', name: 'on r-g', answers: { v: 1, trigger: null, pages: {}, skipped: [] },
    });
    // The replay run goes first: the golden stays, its pointer is nulled.
    await pg.query('DELETE FROM automation_runs WHERE id = $1', ['r-replay']);
    const kept = await store.getGolden('a1', g.id);
    assert.strictEqual(kept.lastReplay.replayRunId, null);
    assert.strictEqual(kept.lastReplay.status, 'same');
    // The source run goes: golden and scenario go with it.
    await pg.query('DELETE FROM automation_runs WHERE id = $1', ['r-g']);
    assert.strictEqual(await store.getGolden('a1', g.id), null);
    assert.strictEqual(await store.getFormScenario('a1', s.id), null);
});

test('form scenarios: summary without answers, answers on get, rename, duplicate name, delete', async () => {
    const answers = {
        v: 1,
        trigger: { email: SECRET },
        pages: { p1: { a: 1, b: 2 }, p2: { c: 3 } },
        skipped: [{ stepId: 'p1', field: 'doc', reason: 'file' }],
    };
    const s = await store.createFormScenario({ automationId: 'a1', sourceRunId: 'r1', name: 'happy', answers, createdBy: 'u1' });
    assert.match(s.id, /^fsc_[0-9a-f]{32}$/);
    assert.strictEqual(s.hasTriggerAnswers, true);
    assert.deepStrictEqual(s.pages, [{ stepId: 'p1', fieldCount: 2 }, { stepId: 'p2', fieldCount: 1 }]);
    assert.deepStrictEqual(s.skipped, [{ stepId: 'p1', field: 'doc', reason: 'file' }]);
    assert.ok(!JSON.stringify(s).includes(SECRET));
    assert.ok(!JSON.stringify(await store.listFormScenarios('a1')).includes(SECRET));

    const full = await store.getFormScenario('a1', s.id);
    assert.deepStrictEqual(full.answers, answers);
    assert.strictEqual(await store.getFormScenario('a2', s.id), null);
    assert.strictEqual(await store.countFormScenarios('a1'), 1);

    await assert.rejects(
        () => store.createFormScenario({ automationId: 'a1', sourceRunId: 'r2', name: 'happy', answers }),
        (e) => e.status === 409 && e.code === 'scenario_name_taken',
    );
    const other = await store.createFormScenario({ automationId: 'a1', sourceRunId: 'r2', name: 'other', answers: { v: 1, trigger: null, pages: {}, skipped: [] } });
    assert.strictEqual(other.hasTriggerAnswers, false);
    await assert.rejects(() => store.renameFormScenario('a1', other.id, 'happy'), (e) => e.code === 'scenario_name_taken');
    assert.strictEqual((await store.renameFormScenario('a1', other.id, 'renamed')).name, 'renamed');
    assert.strictEqual(await store.renameFormScenario('a2', other.id, 'zzz'), null);
    // The same name is free on another automation.
    await store.createFormScenario({ automationId: 'a2', sourceRunId: 'r4', name: 'happy', answers });

    assert.strictEqual(await store.deleteFormScenario('a1', s.id), true);
    assert.strictEqual(await store.deleteFormScenario('a1', s.id), false);
    await store.deleteFormScenario('a1', other.id);
});

test('deleting the automation cascades every table', async () => {
    const f = await store.createFixture({ automationId: 'a2', runId: 'r4', stepId: 's1', input: { v: 1 } });
    await store.createTestCase({ automationId: 'a2', stepId: 's1', name: 'c', inputKind: 'run', fixtureId: f.id });
    await store.createTestCase({ automationId: 'a2', stepId: 's1', name: 't', inputKind: 'typed', typedInput: {} });
    await store.createGolden({ automationId: 'a2', runId: 'r4', label: null, ignorePaths: [] });
    assert.ok(await count('automation_test_cases') >= 2);
    await pg.query('DELETE FROM automations WHERE id = $1', ['a2']);
    for (const t of ['automation_test_cases', 'automation_test_fixtures', 'automation_golden_runs', 'automation_form_scenarios']) {
        assert.strictEqual(Number((await pg.query(`SELECT COUNT(*)::int AS n FROM ${t} WHERE automation_id = 'a2'`)).rows[0].n), 0, t);
    }
});
