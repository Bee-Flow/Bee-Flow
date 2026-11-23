// @typecheck
/**
 * What Cowork runs cost in AI (./coworkRunCosts.mts), on the store's own SQL (PGlite behind db.js): a prompt run by
 * its own id, a plan run by the engine's runs of its journey, an agent run by its conversation within its own time.
 *
 * Run: cd server && node --test stores/coworkStore.costs.pg.test.js
 */

'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert');
const { coworkStoreOnPglite } = require('./coworkStore.testkit');

const { pg, store } = coworkStoreOnPglite();
const USER = 'u-costs';

before(async () => {
    // The two tables the costs are read from, as far as the read uses them (their stores own the full schemas).
    await pg.exec(`
        CREATE TABLE IF NOT EXISTS ai_usage_log (id SERIAL PRIMARY KEY, timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(), run_id TEXT,
            conversation_id TEXT, estimated_cost NUMERIC, currency TEXT);
        CREATE TABLE IF NOT EXISTS automation_runs (id TEXT PRIMARY KEY, root_run_id TEXT);
    `);
});

async function item() {
    const s = await store.createSchedule({ userId: USER, title: 'Supplier radar', prompt: 'Read the mail.', repeatInterval: 'daily', nextRunAt: new Date(Date.now() + 86_400_000).toISOString() });
    return /** @type {{ id: string }} */ (s).id;
}

const call = (over) => pg.query('INSERT INTO ai_usage_log (run_id, conversation_id, estimated_cost, currency, timestamp) VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, NOW()))',
    [over.runId ?? null, over.conversationId ?? null, over.cost, over.currency ?? 'EUR', over.at ?? null]);

test('a prompt run costs its own calls; a plan run the calls of every leg of its journey; others\' calls are not counted', async () => {
    const id = await item();
    const prompt = /** @type {string} */ (await store.markRunning(id, { triggerKind: 'manual' }));
    await store.markCompleted(id, 'Done.', { runId: prompt });
    await call({ runId: prompt, cost: 0.02 });
    await call({ runId: prompt, cost: 0.03 });
    await call({ runId: 'someone-else', cost: 9 });

    const plan = /** @type {string} */ (await store.markRunning(id, { triggerKind: 'manual' }));
    await pg.query(`INSERT INTO automation_runs (id, root_run_id) VALUES ('leg-1', NULL), ('leg-2', 'leg-1'), ('other', NULL)`);
    await pg.query('UPDATE cowork_runs SET automation_run_id = $2 WHERE id = $1', [plan, 'leg-1']);
    await store.markCompleted(id, 'Done.', { runId: plan });
    await call({ runId: 'leg-1', cost: 0.1 });
    await call({ runId: 'leg-2', cost: 0.05 });
    await call({ runId: 'other', cost: 5 });

    const costs = await store.costsOfRuns(id, [prompt, plan]);
    assert.deepStrictEqual(Object.keys(costs).sort(), [plan, prompt].sort());
    assert.strictEqual(costs[prompt].calls, 2);
    assert.ok(Math.abs(costs[prompt].byCurrency.EUR - 0.05) < 1e-9);
    assert.strictEqual(costs[plan].calls, 2);
    assert.ok(Math.abs(costs[plan].byCurrency.EUR - 0.15) < 1e-9);
});

test('an agent run costs the calls in its conversation while it ran, not before or after', async () => {
    const id = await item();
    const run = /** @type {string} */ (await store.markRunning(id, { triggerKind: 'manual' }));
    await store.markCompleted(id, 'Done.', { runId: run, conversationId: 'conv-1' });
    const row = (await pg.query('SELECT started_at, finished_at FROM cowork_runs WHERE id = $1', [run])).rows[0];
    const during = new Date((new Date(row.started_at).getTime() + new Date(row.finished_at).getTime()) / 2).toISOString();
    await call({ conversationId: 'conv-1', cost: 0.4, at: during });
    await call({ conversationId: 'conv-1', cost: 7, at: '2020-01-01T00:00:00Z' });
    const costs = await store.costsOfRuns(id, [run]);
    assert.deepStrictEqual([costs[run]?.calls, costs[run]?.byCurrency.EUR], [1, 0.4]);
});

test('amounts stay per currency, a run without priced calls is left out, and runs of another item are not read', async () => {
    const id = await item();
    const run = /** @type {string} */ (await store.markRunning(id, { triggerKind: 'manual' }));
    await store.markCompleted(id, 'Done.', { runId: run });
    await call({ runId: run, cost: 0.1, currency: 'USD' });
    await call({ runId: run, cost: 0.2, currency: 'EUR' });
    const quiet = /** @type {string} */ (await store.markRunning(id, { triggerKind: 'manual' }));
    await store.markCompleted(id, 'Done.', { runId: quiet });
    const costs = await store.costsOfRuns(id, [run, quiet]);
    assert.deepStrictEqual(costs[run]?.byCurrency, { USD: 0.1, EUR: 0.2 });
    assert.strictEqual(costs[quiet], undefined);
    assert.deepStrictEqual(await store.costsOfRuns(await item(), [run]), {}, 'asked through another item');
    assert.deepStrictEqual(await store.costsOfRuns(id, []), {});
});

test('the month\'s cost of an owner is summed per item and in all', async () => {
    const since = new Date(Date.now() - 86_400_000);
    const { total, byItem } = await store.costsSince(USER, since);
    assert.ok(total.calls >= 7);
    assert.ok(Object.keys(byItem).length >= 3);
    const none = await store.costsSince('nobody', since);
    assert.deepStrictEqual(none, { total: { byCurrency: {}, calls: 0 }, byItem: {} });
});
