// @typecheck strict
/**
 * Nextcloud Connector: proof that the caller's Nextcloud is the instance it
 * claims to be (the capabilities round-trip every bootstrap and diagnose call
 * starts with). Split out of auth/connectorBootstrap.js, which re-exports it.
 */

const { ncHostFromUrl } = require('../orgNaming');
const { nextcloudFetch } = require('../../utils/nextcloudTarget');

// Stable fallback id for Nextclouds that expose neither theming.instanceid nor
// core.instanceid. MUST stay byte-identical to the connector's copy in
// nextcloud-connector/src/bootstrap.js so the id the connector sends in
// X-Beeflow-NC-Instance-Id matches the value we re-derive here. Keyed on the NC
// host (not the NC version) so it doesn't drift across upgrades and silently
// re-provision a duplicate org.
/**
 * @param {string} ncBaseUrl
 * @param {string | null | undefined} themingName
 */
function stableInstanceIdFallback(ncBaseUrl, themingName) {
    const host = ncHostFromUrl(ncBaseUrl);
    if (host) return `nc-host:${host}`;
    return `nc:${themingName || 'nextcloud'}`;
}

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
// address opts in with NEXTCLOUD_ALLOW_PRIVATE_HOSTS=1. A refusal surfaces as
// "unreachable", the same branch as any other connection failure.
/**
 * @param {string} ncBaseUrl
 * @param {string} expectedInstanceId
 */
async function verifyNcInstance(ncBaseUrl, expectedInstanceId) {
    const url = `${ncBaseUrl}/ocs/v2.php/cloud/capabilities?format=json`;
    let res;
    try {
        res = await nextcloudFetch(url, {
            headers: { 'OCS-APIRequest': 'true', 'Accept': 'application/json' },
            signal: AbortSignal.timeout(8000),
        });
    } catch (e) {
        throw new Error(`NC capabilities unreachable: ${e.message}`);
    }
    if (!res.ok) throw new Error(`NC capabilities HTTP ${res.status}`);
    const body = /** @type {{ ocs?: { data?: Record<string, any> } }} */ (await res.json());
    const data = body?.ocs?.data;
    if (!data?.version) throw new Error('NC capabilities returned no version data');
    const reportedId = data?.capabilities?.theming?.instanceid
        || data?.capabilities?.core?.instanceid
        || stableInstanceIdFallback(ncBaseUrl, data?.capabilities?.theming?.name);
    if (reportedId !== expectedInstanceId) {
        throw new Error(`NC instance id mismatch: header=${expectedInstanceId} server=${reportedId}`);
    }
    return {
        themingName: data?.capabilities?.theming?.name || 'Nextcloud',
        ncVersion: data?.version?.string || 'unknown',
    };
}

module.exports = { stableInstanceIdFallback, verifyNcInstance };
