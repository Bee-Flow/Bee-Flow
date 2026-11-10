/**
 * userSecretKeys.mts: the per-user config keys (`<stem>_user_<id>`) that hold
 * a person's integration credentials, account e-mails and preferences.
 *
 * Shared by the settings route that writes them (routes/ai/config/userSettings.js)
 * and account erasure that deletes them (stores/user/usersDelete.js), so a
 * field added to the settings is erased too, without a store reaching into
 * a route.
 */

/** Body field → secret key stem. Empty string or null clears a field: disconnect. */
export const SECRETS: Readonly<Record<string, string>> = Object.freeze({
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
    nmbrsSubscriptionKey: 'nmbrs_subscription_key',
    nmbrsClientId: 'nmbrs_client_id',
    nmbrsClientSecret: 'nmbrs_client_secret',
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
});

/** Per-user stems written outside the settings secrets. */
const OTHER_PER_USER_STEMS: readonly string[] = Object.freeze([
    'gads_developer_token', 'gads_manager_id', 'gads_customer_id', 'enabled_apps',
    'github_token', 'github_username', 'linkedin_access_token', 'linkedin_person_id', 'linkedin_name',
    'google_workspace_email', 'microsoft365_email', 'withings_userid',
    'simple_mode', 'learning_path', 'memory_enabled', 'memory_sensitive_opt_in',
    // Why the Teams auto-import last skipped the user (core/meetingNotes/teamsImportSkipState.mts).
    'teams_autoimport_skip',
]);

/** Every per-user config stem account erasure deletes, without duplicates. */
export function perUserConfigStems(): string[] {
    return [...new Set([...Object.values(SECRETS), ...OTHER_PER_USER_STEMS])];
}
