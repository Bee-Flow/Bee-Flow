/**
 * createModule — the D1 dual return shape + the collapsed loader tick.
 *
 * The loader consumes the FLAT fields (router / initDBs / tick / tickIntervalMs);
 * the stores/workers arrays are for the SDK/tests. Only ONE tick runs, so it
 * must drain every call and reap every ~8th. We stub scanRunner.service via
 * require.cache so the reap path never touches docker, and count drains (db
 * getClient) vs reaps.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { makeHostMock, makeDbMock } = require('./hostMock');

// Stub the injected scanRunner.service BEFORE requiring index — the reap tick
// calls reapStaleRunners, which would otherwise hit the docker socket.
const svcPath = require.resolve('../server/src/scanRunner.service.js');
let reapCount = 0;
require.cache[svcPath] = {
    id: svcPath, filename: svcPath, loaded: true,
    exports: {
        dockerAvailable: async () => false,
        reapStaleRunners: async () => { reapCount += 1; return { reaped: 0 }; },
        prewarmToolbox: () => null,
        releasePrewarm: async () => {},
        toolboxStatus: async () => ({}),
        provisionToolbox: async () => ({ imageOk: false }),
        startAgentToolbox: async () => ({ zap: {}, exec: async () => ({ exitCode: 0 }), cleanup: async () => {} }),
        adoptToolbox: async () => null,
        registerActiveToolbox: () => {},
        unregisterActiveToolbox: () => {},
        killScan: async () => {},
    },
};

const { createModule } = require('../server/src/index.js');

test('createModule returns the D1 dual shape (flat fields + stores/workers arrays)', () => {
    const host = makeHostMock();
    const inst = createModule(host);

    assert.strictEqual(typeof inst.router, 'function', 'router is an express handler');
    assert.strictEqual(typeof inst.initDBs, 'function');
    assert.strictEqual(typeof inst.tick, 'function');
    assert.strictEqual(inst.tickIntervalMs, 15000);
    assert.strictEqual(typeof inst.dispose, 'function');

    assert.ok(Array.isArray(inst.stores) && inst.stores.length === 1);
    assert.strictEqual(inst.stores[0].name, 'securityScanStore');
    assert.strictEqual(typeof inst.stores[0].initDB, 'function');

    assert.ok(Array.isArray(inst.workers) && inst.workers.length === 2);
    assert.deepStrictEqual(inst.workers.map((w) => w.id), ['security-scan-drain', 'security-scan-reap']);
    assert.strictEqual(inst.workers[0].intervalMs, 15000);
    assert.strictEqual(inst.workers[1].intervalMs, 120000);
    inst.workers.forEach((w) => assert.strictEqual(typeof w.tick, 'function'));
});

test('the single loader tick drains every call and reaps every 8th', async () => {
    reapCount = 0;
    const db = makeDbMock();
    const host = makeHostMock({ db });
    const inst = createModule(host);

    for (let i = 0; i < 8; i++) await inst.tick();

    // Each drain claims via the store → one getClient per tick.
    const drains = db._calls.filter((c) => c.fn === 'getClient').length;
    assert.strictEqual(drains, 8, 'drained on every tick');
    assert.strictEqual(reapCount, 1, 'reaped exactly once across 8 ticks');

    for (let i = 0; i < 8; i++) await inst.tick();
    assert.strictEqual(reapCount, 2, 'reaped again on the 16th tick');
});

test('initDBs runs the store migration once', async () => {
    const db = makeDbMock();
    const inst = createModule(makeHostMock({ db }));
    await inst.initDBs();
    const execSql = db._calls.filter((c) => c.fn === 'exec').map((c) => c.sql).join('\n');
    assert.match(execSql, /CREATE TABLE IF NOT EXISTS security_scans/);
});

test('the prompt + Dockerfile assets are present for packaging', () => {
    // The driver reads server/prompts/security-scan-prompt.md via
    // path.join(__dirname, 'prompts', …) once bundled to server/entry.cjs; the
    // provision routes read assets/terminal-runner/Dockerfile via ../assets/….
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'server', 'prompts', 'security-scan-prompt.md')), 'prompt shipped under server/prompts');
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'assets', 'terminal-runner', 'Dockerfile')), 'Dockerfile shipped under assets/terminal-runner');
});
