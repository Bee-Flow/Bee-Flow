// @typecheck
/**
 * Free/public email providers.
 *
 * A shared domain here does NOT imply control of a Bee Flow org, so a
 * domain-only match against one of these must NEVER route a user into an
 * organisation (auto-join, adoption, "domain taken" collision). Only an exact
 * email match to an existing user, or an explicit admin action, may bind such a
 * user to an org. Everything else (different free-provider local-part, or no
 * match) yields an org-less/consumer account or a fresh org.
 *
 * This list is the single source of truth: the OAuth login resolver, the
 * Nextcloud connector bootstrap and the password-signup path all consume it, so
 * they can never drift apart (a narrower copy is how a personal gmail account
 * got auto-bound to an unrelated org — see server/auth/ssoUserResolver.js).
 *
 * The built-in set below is a non-removable safety floor. A super-admin can
 * ADD extra domains from the Admin Dashboard (persisted under the config key
 * `free_email_domains_extra`); those are merged on top of this floor by
 * getEffectiveFreeEmailDomains(). The floor can never be weakened from the UI,
 * so gmail.com et al. always stay blocked regardless of configuration.
 */

// Built-in floor — common global consumer/webmail providers and their aliases,
// plus widely-used country-specific free providers. Kept broad on purpose: a
// missing entry is a potential cross-tenant auto-join, an extra one only means
// "this domain can't own an org" (the safe direction).
const FREE_EMAIL_DOMAINS = new Set([
    // Google
    'gmail.com', 'googlemail.com',
    // Microsoft
    'outlook.com', 'outlook.co.uk', 'hotmail.com', 'hotmail.co.uk', 'hotmail.fr',
    'hotmail.de', 'hotmail.it', 'hotmail.es', 'live.com', 'live.nl', 'live.co.uk',
    'msn.com', 'windowslive.com',
    // Yahoo / AOL / Verizon
    'yahoo.com', 'yahoo.co.uk', 'yahoo.co.in', 'yahoo.fr', 'yahoo.de', 'yahoo.es',
    'yahoo.it', 'yahoo.ca', 'yahoo.com.br', 'yahoo.com.au', 'ymail.com',
    'rocketmail.com', 'aol.com', 'aim.com',
    // Apple
    'icloud.com', 'me.com', 'mac.com',
    // Proton
    'proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me',
    // GMX / Mail.com family
    'gmx.com', 'gmx.net', 'gmx.de', 'gmx.at', 'gmx.ch', 'mail.com',
    // Zoho
    'zoho.com', 'zohomail.com',
    // Yandex
    'yandex.com', 'yandex.ru', 'ya.ru',
    // Fastmail / HEY / Tutanota
    'hey.com', 'fastmail.com', 'fastmail.fm', 'tutanota.com', 'tutanota.de',
    'tuta.com', 'tutamail.com',
    // Other global free providers
    'mail.ru', 'inbox.ru', 'list.ru', 'bk.ru', 'zoznam.sk', 'seznam.cz',
    'hushmail.com', 'hushmail.me', 'gmx.co.uk', 'lycos.com', 'rediffmail.com',
    'mailfence.com', 'disroot.org', 'posteo.de', 'mailbox.org',
    // Netherlands / Belgium (Bee Flow's primary market)
    'ziggo.nl', 'kpnmail.nl', 'planet.nl', 'home.nl', 'hetnet.nl', 'chello.nl',
    'casema.nl', 'xs4all.nl', 'telfort.nl', 'online.nl', 'quicknet.nl',
    'upcmail.nl', 'zonnet.nl', 'tiscali.nl', 'wanadoo.nl',
    'telenet.be', 'skynet.be', 'scarlet.be',
    // Germany / France / other EU consumer ISPs
    'web.de', 't-online.de', 'freenet.de', 'orange.fr', 'wanadoo.fr', 'free.fr',
    'laposte.net', 'sfr.fr', 'libero.it', 'virgilio.it', 'tin.it', 'alice.it',
    'terra.es', 'wp.pl', 'o2.pl', 'interia.pl', 'onet.pl',
    // Disposable / throwaway (never an org)
    'mailinator.com', 'guerrillamail.com', 'guerrillamail.info', '10minutemail.com',
    'temp-mail.org', 'yopmail.com', 'trashmail.com', 'sharklasers.com',
    'getnada.com', 'maildrop.cc', 'throwawaymail.com', 'dispostable.com',
]);

const EXTRA_CONFIG_KEY = 'free_email_domains_extra';

/**
 * Normalise a value to a bare, lowercase email domain, or null if it can't be
 * one. Accepts either a bare domain ("gmail.com") or a full address
 * ("x@gmail.com").
 */
function normalizeDomain(value) {
    if (typeof value !== 'string') return null;
    let d = value.trim().toLowerCase();
    if (!d) return null;
    if (d.includes('@')) d = d.split('@').pop();
    // Strip a leading '@' or protocol-ish noise a paste might carry.
    d = d.replace(/^@+/, '');
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return null;
    return d;
}

/**
 * True if `domain` is a known free/public email provider. Accepts a bare domain
 * (e.g. "gmail.com") or a full address; non-strings and empty values are false.
 *
 * @param {string} domain
 * @param {Set<string>} [extra]  optional additional blocked domains (already
 *   normalised); use getEffectiveFreeEmailDomains() to obtain the merged set.
 */
function isFreeEmailDomain(domain, extra) {
    const d = normalizeDomain(domain);
    if (!d) return false;
    if (FREE_EMAIL_DOMAINS.has(d)) return true;
    if (extra && typeof extra.has === 'function' && extra.has(d)) return true;
    return false;
}

/**
 * Read the admin-managed extra domains from config. Returns a normalised,
 * de-duplicated array (built-in floor entries are dropped — they are implicit).
 * Never throws: a config/store failure degrades to the built-in floor only.
 */
async function getExtraFreeEmailDomains() {
    try {
        const configStore = require('../stores/configStore');
        const raw = await configStore.getConfig(EXTRA_CONFIG_KEY);
        if (!Array.isArray(raw)) return [];
        const out = [];
        const seen = new Set();
        for (const item of raw) {
            const d = normalizeDomain(item);
            if (!d || FREE_EMAIL_DOMAINS.has(d) || seen.has(d)) continue;
            seen.add(d);
            out.push(d);
        }
        return out;
    } catch (_e) {
        return [];
    }
}

/**
 * The effective blocklist: built-in floor ∪ admin extras. This is what all
 * runtime auto-join / domain-matching code should consult. Pass the returned
 * Set to resolveOrgByEmailDomain / isFreeEmailDomain so the check stays sync
 * and pure at the call site.
 */
async function getEffectiveFreeEmailDomains() {
    const extra = await getExtraFreeEmailDomains();
    if (!extra.length) return FREE_EMAIL_DOMAINS;
    return new Set([...FREE_EMAIL_DOMAINS, ...extra]);
}

module.exports = {
    FREE_EMAIL_DOMAINS,
    EXTRA_CONFIG_KEY,
    normalizeDomain,
    isFreeEmailDomain,
    getExtraFreeEmailDomains,
    getEffectiveFreeEmailDomains,
};
