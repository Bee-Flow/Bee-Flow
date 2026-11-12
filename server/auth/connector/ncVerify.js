// @typecheck strict
/**
 * Nextcloud Connector: proof that the caller's Nextcloud is the instance it
 * claims to be (the capabilities round-trip every bootstrap and diagnose call
 * starts with). Split out of auth/connectorBootstrap.js, which re-exports it.
 */

const { stableInstanceIdFallback } = require('../orgNaming');
const { nextcloudFetch } = require('../../utils/nextcloudTarget');

// Spoofing defence: GET <ncBaseUrl>/ocs/v2.php/cloud/capabilities and verify
// the instance id round-trips. Necessary but not sufficient — an attacker
// can host a fake NC that returns whatever instance id they put in the
// header. The adoption gate (pending_nc_bindings + admin approval) closes
// that gap.
//
// The base URL comes from an unauthenticated request header, so the fetch goes
// through nextcloudFetch (the same SSRF gate as every other Nextcloud call):
// private, loopback and metadata targets are refused, and every redirect hop
// is re-checked at connect time. A self-host whose Nextcloud sits on a LAN
// address lists that host in NEXTCLOUD_ALLOW_PRIVATE_HOSTS (or sets it to 1).
// A refusal surfaces as "unreachable", the same branch as any other
// connection failure. The caller is unauthenticated: it is told the category
// only (verifyFailureCategory), never the status, error text or body.
/**
 * A failed round-trip. `category` is what an unauthenticated caller is told:
 * 'unreachable' (no answer, or an address this server does not call) or
 * 'mismatch' (an answer that is not this Nextcloud's capabilities). The
 * message is for the server log only.
 */
class NcVerifyError extends Error {
    /** @param {'unreachable' | 'mismatch'} category @param {string} message */
    constructor(category, message) {
        super(message);
        this.category = category;
    }
}

/**
 * The capabilities address under `ncBaseUrl`: scheme, host and path only. A
 * base with a query, a fragment or credentials is refused, so the fixed
 * suffix always stays the path.
 * @param {string} ncBaseUrl
 */
function capabilitiesUrl(ncBaseUrl) {
    let base;
    try { base = new URL(String(ncBaseUrl)); } catch { throw new NcVerifyError('unreachable', 'NC capabilities unreachable: the base URL is not a URL'); }
    if (base.search || base.hash || String(ncBaseUrl).includes('?') || String(ncBaseUrl).includes('#') || base.username || base.password) {
        throw new NcVerifyError('unreachable', 'NC capabilities unreachable: the base URL carries a query, fragment or credentials');
    }
    let path = base.pathname;
    while (path.endsWith('/')) path = path.slice(0, -1);
    return `${base.origin}${path}/ocs/v2.php/cloud/capabilities?format=json`;
}

/**
 * @param {string} ncBaseUrl
 * @param {string} expectedInstanceId
 */
async function verifyNcInstance(ncBaseUrl, expectedInstanceId) {
    const url = capabilitiesUrl(ncBaseUrl);
    let res;
    try {
        res = await nextcloudFetch(url, {
            headers: { 'OCS-APIRequest': 'true', 'Accept': 'application/json' },
            signal: AbortSignal.timeout(8000),
        });
    } catch (e) {
        throw new NcVerifyError('unreachable', `NC capabilities unreachable: ${e.message}`);
    }
    if (!res.ok) throw new NcVerifyError('mismatch', `NC capabilities HTTP ${res.status}`);
    /** @type {{ ocs?: { data?: Record<string, any> } }} */
    let body;
    try {
        body = await res.json();
    } catch {
        throw new NcVerifyError('mismatch', 'NC capabilities answer is not JSON');
    }
    const data = body?.ocs?.data;
    if (!data?.version) throw new NcVerifyError('mismatch', 'NC capabilities returned no version data');
    const reportedId = data?.capabilities?.theming?.instanceid
        || data?.capabilities?.core?.instanceid
        || stableInstanceIdFallback(ncBaseUrl, data?.capabilities?.theming?.name);
    if (reportedId !== expectedInstanceId) {
        throw new NcVerifyError('mismatch', `NC instance id mismatch: header=${expectedInstanceId} server=${reportedId}`);
    }
    return {
        themingName: data?.capabilities?.theming?.name || 'Nextcloud',
        ncVersion: data?.version?.string || 'unknown',
    };
}

/**
 * The category of a verifyNcInstance failure ('unreachable' for anything
 * that is not an NcVerifyError).
 * @param {unknown} err
 * @returns {'unreachable' | 'mismatch'}
 */
function verifyFailureCategory(err) {
    return err instanceof NcVerifyError ? err.category : 'unreachable';
}

module.exports = { stableInstanceIdFallback, verifyNcInstance, verifyFailureCategory, NcVerifyError };
