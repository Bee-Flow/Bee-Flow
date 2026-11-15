/**
 * imageAiSetting.mts: "images to AI in automations" is OFF unless an admin
 * saved a literal `enabled: true`, and a failed read is OFF too.
 *
 * Run: cd server && node --test core/automationRunner/imageAiSetting.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const setting = require('./imageAiSetting.mts');

beforeEach(() => setting.invalidateImageAiSetting());

const storeOf = (rows) => ({ getConfig: async (key) => rows[key] ?? null });

test('default: no organisation, no row, or a malformed row is off', async () => {
    assert.deepStrictEqual(await setting.resolveImageAiSetting(null, storeOf({})), { enabled: false, configured: false });
    assert.deepStrictEqual(await setting.resolveImageAiSetting('org1', storeOf({})), { enabled: false, configured: false });
    setting.invalidateImageAiSetting();
    const truthy = storeOf({ [setting.imageAiConfigKey('org1')]: { enabled: 'true' } });
    assert.deepStrictEqual(await setting.resolveImageAiSetting('org1', truthy), { enabled: false, configured: true });
});

test('only a literal enabled: true turns it on', async () => {
    const on = storeOf({ [setting.imageAiConfigKey('org1')]: { enabled: true } });
    assert.strictEqual((await setting.resolveImageAiSetting('org1', on)).enabled, true);
});

test('a failed read is off and never throws', async () => {
    const broken = { getConfig: async () => { throw new Error('db down'); } };
    assert.deepStrictEqual(await setting.resolveImageAiSetting('org1', broken), { enabled: false, configured: false });
});

test('a save is what the next read sees (the memo is dropped)', async () => {
    const rows = {};
    const store = { getConfig: async (k) => rows[k] ?? null, setConfig: async (k, v) => { rows[k] = v; } };
    assert.strictEqual((await setting.resolveImageAiSetting('org1', store)).enabled, false);
    await setting.saveImageAiSetting('org1', true, 'olga', store);
    assert.strictEqual((await setting.resolveImageAiSetting('org1', store)).enabled, true);
    assert.strictEqual(rows[setting.imageAiConfigKey('org1')].updatedBy, 'olga');
});

test('the key is the org prefix the teardown list uses', () => {
    const organizations = require('../../stores/user/organizations');
    assert.ok(organizations.orgConfigKeys('ORGID').includes(setting.imageAiConfigKey('ORGID')));
});
