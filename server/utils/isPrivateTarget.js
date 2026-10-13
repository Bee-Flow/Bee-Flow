// @typecheck
/**
 * isPrivateTarget — a sync, DNS-less literal-host SSRF pre-filter.
 *
 * Blocks non-http(s) URLs and hosts that are, in any spelling, a private /
 * internal target: localhost, the metadata hostname, RFC1918, loopback,
 * link-local, CGNAT, 0.0.0.0/8, broadcast, ULA, and every exotic IPv4 form
 * (short-form 127.1, decimal 2130706433, hex 0x7f000001, octal 0177.0.0.1,
 * ::ffff: mapped), which are treated as IPs, never as DNS names.
 *
 * A thin adapter over the canonical host screen (core/http/ssrfGuard.js,
 * reached through utils/ssrfGuard.isPrivateHostname). Deliberately
 * sync/DNS-less: the resolver-backed checks are safeFetch() and
 * assertPublicHttpsTarget(). Pure predicate: same input, same output, no I/O.
 *
 * Shared by the in-process SSRF checks and the module host API
 * (hostApi.net.isPrivateTarget) so both run ONE predicate.
 */

'use strict';

// utils/ssrfGuard.isPrivateHostname IS the canonical isBlockedHost; going through
// it keeps this platform module from reaching into core/ (layering.test.js).
const { isPrivateHostname } = require('./ssrfGuard');

function isPrivateTarget(rawUrl) {
    let parsed;
    try { parsed = new URL(rawUrl); } catch { return true; }
    if (!/^https?:$/.test(parsed.protocol)) return true;
    return isPrivateHostname(parsed.hostname);
}

module.exports = { isPrivateTarget };
