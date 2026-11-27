// @typecheck
'use strict';
/**
 * usecases/ai/config/settingsModuleStatus: the integration modules' part of GET /ai/user-settings.
 * Each module that is here adds its keys in today's order; a module that is not here adds none.
 * The modules are doubles registered by name, so this runs alike with every module present or hidden.
 *
 * Run: cd server && node --test usecases/ai/config/settingsModuleStatus.test.js
 */

const { test, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { registerFeatureModules, _clearFeatureModulesForTests } = require('../../../core/featureModules');
const { settingsModuleStatus } = require('./settingsModuleStatus');

const ERP = 'usecases/ai/config/erpNlSettingsFields';
const SCALEWAY = 'usecases/ai/config/scalewayBillingFields';
const getSecret = async (/** @type {string} */ key) => (key === 'set_user_u1' ? 'x' : null);

/** @type {Array<[string, string]>} */
let asked = [];
const erpDouble = {
    readStatus: async (/** @type {typeof getSecret} */ gs, /** @type {string} */ userId) => { asked.push(['erp', userId]); return { hasAfasConfig: !!(await gs(`set_user_${userId}`)), hasTwobaConfig: false }; },
    readNmbrsForm: async (/** @type {typeof getSecret} */ _gs, /** @type {string} */ userId) => { asked.push(['nmbrs', userId]); return { nmbrsApiMode: 'soap' }; },
};
const scalewayDouble = {
    readStatus: async (/** @type {typeof getSecret} */ _gs, /** @type {string} */ userId) => { asked.push(['scaleway', userId]); return { hasScalewayBillingConfig: true }; },
};

const absent = (/** @type {string} */ name) => _clearFeatureModulesForTests(name);

before(() => {
    // Whatever the modules registered first; each test then decides which of the two is here.
    require('../../../modules/firstParty/registrationChannels').ensureOpen('boot/featureModules');
});
afterEach(() => { asked = []; absent(ERP); absent(SCALEWAY); });

test('both modules here: their keys in the order the answer has always had', async () => {
    registerFeatureModules({ [ERP]: () => erpDouble, [SCALEWAY]: () => scalewayDouble });
    const status = await settingsModuleStatus(getSecret, 'u1');
    assert.deepEqual(Object.keys(status), ['hasAfasConfig', 'hasTwobaConfig', 'hasScalewayBillingConfig', 'nmbrsApiMode']);
    assert.equal(status.hasAfasConfig, true, 'read through the getSecret it was given');
    assert.deepEqual(asked, [['erp', 'u1'], ['scaleway', 'u1'], ['nmbrs', 'u1']]);
});

test('the reader reaches the module with the caller\'s getSecret', async () => {
    registerFeatureModules({ [ERP]: () => erpDouble });
    const status = await settingsModuleStatus(async (key) => (key === 'set_user_u2' ? 'x' : null), 'u2');
    assert.equal(status.hasAfasConfig, true);
});

test('no module here: no key, nothing read', async () => {
    absent(ERP); absent(SCALEWAY);
    assert.deepEqual(await settingsModuleStatus(getSecret, 'u1'), {});
    assert.deepEqual(asked, []);
});

test('one module here: only its keys', async () => {
    registerFeatureModules({ [SCALEWAY]: () => scalewayDouble });
    assert.deepEqual(await settingsModuleStatus(getSecret, 'u1'), { hasScalewayBillingConfig: true });
});
