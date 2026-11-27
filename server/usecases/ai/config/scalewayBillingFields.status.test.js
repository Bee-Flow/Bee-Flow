// @typecheck
'use strict';
/**
 * The int_saas module's part of GET /ai/user-settings (scalewayBillingFields.js readStatus):
 * whether the Scaleway Billing key is set, never the key.
 *
 * Run: cd server && node --test usecases/ai/config/scalewayBillingFields.status.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { readStatus } = require('./scalewayBillingFields');

test('the flag follows the stored key of that user, and the key is not in the answer', async () => {
    /** @type {string[]} */
    const asked = [];
    const getSecret = async (/** @type {string} */ key) => { asked.push(key); return key === 'scaleway_billing_secret_key_user_u1' ? 'SECRET' : null; };
    assert.deepEqual(await readStatus(getSecret, 'u1'), { hasScalewayBillingConfig: true });
    assert.deepEqual(await readStatus(getSecret, 'u2'), { hasScalewayBillingConfig: false });
    assert.deepEqual(asked, ['scaleway_billing_secret_key_user_u1', 'scaleway_billing_secret_key_user_u2']);
});
