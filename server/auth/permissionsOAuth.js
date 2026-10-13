// @typecheck
/**
 * Permissions — OAuth provider configuration (the one Microsoft scope set,
 * the refresh scope, the provider endpoints) and the auth config load/save
 * via stores/authConfigStore.
 *
 * Part of auth/permissions.js (the public surface); import from there.
 */

const { dep } = require('./permissionsDeps');

/**
 * The Microsoft scope set, in ONE place.
 *
 * It used to be a string literal copied into three files (this one, the vault
 * refresh in auth/automationAuth.js and the session refresh in
 * integrations/msGraphClient.js). A refresh that re-requests fewer scopes than
 * were granted silently downgrades the token, so every copy that fell out of
 * date was a grant quietly losing capabilities on its next refresh.
 */
const MICROSOFT_SCOPES = Object.freeze([
    'openid', 'email', 'profile', 'User.Read',
    'Mail.Read', 'Mail.Send',
    'Calendars.ReadWrite', 'Files.ReadWrite', 'Contacts.ReadWrite',
    // Teams meeting notes: ReadWrite to switch on recordAutomatically for a
    // meeting the user organizes, Recording to download the MP4 we transcribe.
    'OnlineMeetings.ReadWrite', 'OnlineMeetingTranscript.Read.All', 'OnlineMeetingArtifact.Read.All',
    'OnlineMeetingRecording.Read.All',
    'offline_access',
]);

/**
 * Scope string to send on a Microsoft refresh_token grant.
 *
 * Prefers whatever was ACTUALLY granted (stored on the credential) over our
 * default list: a user who consented to a wider set through an integration
 * connect flow — shared-mailbox scopes, say — must not have those stripped by a
 * refresh that only knows about the login scopes.
 */
function microsoftRefreshScope(grantedScope) {
    const granted = typeof grantedScope === 'string' ? grantedScope.trim() : '';
    return granted || MICROSOFT_SCOPES.join(' ');
}

// OAuth Provider Configurations
const OAUTH_PROVIDERS = {
    google: {
        name: 'Google',
        authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
        scopes: ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/presentations', 'https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/documents', 'https://www.googleapis.com/auth/contacts', 'https://www.googleapis.com/auth/contacts.readonly', 'https://www.googleapis.com/auth/meetings.space.readonly', 'https://www.googleapis.com/auth/meetings.space.settings']
    },
    microsoft: {
        name: 'Microsoft',
        authUrl: (tenantId) => `https://login.microsoftonline.com/${tenantId || 'common'}/oauth2/v2.0/authorize`,
        tokenUrl: (tenantId) => `https://login.microsoftonline.com/${tenantId || 'common'}/oauth2/v2.0/token`,
        userInfoUrl: 'https://graph.microsoft.com/v1.0/me',
        scopes: MICROSOFT_SCOPES
    },
    nextcloud: {
        name: 'Nextcloud',
        // Dynamic URLs based on config
        scopes: []
    },
    // Withings is an INTEGRATION provider, not an SSO identity provider: there
    // is no /auth/login/withings branch and no user is ever created from it.
    // The entry lives here so the connector route
    // (routes/integrations/withings.js) and the vault refresher
    // (auth/automationAuth.js refreshWithings) read one set of endpoints. The
    // client id/secret are admin-global secrets in configStore
    // (`withings_client_id` / `withings_client_secret`, the LinkedIn pattern),
    // NOT config.providers — that object drives the SSO login screen.
    //
    // Two Withings deviations from plain OAuth2, handled by both callers:
    //   • the token endpoint needs `action=requesttoken` in the form body;
    //   • a 200 response can still be a failure — `status` must be 0, and the
    //     tokens live one level down under `body`.
    withings: {
        name: 'Withings',
        authUrl: 'https://account.withings.com/oauth2_user/authorize2',
        tokenUrl: 'https://wbsapi.withings.net/v2/oauth2',
        apiBase: 'https://wbsapi.withings.net',
        scopes: ['user.info', 'user.metrics', 'user.activity'],
        ssoLogin: false,
    }
};

// Load config from persistent storage
async function loadConfig() {
    return dep('authConfigStore').load();
}

async function saveConfig(config) {
    return dep('authConfigStore').save(config);
}

module.exports = {
    MICROSOFT_SCOPES,
    microsoftRefreshScope,
    OAUTH_PROVIDERS,
    loadConfig,
    saveConfig,
};
