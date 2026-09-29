/**
 * De retentie-DELETE op cowork_runs, tegen een gestubde db: dit pint het
 * SQL-contract vast dat de veiligheid draagt — alleen gesloten rijen
 * (finished_at gestempeld, status niet 'running'), strikt ouder dan de
 * cutoff, in een subselect-LIMIT-batch (de automationStore-vorm, §WS3.1).
 * De echte-Postgres-round-trip (verwijdert alleen oude rijen, idempotent)
 * staat in coworkStore.test.js en skipt zonder DB; dit bestand draait overal.
 *
 * Run: node --test --test-force-exit stores/coworkStore.retention.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../testUtils/stubRequire');

const runCalls = [];
let nextRowCount = 0;

const restore = installResolveStub({
    '../db': {
        run: async (sql, params) => {
            runCalls.push({ sql, params });
            return { rowCount: nextRowCount, rows: [] };
        },
        getOne: async () => null,
        getAll: async () => [],
        exec: async () => {}, // schema-init (migratie + aiTaskStore) wordt no-op
        pool: { query: async () => ({ rows: [], rowCount: 0 }) },
    },
});

const coworkStore = require('./coworkStore');

test('de sweep verwijdert uitsluitend gesloten rijen ouder dan de cutoff', async () => {
    runCalls.length = 0;
    nextRowCount = 3;

    const cutoff = '2026-06-01T00:00:00.000Z';
    const n = await coworkStore.deleteRunsOlderThan(cutoff);
    assert.strictEqual(n, 3, 'geeft het aantal verwijderde rijen terug');

    const del = runCalls.find((c) => /DELETE FROM cowork_runs/.test(c.sql));
    assert.ok(del, 'er hoort precies deze DELETE te lopen');
    // De drie randvoorwaarden die een open poging onaantastbaar maken:
    assert.match(del.sql, /status <> 'running'/, "een 'running'-rij nooit raken");
    assert.match(del.sql, /finished_at IS NOT NULL/, 'de open rij (geen finished_at) nooit raken');
    assert.match(del.sql, /finished_at < \$1/, 'strikt ouder dan de cutoff — dat maakt de sweep idempotent');
    // Batchvorm: subselect met LIMIT, zoals automationStore.deleteRunsOlderThan.
    assert.match(del.sql, /WHERE id IN \(/);
    assert.match(del.sql, /LIMIT \$2/);
    assert.deepStrictEqual(del.params, [cutoff, 5000], 'default batchgrootte 5000');
});

test('een expliciete batchlimiet wordt doorgegeven', async () => {
    runCalls.length = 0;
    nextRowCount = 0;

    const n = await coworkStore.deleteRunsOlderThan('2026-06-01T00:00:00.000Z', { limit: 500 });
    assert.strictEqual(n, 0, 'niets meer te verwijderen → 0 (tweede pass is een no-op)');
    const del = runCalls.find((c) => /DELETE FROM cowork_runs/.test(c.sql));
    assert.strictEqual(del.params[1], 500);
});

test.after(() => restore());
