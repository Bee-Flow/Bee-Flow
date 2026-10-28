// @typecheck noImplicitAny
/**
 * The provider half of the OAuth callback (./providerCallbackRoutes.js):
 * exchange the authorization code for tokens and read the user's profile,
 * per provider. Returns { tokenData, user } (user undefined when the profile
 * fetch failed; the route answers that) or { error } with the code the route
 * puts in its `?error=` redirect.
 */

const log = require('../../telemetry/log');
const { OAUTH_PROVIDERS } = require('../permissions');
const microsoftLogin = require('./microsoftLogin');

/** @typedef {import('./providerCallbackRoutes').OAuthTokenResponse} OAuthTokenResponse */
/** @typedef {import('./providerCallbackRoutes').OAuthUser} OAuthUser */

/** @typedef {{ clientId?: string, clientSecret?: string, tenantId?: string }} ProviderCredentials */
/** @typedef {{ providers?: { google?: ProviderCredentials, microsoft?: ProviderCredentials }, oauth?: { nextcloudUrl?: string, clientId?: string, clientSecret?: string } }} ExchangeConfig */

/**
 * Google: token endpoint + OpenID userinfo.
 * @param {{ config: ExchangeConfig, code: string, redirectUri: string, codeVerifier?: string }} args
 */
async function exchangeGoogle({ config, code, redirectUri, codeVerifier }) {
    let tokenData, user;

    const providerConfig = config.providers?.google || {};

    /** @type {Record<string, string>} */
    const googleBody = {
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: redirectUri,
        client_id: providerConfig.clientId,
        client_secret: providerConfig.clientSecret,
    };
    if (codeVerifier) googleBody.code_verifier = codeVerifier;
    const tokenResponse = await fetch(OAUTH_PROVIDERS.google.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(googleBody).toString()
    });

    if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();
        log.error('Google token exchange failed:', errorText);
        return { error: 'token_exchange_failed' };
    }

    tokenData = /** @type {OAuthTokenResponse} */ (await tokenResponse.json());

    const userResponse = await fetch(OAUTH_PROVIDERS.google.userInfoUrl, {
        headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
    });

    if (userResponse.ok) {
        const userData = /** @type {Record<string, any>} */ (await userResponse.json()); // the provider's profile payload
        user = /** @type {OAuthUser} */ ({
            id: userData.sub || userData.email,
            displayName: userData.name || userData.email,
            firstName: userData.given_name || '',
            lastName: userData.family_name || '',
            email: userData.email,
            picture: userData.picture,
            provider: 'google'
        });
    }


    return { tokenData, user };
}

/**
 * Microsoft: token endpoint, verified id_token, Graph profile and photo.
 * @param {{ config: ExchangeConfig, code: string, redirectUri: string, codeVerifier?: string, nonce?: string }} args
 */
async function exchangeMicrosoft({ config, code, redirectUri, codeVerifier, nonce }) {
    let tokenData, user;

    const providerConfig = config.providers?.microsoft || {};
    const tenantId = providerConfig.tenantId || 'common';
    const tokenUrl = OAUTH_PROVIDERS.microsoft.tokenUrl(tenantId);

    log.info(`[OAuth/Microsoft] Token URL: ${tokenUrl}`);
    log.info(`[OAuth/Microsoft] REDIRECT_URI: ${redirectUri}`);
    log.info(`[OAuth/Microsoft] clientId: ${providerConfig.clientId}`);
    log.info(`[OAuth/Microsoft] clientSecret present: ${!!providerConfig.clientSecret}`);
    log.info(`[OAuth/Microsoft] tenantId: ${tenantId}`);

    /** @type {Record<string, string>} */
    const msBody = {
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: redirectUri,
        client_id: providerConfig.clientId,
        client_secret: providerConfig.clientSecret,
    };
    if (codeVerifier) msBody.code_verifier = codeVerifier;
    const tokenResponse = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(msBody).toString()
    });

    log.info(`[OAuth/Microsoft] Token response status: ${tokenResponse.status} ${tokenResponse.statusText}`);

    if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();
        log.error(`[OAuth/Microsoft] TOKEN EXCHANGE FAILED (${tokenResponse.status}):`, errorText);
        return { error: 'token_exchange_failed' };
    }

    tokenData = /** @type {OAuthTokenResponse} */ (await tokenResponse.json());
    const { verifyMicrosoftIdentity, assertGraphIdentity } = require('../microsoftIdentity');
    const identity = await verifyMicrosoftIdentity(tokenData.id_token, { clientId: providerConfig.clientId, tenantId, nonce });
    log.info(`[OAuth/Microsoft] Token exchange successful — access_token present: ${!!tokenData.access_token}, refresh_token present: ${!!tokenData.refresh_token}`);
    if (tokenData.scope) log.info(`[OAuth/Microsoft] Granted scopes: ${tokenData.scope}`);
    if (tokenData.error) log.error(`[OAuth/Microsoft] Token response error: ${tokenData.error} — ${tokenData.error_description || ''}`);

    log.info(`[OAuth/Microsoft] User info URL: ${OAUTH_PROVIDERS.microsoft.userInfoUrl}`);
    const userResponse = await fetch(OAUTH_PROVIDERS.microsoft.userInfoUrl, {
        headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
    });

    log.info(`[OAuth/Microsoft] User info response status: ${userResponse.status} ${userResponse.statusText}`);

    if (userResponse.ok) {
        const userData = /** @type {Record<string, any>} */ (await userResponse.json()); // the provider's profile payload
        log.info(`[OAuth/Microsoft] User info received — id: ${userData.id}, has mail: ${!!userData.mail}, has upn: ${!!userData.userPrincipalName}`);
        assertGraphIdentity(identity, userData.id);
        // Keep the Azure object id separate from the local id. The
        // local id is resolved/minted in the provisioning block below
        // so we do not collide with users already synced from Azure AD.
        user = /** @type {OAuthUser} */ ({
            ...identity,
            displayName: userData.displayName || userData.userPrincipalName,
            email: userData.mail || userData.userPrincipalName,
            provider: 'microsoft'
        });
        log.info(`[OAuth/Microsoft] Mapped user — azureUserId: ${user.azureUserId}, email: ${log.textForLog(user.email)}`);

        user.picture = await microsoftLogin.saveMicrosoftPhoto(tokenData.access_token, user) || user.picture;
    } else {
        const userErrorText = await userResponse.text();
        log.error(`[OAuth/Microsoft] USER INFO FETCH FAILED (${userResponse.status}):`, userErrorText);
    }

    return { tokenData, user };
}

/**
 * Nextcloud: token endpoint + OCS user; records the raw uid and token expiry on the session.
 * @param {{ config: ExchangeConfig, code: string, redirectUri: string, session: import('express').Request['session'] }} args
 */
async function exchangeNextcloud({ config, code, redirectUri, session }) {
    let tokenData, user;

    const { nextcloudUrl, clientId, clientSecret } = config.oauth || {};

    const tokenResponse = await fetch(`${nextcloudUrl}/apps/oauth2/api/v1/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: redirectUri,
            client_id: clientId,
            client_secret: clientSecret
        }).toString()
    });

    if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();
        log.error('Nextcloud token exchange failed:', errorText);
        return { error: 'token_exchange_failed' };
    }

    tokenData = /** @type {OAuthTokenResponse} */ (await tokenResponse.json());

    const userResponse = await fetch(`${nextcloudUrl}/ocs/v2.php/cloud/user?format=json`, {
        headers: {
            'Authorization': `Bearer ${tokenData.access_token}`,
            'OCS-APIRequest': 'true'
        }
    });

    if (userResponse.ok) {
        const userData = /** @type {Record<string, any>} */ (await userResponse.json()); // the provider's profile payload
        const ocs = userData.ocs?.data || {};
        // Persist the raw uid for WebDAV path construction. Must be
        // captured BEFORE we mint the prefixed local id below.
        if (ocs.id) session.nextcloudUid = ocs.id;
        if (tokenData.expires_in) {
            session.nextcloudTokenExpiresAt = Date.now() + Number(tokenData.expires_in) * 1000;
        }
        user = /** @type {OAuthUser} */ ({
            id: `nextcloud-${ocs.id || ocs['display-name']}`,
            displayName: ocs['display-name'] || ocs.id,
            email: ocs.email || '',
            provider: 'nextcloud'
        });
    }

    return { tokenData, user };
}

/**
 * @param {{ provider: string, config: any, code: string, redirectUri: string,
 *           codeVerifier?: string, nonce?: string, session: any }} args
 */
async function exchangeCodeForUser({ provider, config, code, redirectUri, codeVerifier, nonce, session }) {
    if (provider === 'google') return exchangeGoogle({ config, code, redirectUri, codeVerifier });
    if (provider === 'microsoft') return exchangeMicrosoft({ config, code, redirectUri, codeVerifier, nonce });
    if (provider === 'nextcloud') return exchangeNextcloud({ config, code, redirectUri, session });
    return { error: 'unknown_provider' };
}

module.exports = { exchangeCodeForUser };
