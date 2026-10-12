'use strict';

/**
 * Which single sign-on identity providers this install has configured.
 *
 * "Configured" is what the SSO screen calls enabled (auth/oauth/
 * ssoConfigRoutes.js): a client id AND a client secret, for the Nextcloud
 * provider in configStore 'oauth' also its URL. No writer ever sets a
 * provider's `enabled` flag, so a predicate that required it read every
 * working SSO setup as password-only. ISO A.8.5 (iso27001/a8-5-secure-auth.js)
 * and NIS2 Art. 21(2)(j) (nis2/admin-mfa.js) both judge SSO through this one
 * predicate, so the two can never disagree about the same configuration.
 */

/**
 * Names of the configured providers, from the raw configStore values.
 * @param {Record<string, any>|null|undefined} providers configStore 'providers' (google, microsoft, …)
 * @param {Record<string, any>|null|undefined} oauth configStore 'oauth' (Nextcloud)
 * @returns {string[]}
 */
function configuredSsoProviders(providers, oauth) {
    const names = [];
    if (providers && typeof providers === 'object') {
        for (const [name, p] of Object.entries(providers)) {
            if (p && p.clientId && (p.hasClientSecret || p.clientSecret)) names.push(name);
        }
    }
    if (oauth && oauth.nextcloudUrl && oauth.clientId && (oauth.hasClientSecret || oauth.clientSecret)) names.push('nextcloud');
    return names;
}

module.exports = { configuredSsoProviders };
