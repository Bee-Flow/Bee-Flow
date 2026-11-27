// @typecheck strict
'use strict';
/**
 * The Scaleway Billing connection settings as the settings form sends them: fields of
 * POST /ai/user-settings (routes/ai/config/userSettings.js), which asks for them by name. The
 * shapes use this module's own patterns, and an installation without the module has no such fields.
 * readStatus is this module's part of the GET answer.
 */

const { shaped } = require('./settingsFieldShapes');
const { SECRET_KEY_RE: SCALEWAY_SECRET_KEY_RE, ORG_ID_RE: SCALEWAY_ORG_ID_RE } = require('../../../integrations/scalewayBillingTools');

const scalewayBillingFields = {
    // Scaleway Billing (read-only). The secret key travels in X-Auth-Token and
    // the organization id in a query string; both are UUIDs.
    // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- the string is a validation message, not a key
    scalewayBillingSecretKey: shaped(SCALEWAY_SECRET_KEY_RE, 'Scaleway secret key is invalid. Paste the secret key of the IAM API key, with no spaces.'),
    scalewayBillingOrgId: shaped(SCALEWAY_ORG_ID_RE, 'Scaleway Organization ID is invalid. Paste the ID from Organization settings, a UUID like 11111111-2222-3333-4444-555555555555.'),
};

/**
 * GET /ai/user-settings: whether the Scaleway Billing connection is set up (never the key).
 * @param {(key: string) => Promise<unknown>} getSecret
 * @param {string} userId
 */
async function readStatus(getSecret, userId) {
    return { hasScalewayBillingConfig: !!(await getSecret(`scaleway_billing_secret_key_user_${userId}`)) };
}

module.exports = { scalewayBillingFields, readStatus };
