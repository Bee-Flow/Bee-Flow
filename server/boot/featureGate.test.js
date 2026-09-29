/**
 * The notebook gate used to fail open on a config read error while the
 * project gate failed closed; both now share one helper and one policy.
 *
 * Run: cd server && node --test --test-force-exit boot/featureGate.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

let flag = null;
let readError = null;
const filename = require.resolve('../stores/configStore');
require.cache[filename] = {
    id: filename, filename, loaded: true,
    exports: { getConfig: async () => { if (readError) throw readError; return flag; } },
};

const { featureGate } = require('./featureGate');

async function pass(gate) {
    const res = { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    let nexted = false;
    await gate({}, res, () => { nexted = true; });
    return { res, nexted };
}

test.beforeEach(() => { flag = null; readError = null; });

test('an unset flag lets the request through', async () => {
    const { nexted } = await pass(featureGate('notebooks', 'Notebooks'));
    assert.strictEqual(nexted, true);
});

test('a flag set to false is a 403 that names the feature', async () => {
    flag = false;
    const { res, nexted } = await pass(featureGate('notebooks', 'Notebooks'));
    assert.strictEqual(nexted, false);
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(res.body, { error: 'Notebooks feature is disabled' });
});

test('an unreadable flag is a 503, never a pass', async () => {
    readError = new Error('connection refused');
    const { res, nexted } = await pass(featureGate('projects', 'Projects'));
    assert.strictEqual(nexted, false);
    assert.strictEqual(res.statusCode, 503);
    assert.deepStrictEqual(res.body, { error: 'Projects availability could not be determined' });
});
