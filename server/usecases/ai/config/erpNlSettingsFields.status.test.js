// @typecheck
'use strict';
/**
 * The int_erp_nl module's part of GET /ai/user-settings (erpNlSettingsFields.js readStatus and
 * readNmbrsForm): the keys the answer has always had, in that order, read secret by secret as the
 * route read them, and never a secret in the answer.
 *
 * Run: cd server && node --test usecases/ai/config/erpNlSettingsFields.status.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { readStatus, readNmbrsForm } = require('./erpNlSettingsFields');

/**
 * A getSecret over `values` (field -> value for user u1) that records what it was asked.
 * @param {Record<string, string>} values
 */
function secrets(values) {
    /** @type {string[]} */
    const asked = [];
    const getSecret = async (/** @type {string} */ key) => {
        asked.push(key.replace(/_user_u1$/, ''));
        return values[key.replace(/_user_u1$/, '')] ?? null;
    };
    return { getSecret, asked };
}

test('nothing set up: every flag false, the reads stop at the first missing secret', async () => {
    const { getSecret, asked } = secrets({});
    assert.deepEqual(await readStatus(getSecret, 'u1'), {
        hasAfasConfig: false, hasNmbrsConfig: false, hasNmbrsSubscriptionKey: false, hasNmbrsClient: false,
        hasVplanConfig: false, hasFirebirdConfig: false, hasFrappeCrmConfig: false,
        hasTwobaConfig: false, twobaAuthMode: 'password', twobaUsername: '',
    });
    assert.deepEqual(asked, [
        'afas_token', 'nmbrs_api_mode', 'nmbrs_subdomain', 'nmbrs_subscription_key', 'nmbrs_client_id',
        'vplan_api_key', 'firebird_host', 'frappe_crm_url', 'twoba_client_id', 'twoba_auth_mode', 'twoba_username',
    ]);
});

test('NMBRS over REST is set up by its subscription key; the form fields are the non-secret ones', async () => {
    const { getSecret } = secrets({ nmbrs_api_mode: 'rest', nmbrs_subscription_key: 'k', nmbrs_token: 'secret', nmbrs_email: 'a@b.nl' });
    const status = await readStatus(getSecret, 'u1');
    assert.equal(status.hasNmbrsConfig, true);
    assert.equal(status.hasNmbrsSubscriptionKey, true);
    assert.deepEqual(await readNmbrsForm(getSecret, 'u1'), { nmbrsApiMode: 'rest', nmbrsSubdomain: '', nmbrsEmail: 'a@b.nl', nmbrsEnv: 'production' });
});

test('every connection set up: every flag true, and no value of a secret in the answer', async () => {
    const fields = ['afas_token', 'afas_member_number', 'nmbrs_subdomain', 'nmbrs_token', 'nmbrs_subscription_key', 'nmbrs_client_id',
        'nmbrs_client_secret', 'vplan_api_key', 'vplan_api_env', 'firebird_host', 'firebird_database', 'firebird_user', 'firebird_password',
        'frappe_crm_url', 'frappe_crm_api_key', 'frappe_crm_api_secret', 'twoba_client_id', 'twoba_client_secret', 'twoba_password'];
    const { getSecret } = secrets({ ...Object.fromEntries(fields.map((f) => [f, `SECRET-${f}`])), twoba_username: 'me' });
    const status = await readStatus(getSecret, 'u1');
    for (const [key, value] of Object.entries(status)) if (key.startsWith('has')) assert.equal(value, true, key);
    assert.equal(status.twobaUsername, 'me');
    assert.ok(!JSON.stringify(status).includes('SECRET-'));
});
