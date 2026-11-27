// @typecheck strict
'use strict';
/**
 * The part of GET /ai/user-settings (routes/ai/config/userSettings.js) that integration modules
 * answer: whether their connections are set up, never a secret. Each module's part is a function
 * beside its settings fields, the ones POST /ai/user-settings asks for by the same name:
 *
 *   int_erp_nl  usecases/ai/config/erpNlSettingsFields    readStatus (AFAS, NMBRS, vPlan, Firebird,
 *                                                         Frappe CRM, 2BA), readNmbrsForm
 *   int_saas    usecases/ai/config/scalewayBillingFields  readStatus (Scaleway Billing)
 *
 * They are spread in the order the answer has always listed these keys. A module that is not here
 * contributes no key: its settings do not exist in this installation.
 */

const { optionalFeatureModule } = require('../../../core/featureModules');

/** @typedef {(key: string) => Promise<unknown>} GetSecret */

/**
 * @param {GetSecret} getSecret
 * @param {string} userId
 */
async function settingsModuleStatus(getSecret, userId) {
    const erpNl = optionalFeatureModule('usecases/ai/config/erpNlSettingsFields');
    const scaleway = optionalFeatureModule('usecases/ai/config/scalewayBillingFields');
    return {
        ...(erpNl ? await erpNl.readStatus(getSecret, userId) : {}),
        ...(scaleway ? await scaleway.readStatus(getSecret, userId) : {}),
        ...(erpNl ? await erpNl.readNmbrsForm(getSecret, userId) : {}),
    };
}

module.exports = { settingsModuleStatus };
