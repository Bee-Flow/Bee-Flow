// @typecheck strict
/**
 * Which organisation a GitHub delivery belongs to, decided by the secret that
 * signed it.
 *
 * A delivery carries no organisation, only a signature. An organisation that
 * has its own secret (`org_<orgId>_github_webhook_secret`) gets its deliveries
 * dispatched to its own subscribers and to nobody else. The installation-wide
 * secret (`automation_github_webhook_secret`) names no organisation, so it is
 * only honoured while the installation has at most one: with more, a delivery
 * signed with it would reach every organisation's automations, and whoever
 * knows it could forge events for all of them.
 */

const crypto = require('crypto');
const { sameSignature } = require('./webhookSignature');

// Names of config entries, not secrets: the values live in the config store.
const INSTALLATION_CONFIG_NAME = 'automation_github_webhook_secret';
/** @param {string} orgId */
const orgConfigName = (orgId) => `org_${orgId}_github_webhook_secret`;

/**
 * @typedef {{ outcome: 'org', orgId: string } | { outcome: 'installation' }
 *   | { outcome: 'needs_org_secret' } | { outcome: 'bad_signature' } | { outcome: 'unconfigured' }} GithubDeliveryScope
 */

/**
 * @param {{ signature: string, raw: Buffer,
 *   getConfig: (key: string) => Promise<unknown>,
 *   listOrganizations: () => Promise<Array<{ id: string }>> }} input
 * @returns {Promise<GithubDeliveryScope>}
 */
async function scopeOfGithubDelivery({ signature, raw, getConfig, listOrganizations }) {
    /** @param {unknown} secret */
    const signedWith = (secret) => typeof secret === 'string' && secret.length > 0
        && sameSignature(signature, 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex'));

    const installationSecret = await getConfig(INSTALLATION_CONFIG_NAME);
    // Nothing was signed, so no secret can match: answered from the one entry
    // above, without looking up the organisations for an unsigned request.
    if (!signature) return installationSecret ? { outcome: 'bad_signature' } : { outcome: 'unconfigured' };

    const orgs = await listOrganizations();
    let anySecret = false;
    for (const org of orgs) {
        const secret = await getConfig(orgConfigName(org.id));
        if (secret) anySecret = true;
        if (signedWith(secret)) return { outcome: 'org', orgId: org.id };
    }
    if (!installationSecret && !anySecret) return { outcome: 'unconfigured' };
    if (!signedWith(installationSecret)) return { outcome: 'bad_signature' };
    return orgs.length > 1 ? { outcome: 'needs_org_secret' } : { outcome: 'installation' };
}

module.exports = { scopeOfGithubDelivery, orgConfigName, INSTALLATION_CONFIG_NAME };
