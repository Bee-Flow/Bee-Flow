// @typecheck strict
'use strict';

/**
 * allowedLinkHosts: the web hosts an `open_url` step may open when its address is a formula (`urlExpr`).
 *
 * A literal `url` is checked when the app is saved and needs no list. A formula is only known when the
 * step runs, so the person who owns the app says which hosts it may send a visitor to. HUMAN-set, like
 * `aiBrowsing`: the builder tools have no way to write it, because a list the builder could grow would
 * be no list at all. An absent or empty list means formula addresses never open.
 *
 * Entries are bare host names (no scheme, port, path or wildcard), lowercased, de-duplicated, at most
 * LIMITS.MAX_ALLOWED_LINK_HOSTS of them. No pattern matching: the character check is a loop.
 */

const { LIMITS } = require('../componentSpecs/limits');

const MAX_HOST_LEN = 253;
const HOST_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789.-';

/** True for a name made only of host characters, with no empty label and no dash at a label's edge. */
/** @param {string} host */
function isBareHost(host) {
    if (!host || host.length > MAX_HOST_LEN) return false;
    for (const ch of host) if (!HOST_CHARS.includes(ch)) return false;
    return host.split('.').every((/** @type {string} */ label) => label !== '' && !label.startsWith('-') && !label.endsWith('-'));
}

/**
 * @param {unknown} value
 * @param {(code: string, path: string, message: string) => void} push
 */
function canon(value, push) {
    if (!Array.isArray(value)) {
        push('allowedLinkHosts.invalid', 'allowedLinkHosts', 'allowedLinkHosts must be a list of host names — dropped.');
        return undefined;
    }
    /** @type {string[]} */
    const hosts = [];
    value.forEach((entry, i) => {
        const host = typeof entry === 'string' ? entry.trim().toLowerCase() : '';
        if (!isBareHost(host)) {
            push('allowedLinkHosts.entry_invalid', `allowedLinkHosts[${i}]`, 'Each host must be a bare host name such as "example.com" (no https://, port, path or wildcard) — dropped.');
        } else if (!hosts.includes(host)) hosts.push(host);
    });
    if (hosts.length > LIMITS.MAX_ALLOWED_LINK_HOSTS) {
        push('allowedLinkHosts.too_many', 'allowedLinkHosts', `At most ${LIMITS.MAX_ALLOWED_LINK_HOSTS} hosts are kept.`);
        hosts.length = LIMITS.MAX_ALLOWED_LINK_HOSTS;
    }
    return hosts.length ? hosts : undefined;
}

/**
 * @param {unknown} value
 * @param {{ pushE: (finding: Record<string, string>) => void }} ctx
 */
function validate(value, { pushE }) {
    const ok = Array.isArray(value) && value.length <= LIMITS.MAX_ALLOWED_LINK_HOSTS && value.every((h) => typeof h === 'string' && isBareHost(h));
    if (!ok) {
        pushE({
            code: 'shape.allowed_link_hosts', severity: 'error', path: 'allowedLinkHosts',
            message: `allowedLinkHosts must be a list of at most ${LIMITS.MAX_ALLOWED_LINK_HOSTS} bare host names.`,
            hint: 'Write "example.com", not "https://example.com/page". Only a person sets this list, in the app settings.',
        });
    }
}

module.exports = {
    key: 'allowedLinkHosts',
    since: 3,
    canon,
    validate,
    public: false,
    shape: 'string[] of bare host names, at most 50',
    description: 'Hosts that an open_url formula may open, set by a person only. '
        + 'A formula address (urlExpr) opens only when it is https and its host is on this list, otherwise the step fails. '
        + 'The builder cannot write it: ask the app owner to add hosts in the app settings.',
};
