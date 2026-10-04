/**
 * The server-wide rule for what ORGANISATION admins may install in their MCP
 * library. Set by the server administrator (super-admin), read on every
 * install AND on every tool call, so tightening it also stops what is already
 * installed: a policy that only guarded the install button would leave every
 * server installed under the old rule running.
 *
 * Stored under config key `mcp_org_policy` as `{ remote, allowedHosts }`:
 *
 *   remote: 'off'       org admins install nothing; org-installed servers stop
 *           'official'  only the curated catalogue's vendor endpoints (default)
 *           'allowlist' official endpoints + hosts the server admin listed
 *           'any'       any public HTTPS endpoint
 *
 * What none of the modes allow: running a process on this server (org
 * libraries are remote-only, see customMcpClient.js), reaching a private or
 * loopback address (ssrfGuard), plain http, or credentials in the URL. Those
 * are not policy, they are invariants.
 *
 * The default is 'official' and not 'any' because an MCP server receives
 * whatever an agent sends it: in a privacy product the server admin should
 * opt in to letting org admins choose arbitrary destinations.
 */

const { officialHosts } = require('./catalog');
const deps = require('./deps');

const POLICY_KEY = 'mcp_org_policy';
const REMOTE_MODES = Object.freeze(['off', 'official', 'allowlist', 'any']);
const DEFAULT_POLICY = Object.freeze({ remote: 'official', allowedHosts: Object.freeze([]) });
const MAX_ALLOWED_HOSTS = 200;

// A bare DNS name, optionally with one leading "*." wildcard label.
// No ports, no paths, no IP literals: an IP literal would bypass the
// name-based reasoning below and the SSRF guard owns addresses anyway.
const HOST_PATTERN_RE = /^(\*\.)?(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** Lower-case, trim, drop a trailing dot. Returns null for anything that is not a host pattern. */
function normalizeHostPattern(raw) {
    if (typeof raw !== 'string') return null;
    const s = raw.trim().toLowerCase().replace(/\.$/, '');
    return HOST_PATTERN_RE.test(s) ? s : null;
}

/**
 * Coerce whatever is stored into a valid policy. Unknown or broken values
 * fall back to the DEFAULT, never to something more permissive.
 */
function normalizePolicy(raw) {
    let value = raw;
    if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch (_) { value = null; }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_POLICY, allowedHosts: [] };
    const remote = REMOTE_MODES.includes(value.remote) ? value.remote : DEFAULT_POLICY.remote;
    const hosts = Array.isArray(value.allowedHosts) ? value.allowedHosts : [];
    const allowedHosts = [...new Set(hosts.map(normalizeHostPattern).filter(Boolean))].slice(0, MAX_ALLOWED_HOSTS);
    return { remote, allowedHosts };
}

function hostMatches(pattern, host) {
    if (pattern.startsWith('*.')) {
        const base = pattern.slice(2);
        return host.endsWith(`.${base}`);
    }
    return host === pattern;
}

/**
 * May an org library use this endpoint under this policy?
 *
 * Returns { allowed: true, official } or { allowed: false, reason } where
 * reason is one of: 'policy_off', 'invalid_url', 'not_https', 'not_official',
 * 'host_not_allowed'. Name-level only: whether the name resolves to a public
 * address is the SSRF guard's job, at connect time.
 */
function checkUrl(policy, rawUrl) {
    const p = normalizePolicy(policy);
    if (p.remote === 'off') return { allowed: false, reason: 'policy_off' };
    let u;
    try { u = new URL(String(rawUrl || '')); } catch (_) { return { allowed: false, reason: 'invalid_url' }; }
    if (u.protocol !== 'https:') return { allowed: false, reason: 'not_https' };
    if (u.username || u.password) return { allowed: false, reason: 'invalid_url' };
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    const official = officialHosts().has(host);
    if (official) return { allowed: true, official: true };
    if (p.remote === 'official') return { allowed: false, reason: 'not_official' };
    if (p.remote === 'allowlist') {
        return p.allowedHosts.some(pattern => hostMatches(pattern, host))
            ? { allowed: true, official: false }
            : { allowed: false, reason: 'host_not_allowed' };
    }
    return { allowed: true, official: false }; // 'any'
}

/** Can an org admin type in an endpoint of their own (not just pick from the catalogue)? */
function allowsCustomUrls(policy) {
    const p = normalizePolicy(policy);
    return p.remote === 'allowlist' || p.remote === 'any';
}

async function getPolicy() {
    try {
        return normalizePolicy(await deps.configStore().getConfig(POLICY_KEY));
    } catch (_) {
        // The store being unreachable must not widen anything: the default is
        // the narrowest mode that still lets the official catalogue run.
        return { ...DEFAULT_POLICY, allowedHosts: [] };
    }
}

async function setPolicy(next) {
    const clean = normalizePolicy(next);
    await deps.configStore().setConfig(POLICY_KEY, clean);
    return clean;
}

module.exports = {
    POLICY_KEY,
    REMOTE_MODES,
    DEFAULT_POLICY,
    MAX_ALLOWED_HOSTS,
    normalizeHostPattern,
    normalizePolicy,
    checkUrl,
    allowsCustomUrls,
    getPolicy,
    setPolicy,
};
