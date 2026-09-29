/**
 * piiVaultStore — the schema init contract.
 *
 * The vault used to guard its DDL with a bare boolean that was only flipped
 * AFTER the awaits. Every caller therefore passed the `if (initialized)` check
 * before any of them had finished, so the first burst of concurrent traffic ran
 * the whole CREATE TABLE / CREATE UNIQUE INDEX block once per caller against
 * the same pool. It survived on IF NOT EXISTS, but it queued N redundant DDL
 * statements ahead of the queries that were waiting for them.
 *
 * Run: cd server && node --test --test-force-exit stores/piiVaultStore.init.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

process.env.NODE_ENV = 'test';

const SERVER = path.join(__dirname, '..');

let ddlRuns = 0;
let failInit = false;

function mockModule(absPath, exports) {
    require.cache[require.resolve(absPath)] = { id: absPath, filename: absPath, loaded: true, exports };
}

// A deliberately plain double: no `makeStoreInit` of its own, so the store runs
// against the real memo in stores/lib/storeInit.js rather than a test copy.
mockModule(path.join(SERVER, 'db'), {
    async exec(sql) {
        if (/CREATE TABLE IF NOT EXISTS pii_vault_entries/.test(sql)) {
            ddlRuns++;
            if (failInit) throw new Error('permission denied for schema public');
        }
        // Yield, so a memo that is only written after its awaits loses the race.
        await new Promise(resolve => setImmediate(resolve));
    },
    async run() { return { rowCount: 0 }; },
    async getOne() { return null; },
    async getAll() { return []; },
});

const vault = require('./piiVaultStore');

test('a failed init is not memoised — the next caller retries', async () => {
    failInit = true;
    await assert.rejects(() => vault.initVaultTables(), /permission denied/);
    assert.strictEqual(ddlRuns, 1);

    failInit = false;
    await vault.initVaultTables();
    assert.strictEqual(ddlRuns, 2,
        'a boot that lost the database must recover without a restart');
});

test('concurrent first-callers run the DDL exactly once', async () => {
    ddlRuns = 0;
    // Evict so this test sees a cold store rather than the memo the previous
    // test already resolved.
    delete require.cache[require.resolve('./piiVaultStore')];
    const cold = require('./piiVaultStore');

    await Promise.all(Array.from({ length: 20 }, () => cold.initVaultTables()));
    assert.strictEqual(ddlRuns, 1,
        '20 parallel callers must share one DDL run, not issue 20 of them');
});
