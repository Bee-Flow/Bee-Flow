// @typecheck strict
'use strict';
/**
 * The connection settings of this module's integrations as the settings forms send them: AFAS,
 * NMBRS, vPlan, Firebird, Frappe CRM and 2BA. They are fields of POST /ai/user-settings
 * (routes/ai/config/userSettings.js), which asks for them by name: the shapes use this module's
 * own patterns, and an installation without the module has no such fields.
 *
 * The order of the keys is the order they had in that route's body schema; the API reference
 * lists them in it. readStatus and readNmbrsForm are this module's part of the GET answer.
 */

const { z, typeError } = require('../../../utils/zod');
const { shaped, oneOf } = require('./settingsFieldShapes');
const { normalizeAfasToken } = require('../../../integrations/afasTools');
const { SUBDOMAIN_RE: NMBRS_SUBDOMAIN_RE, TOKEN_RE: NMBRS_TOKEN_RE, EMAIL_RE: NMBRS_EMAIL_RE } = require('../../../integrations/nmbrsTools');
const NMBRS_CLIENT_ID_RE = /^[\x21-\x7E]{4,256}$/; // printable ASCII, no whitespace/CRLF
const { API_KEY_RE: VPLAN_API_KEY_RE, API_ENV_RE: VPLAN_API_ENV_RE } = require('../../../integrations/vplanTools');
const { firebirdFields } = require('./firebirdFields');
const { frappeCrmFields } = require('./frappeCrmFields.mts');

const AFAS_NUMBER_TEXT = 'AFAS member number must be digits only.';
const AFAS_TOKEN_TEXT = 'AFAS token is not a valid AppConnector token. Paste the token XML or its hex data.';

const erpNlSettingsFields = {
    // AFAS Profit — the member number forms the API URL's subdomain (SSRF
    // guard) and the token is stored in canonical XML form. A number is
    // taken as its digits, as String() did before.
    afasMemberNumber: z.preprocess((v) => (typeof v === 'number' ? String(v) : v),
        shaped(/^\d{1,10}$/, AFAS_NUMBER_TEXT)),
    afasToken: z.string({ error: typeError({ invalid: AFAS_TOKEN_TEXT }) }).nullable().transform((v, ctx) => {
        if (!v) return '';
        const value = normalizeAfasToken(v);
        if (!value) {
            ctx.addIssue({ code: 'custom', message: AFAS_TOKEN_TEXT });
            return z.NEVER;
        }
        return value;
    }),
    afasEnvType: oneOf(['', 'production', 'test', 'accept'], 'AFAS environment type must be production, test or accept.'),
    // NMBRS (read-only). The subdomain forms the SOAP Domain / REST tenant
    // (SSRF-relevant), the token/email travel in auth headers.
    nmbrsApiMode: oneOf(['', 'soap', 'rest'], 'NMBRS API mode must be soap or rest.'),
    nmbrsSubdomain: shaped(NMBRS_SUBDOMAIN_RE, 'NMBRS subdomain is invalid — use just the tenant name (e.g. "mycompany"), no dots or slashes.'),
    nmbrsEmail: shaped(NMBRS_EMAIL_RE, 'NMBRS login email is invalid.'),
    nmbrsToken: shaped(NMBRS_TOKEN_RE, 'NMBRS token is invalid — paste the API token / bearer token with no spaces.'),
    nmbrsEnv: oneOf(['', 'production', 'sandbox'], 'NMBRS environment must be production or sandbox.'),
    // NMBRS REST: the subscription key travels in the X-Subscription-Key header and
    // the client id / secret in the Basic header of the token call, so the shape
    // (printable ASCII, no whitespace) is the header-injection guard.
    nmbrsSubscriptionKey: shaped(NMBRS_TOKEN_RE, 'NMBRS subscription key is invalid — paste the key from the Nmbrs developer portal with no spaces.'),
    nmbrsClientId: shaped(NMBRS_CLIENT_ID_RE, 'NMBRS client ID is invalid — paste the client ID of your Nmbrs app with no spaces.'),
    nmbrsClientSecret: shaped(NMBRS_TOKEN_RE, 'NMBRS client secret is invalid — paste the client secret of your Nmbrs app with no spaces.'),
    // vPlan (read-only) — both travel in request headers (X-Api-Key /
    // X-Api-Env), so the shape check is the header-injection guard.
    vplanApiKey: shaped(VPLAN_API_KEY_RE, 'vPlan API key is invalid — paste the key from vPlan → Settings → Developers, with no spaces.'),
    vplanApiEnv: shaped(VPLAN_API_ENV_RE, 'vPlan environment is invalid — paste the API env shown next to the key in vPlan, with no spaces.'),
    // Firebird, Frappe CRM and 2BA: the shapes live in firebirdFields.js, frappeCrmFields.mts and twobaFields.mts, shared with their connection tests.
    ...firebirdFields, ...frappeCrmFields, ...require('./twobaFields.mts').twobaFields,
};

/** @typedef {(key: string) => Promise<unknown>} GetSecret */

/**
 * GET /ai/user-settings: whether each connection of this module is set up (never a secret), in the
 * order the answer has always listed them. The secrets are read one by one, as that route read them.
 * @param {GetSecret} getSecret
 * @param {string} userId
 */
async function readStatus(getSecret, userId) {
    const has = async (/** @type {string} */ field) => !!(await getSecret(`${field}_user_${userId}`));
    return {
        hasAfasConfig: (await has('afas_token')) && (await has('afas_member_number')),
        hasNmbrsConfig: (await getSecret(`nmbrs_api_mode_user_${userId}`)) === 'rest'
            ? await has('nmbrs_subscription_key')
            : (await has('nmbrs_subdomain')) && (await has('nmbrs_token')),
        // REST secrets are never returned, only whether they are set.
        hasNmbrsSubscriptionKey: await has('nmbrs_subscription_key'),
        hasNmbrsClient: (await has('nmbrs_client_id')) && (await has('nmbrs_client_secret')),
        hasVplanConfig: (await has('vplan_api_key')) && (await has('vplan_api_env')),
        hasFirebirdConfig: (await has('firebird_host')) && (await has('firebird_database'))
            && (await has('firebird_user')) && (await has('firebird_password')),
        hasFrappeCrmConfig: (await has('frappe_crm_url')) && (await has('frappe_crm_api_key')) && (await has('frappe_crm_api_secret')),
        ...(await require('../../../core/integrations/twobaConfigured.mts').twobaStatus(getSecret, userId)),
    };
}

/**
 * GET /ai/user-settings: the non-secret NMBRS fields, so the settings form can pre-fill (the token is never returned).
 * @param {GetSecret} getSecret
 * @param {string} userId
 */
async function readNmbrsForm(getSecret, userId) {
    return {
        nmbrsApiMode: (await getSecret(`nmbrs_api_mode_user_${userId}`)) || 'soap',
        nmbrsSubdomain: (await getSecret(`nmbrs_subdomain_user_${userId}`)) || '',
        nmbrsEmail: (await getSecret(`nmbrs_email_user_${userId}`)) || '',
        nmbrsEnv: (await getSecret(`nmbrs_env_user_${userId}`)) || 'production',
    };
}

module.exports = { erpNlSettingsFields, readStatus, readNmbrsForm };
