// @typecheck strict
'use strict';
/**
 * The connection settings of this module's integrations as the settings forms send them: AFAS,
 * NMBRS, vPlan, Firebird, Frappe CRM and 2BA. They are fields of POST /ai/user-settings
 * (routes/ai/config/userSettings.js), which asks for them by name: the shapes use this module's
 * own patterns, and an installation without the module has no such fields.
 *
 * The order of the keys is the order they had in that route's body schema; the API reference
 * lists them in it.
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

module.exports = { erpNlSettingsFields };
