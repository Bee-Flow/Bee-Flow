// @typecheck
/**
 * Trust per step and recipient on a real Postgres (PGlite): let through counts up, a stop starts again and takes the
 * trust away, and trusting is per step and recipient.
 *
 * Run: cd server && node --test stores/coworkTrust.pg.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { store } = require('./coworkStore.testkit').coworkStoreOnPglite();
const { makeCoworkTrust } = require('./coworkTrust.mts');

const trust = makeCoworkTrust({ ready: () => store.initDB() });

test('let through counts up, a stop starts again and takes the trust away', async () => {
    const s = await store.createSchedule({ userId: 'u-trust', title: 'T', prompt: 'P', repeatInterval: 'daily', nextRunAt: new Date(Date.now() + 86_400_000).toISOString() });
    const id = /** @type {{ id: string }} */ (s).id;
    for (let i = 0; i < 3; i++) await trust.recordDecision(id, 'send', 'o@s.example', true);
    await trust.recordDecision(id, 'send', 'other@s.example', true);
    assert.deepStrictEqual(await trust.listTrust(id), [
        { stepId: 'send', recipient: 'o@s.example', letThrough: 3, trusted: false },
        { stepId: 'send', recipient: 'other@s.example', letThrough: 1, trusted: false },
    ]);
    assert.strictEqual(await trust.setTrusted(id, 'send', 'o@s.example', true), true);
    assert.strictEqual(await trust.setTrusted(id, 'nope', '*', true), false);
    await trust.recordDecision(id, 'send', 'o@s.example', false);
    assert.deepStrictEqual((await trust.listTrust(id))[0], { stepId: 'send', recipient: 'o@s.example', letThrough: 0, trusted: false });
    await store.deleteSchedule(id);
    assert.deepStrictEqual(await trust.listTrust(id), [], 'it goes with the item');
});
