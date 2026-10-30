// @typecheck strict
'use strict';

/**
 * Body field → secret key stem (stored as `<stem>_user_<id>`). Empty string or null clears a field: disconnect.
 * @type {Readonly<Record<string, string>>}
 */
const SECRETS = {
    firefliesApiKey: 'fireflies_api_key',
    gammaApiKey: 'gamma_api_key',
    youtrackUrl: 'youtrack_url',
    youtrackToken: 'youtrack_token',
    signrequestSubdomain: 'signrequest_subdomain',
    signrequestToken: 'signrequest_token',
    afasMemberNumber: 'afas_member_number',
    afasToken: 'afas_token',
    afasEnvType: 'afas_env_type',
    nmbrsApiMode: 'nmbrs_api_mode',
    nmbrsSubdomain: 'nmbrs_subdomain',
    nmbrsEmail: 'nmbrs_email',
    nmbrsToken: 'nmbrs_token',
    nmbrsEnv: 'nmbrs_env',
    vplanApiKey: 'vplan_api_key',
    vplanApiEnv: 'vplan_api_env',
    firebirdHost: 'firebird_host',
    firebirdPort: 'firebird_port',
    firebirdDatabase: 'firebird_database',
    firebirdUser: 'firebird_user',
    firebirdPassword: 'firebird_password',
    firebirdCharset: 'firebird_charset',
    scalewayBillingSecretKey: 'scaleway_billing_secret_key',
    scalewayBillingOrgId: 'scaleway_billing_org_id',
};

module.exports = { SECRETS };
