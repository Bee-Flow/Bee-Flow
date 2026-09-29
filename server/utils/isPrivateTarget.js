// @typecheck
/**
 * isPrivateTarget — a sync, DNS-less literal-host SSRF pre-filter.
 *
 * Blocks targets that resolve into RFC1918, loopback, link-local, or private
 * IPv6 ranges. Two layers: the shared utils/ssrfGuard literal screen
 * (localhost, metadata hostnames, canonical private IPs), then the numeric
 * canonicalizer from core/customIntegrations/ssrfGuard so every exotic IPv4
 * spelling — short-form (127.1), decimal (2130706433), hex (0x7f000001),
 * octal (0177.0.0.1), ::ffff: mapped, 0.0.0.0/8, CGNAT 100.64/10, broadcast —
 * is treated as an IP, never as a DNS name.
 *
 * Deliberately sync/DNS-less: this is a literal-host pre-filter; the async
 * assertPublicHttpsTarget()/safeFetch() in utils/ssrfGuard is the full
 * resolver-backed check. Pure predicate: same input → same output, no I/O.
 *
 * Shared by the in-process SSRF checks and the module host API
 * (hostApi.net.isPrivateTarget) so both run ONE predicate.
 */

'use strict';

const { isPrivateHostname } = require('./ssrfGuard');
const { isForbiddenAddress, normalizeHostname } = require('../core/customIntegrations/ssrfGuard');

function isPrivateTarget(rawUrl) {
    let parsed;
    try { parsed = new URL(rawUrl); } catch { return true; }
    if (!/^https?:$/.test(parsed.protocol)) return true;
    if (isPrivateHostname(parsed.hostname)) return true;
    const { kind, canonical } = normalizeHostname(parsed.hostname);
    if (kind === 'name') return false;
    // Numeric-looking hosts that fail to canonicalize are blocked outright.
    return canonical === null || isForbiddenAddress(canonical);
}

module.exports = { isPrivateTarget };
