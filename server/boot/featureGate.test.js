/**
 * The notebook gate used to fail open on a config read error while the
 * project gate failed closed; both now share one helper and one policy.
 *
 * Run: cd server && node --test --test-force-exit boot/featureGate.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

// The real configStore over a config table the test fills (testUtils/configRows.js).
const { useConfigRows } = require('../testUtils/configRows');
const config = useConfigRows();
test.after(config.restore);

const { featureGate } = require('./featureGate');

async function pass(gate) {
    const res = { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    let nexted = false;
    let err;
    await gate({}, res, (e) => { nexted = !e; err = e; });
    return { res, nexted, err };
}

test.beforeEach(config.reset);

test('an unset flag lets the request through', async () => {
    const { nexted } = await pass(featureGate('notebooks', 'Notebooks'));
    assert.strictEqual(nexted, true);
});

test('a flag set to false is a 403 that names the feature', async () => {
    config.rows.feature_notebooks_enabled = false;
    const { res, nexted } = await pass(featureGate('notebooks', 'Notebooks'));
    assert.strictEqual(nexted, false);
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(res.body, { error: 'Notebooks feature is disabled' });
});

test('an unreadable flag is a 503, never a pass', async () => {
    config.failOn(true);
    const { res, nexted, err } = await pass(featureGate('projects', 'Projects'));
    assert.strictEqual(nexted, false);
    // refused via the terminal handler (wire shape: auth/gates.wire.test.js)
    assert.strictEqual(res.body, undefined);
    assert.deepStrictEqual([err.status, err.code, err.message], [503, 'feature_gate_unavailable', 'Projects availability could not be determined']);
});
