/**
 * webpagePublicShareStore — the schema init contract.
 *
 * This store carried BOTH memo shapes at once: a boolean plus a hand-rolled
 * promise cache, with a comment explaining the race the promise cache was added
 * to close. The hand-rolled cache was never cleared on failure, so one bad boot
 * — the FK parent's init losing the database, say — left a permanently rejected
 * promise and every later share lookup rejected against it until a restart.
 *
 * Run: cd server && node --test --test-force-exit stores/webpagePublicShareStore.init.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const { installResolveStub, evictModule } = require('../testUtils/stubRequire');

let ddlRuns = 0;
let failInit = false;

// Plain doubles, no `makeStoreInit` of their own, so the store runs against the
// real memo in stores/lib/storeInit.js. Both spellings: the store family reaches
// db as '../db', stores/webpage/schema.js as '../../db'.
const stub = {
    async exec(sql) {
        if (/CREATE TABLE IF NOT EXISTS webpage_public_shares\b/.test(sql)) {
            ddlRuns++;
            if (failInit) throw new Error('permission denied for schema public');
        }
        // Yield, so a memo that is only written after its awaits loses the race.
        await new Promise(resolve => setImmediate(resolve));
    },
    async run() { return { rowCount: 0 }; },
    async getOne() { return null; },
    async getAll() { return []; },
};

const restore = installResolveStub({ '../db': stub, '../../db': stub });
after(() => restore());

const store = require('./webpagePublicShareStore');

test('a failed init is not memoised — the next caller retries', async () => {
    failInit = true;
    await assert.rejects(() => store.initDB(), /permission denied/);
    assert.strictEqual(ddlRuns, 1);

    failInit = false;
    await store.initDB();
    assert.strictEqual(ddlRuns, 2,
        'a boot that lost the database must recover without a restart');
});

test('concurrent first-callers run the DDL exactly once', async () => {
    ddlRuns = 0;
    evictModule(require.resolve('./webpagePublicShareStore'));
    const cold = require('./webpagePublicShareStore');

    await Promise.all(Array.from({ length: 20 }, () => cold.initDB()));
    assert.strictEqual(ddlRuns, 1,
        '20 parallel viewers must share one DDL run, not issue 20 of them');
});
