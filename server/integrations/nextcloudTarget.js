/**
 * Nextcloud target validation — the SSRF gate for user-supplied Nextcloud URLs.
 *
 * A user can save their own Nextcloud base URL alongside their app password
 * (Settings → Verbindingen). Every subsequent call attaches their Basic
 * credentials, so an unvalidated URL turns the server into a credential-bearing
 * probe of its own network. Previously the only check was "is it http(s)".
 *
 * Policy:
 *   - Private / loopback / link-local targets are REFUSED by default.
 *   - NEXTCLOUD_ALLOW_PRIVATE_HOSTS=1 re-allows RFC1918 + loopback, because
 *     self-hosted installs legitimately run Nextcloud on a LAN address. This is
 *     a deployment-level decision, not a per-user one.
 *   - Cloud metadata endpoints stay blocked in BOTH modes. There is no
 *     legitimate Nextcloud at 169.254.169.254, and that is the one target where
 *     a blind SSRF turns directly into cloud credentials.
 *
 * Enforced twice on purpose: at save time (fast, clear error) and again at use
 * time in nextcloudClient (rows saved before this existed, and DNS that changes
 * after the save). Use-time protection comes from ssrfGuard.safeFetch, which
 * also re-resolves on every connect and redirect hop (DNS-rebinding defence).
 */

const { isPrivateHostname, safeFetch } = require('../utils/ssrfGuard');

// Refused regardless of NEXTCLOUD_ALLOW_PRIVATE_HOSTS.
const METADATA_HOSTNAMES = new Set([
    'metadata.google.internal',
    'metadata.goog',
    'instance-data',
    'metadata',
]);
const LINK_LOCAL_V4_RE = /^169\.254(?:\.\d{1,3}){2}$/;
// fe80::/10 link-local and the IMDS v6 address.
const LINK_LOCAL_V6_RE = /^\[?(?:fe[89ab][0-9a-f]:|fd00:ec2::254)/i;

const MAX_URL_LENGTH = 512;

function allowPrivateHosts() {
    return process.env.NEXTCLOUD_ALLOW_PRIVATE_HOSTS === '1';
}

/** Metadata endpoints — never reachable, whatever the deployment allows. */
function isMetadataHost(hostname) {
    const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    return METADATA_HOSTNAMES.has(host)
        || LINK_LOCAL_V4_RE.test(host)
        || LINK_LOCAL_V6_RE.test(host);
}

/**
 * Throws when `rawUrl` is not an acceptable Nextcloud target.
 * The thrown message is user-facing: it names the env flag so a self-hoster
 * knows exactly why their LAN address was refused.
 */
function assertAllowedNextcloudHost(rawUrl) {
    let parsed;
    try {
        parsed = new URL(String(rawUrl));
    } catch (_) {
        throw new Error('Enter a valid Nextcloud URL (e.g. https://cloud.example.com)');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('The Nextcloud URL must start with http:// or https://');
    }
    // Credentials in the URL would be silently carried into every request.
    if (parsed.username || parsed.password) {
        throw new Error('The Nextcloud URL must not contain a username or password');
    }
    if (isMetadataHost(parsed.hostname)) {
        throw new Error('That address is not a valid Nextcloud host.');
    }
    if (isPrivateHostname(parsed.hostname) && !allowPrivateHosts()) {
        throw new Error(
            'That Nextcloud URL points to a private or local network address. '
            + 'If this is a self-hosted install on your own network, set '
            + 'NEXTCLOUD_ALLOW_PRIVATE_HOSTS=1 on the server to allow it.'
        );
    }
    return parsed;
}

/** Boolean form for call sites that pick their own error shape. */
function isAllowedNextcloudHost(rawUrl) {
    try {
        assertAllowedNextcloudHost(rawUrl);
        return true;
    } catch (_) {
        return false;
    }
}

/**
 * fetch() for every Nextcloud call — validates the target first, then routes:
 *
 *   default            → ssrfGuard.safeFetch (blocks private addresses at
 *                        connect time, so DNS rebinding and redirect hops are
 *                        covered too).
 *   ALLOW_PRIVATE_HOSTS → plain fetch, because the whole point of the flag is
 *                        that the LAN target is intended. Metadata endpoints
 *                        are still rejected by the assert above.
 *
 * Use-time validation matters independently of save-time validation: rows
 * written before this guard existed are already in the database.
 */
async function nextcloudFetch(url, opts = {}) {
    assertAllowedNextcloudHost(url);
    if (allowPrivateHosts()) return fetch(url, opts);
    return safeFetch(url, opts);
}

module.exports = {
    assertAllowedNextcloudHost,
    isAllowedNextcloudHost,
    isMetadataHost,
    allowPrivateHosts,
    nextcloudFetch,
    MAX_URL_LENGTH,
};
