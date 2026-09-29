/**
 * /.well-known/* — public discovery documents (no auth, no license gate).
 *
 * Serves:
 *   • security.txt (RFC 9116) — where to report a vulnerability; carries the
 *     org's CRA disclosure policy + PSIRT contact once Compliance → Settings
 *     publishes them (security_txt_policy_enabled).
 *   • microsoft-identity-association.json — Azure AD publisher-domain
 *     verification.
 *
 * Azure verifies that the publisher owns a domain by fetching
 *   https://<domain>/.well-known/microsoft-identity-association.json
 * and checking that the app registration's Application (client) ID appears
 * under `associatedApplications`. Serving this lets Bee Flow Cloud's Azure app
 * ("Bee Flow - AI - Live") show a *verified* publisher on its consent screen —
 * required before end users can grant consent to a multitenant app.
 *
 * Cloud-only. This is meaningful only on Bee Flow Cloud (beeflow.nl), whose
 * domain is the publisher domain registered in Azure. Self-hosted installs run
 * on their own domains with their own Azure app registrations (if any), so they
 * must NOT advertise our application IDs — the route 404s there.
 *
 * App ID source (first non-empty wins):
 *   1. MICROSOFT_IDENTITY_ASSOCIATION_APP_IDS — comma-separated GUIDs. Use to
 *      associate more than one app (e.g. Live + Dev) or to pin an explicit
 *      value independent of the SSO config.
 *   2. The configured Microsoft SSO Application (client) ID
 *      (config.providers.microsoft.clientId) — the same Azure app users sign in
 *      with, so the file stays in sync with the SSO config automatically.
 *
 * No request schema, on purpose. Neither route takes a body, a path parameter
 * or a query parameter, and both are fetched by clients we do not control —
 * Azure's publisher-domain verifier and RFC 9116 scanners, some of which
 * append a cache-buster. The answer never depends on the query, so a 400 for
 * one would only turn "here is the file" into "there is no file".
 */

const express = require('express');
const log = require('../telemetry/log');
const router = express.Router();
const { loadConfig } = require('../auth/permissions');

// Which organisation's Compliance → Settings feed the optional Policy/Contact
// lines of security.txt (see disclosurePolicyLines below). The file is served
// per HOST, not per tenant, so exactly one org can speak for it: 'default'
// (the single-tenant / self-host convention used by compliance/scheduler.js),
// overridable for a multi-tenant cloud where the operating org has a real id.
const SECURITY_TXT_POLICY_ORG_ID = 'SECURITY_TXT_POLICY_ORG_ID';
const POLICY_MEMO_TTL_MS = 60_000;

// Azure Application (client) IDs are GUIDs.
const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Mirror license/index.js#deploymentMode: only 'cloud' | 'self-hosted' exist;
// the retired 'private-cloud' value normalises to self-hosted.
function deploymentMode() {
    const mode = process.env.DEPLOYMENT_MODE || 'cloud';
    return mode === 'private-cloud' ? 'self-hosted' : mode;
}

async function resolveAppIds() {
    const fromEnv = (process.env.MICROSOFT_IDENTITY_ASSOCIATION_APP_IDS || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    if (fromEnv.length) return fromEnv.filter(id => GUID_RE.test(id));

    try {
        const config = await loadConfig();
        const clientId = config?.providers?.microsoft?.clientId;
        if (clientId && GUID_RE.test(clientId)) return [clientId];
    } catch (_) { /* fall through — nothing to associate */ }
    return [];
}

router.get('/microsoft-identity-association.json', async (req, res) => {
    // Cloud-only — self-hosted installs must not advertise our Azure app IDs.
    if (deploymentMode() === 'self-hosted') {
        return res.status(404).json({ error: 'Not found' });
    }

    const appIds = await resolveAppIds();
    if (!appIds.length) {
        // No Microsoft SSO app configured yet — there is nothing to associate.
        return res.status(404).json({ error: 'Not configured' });
    }

    // Emit EXACTLY `application/json` — no `; charset=utf-8`. Azure AD's verifier
    // is strict about the Content-Type and the charset suffix trips its
    // "unexpected content type header value" check. express res.json()/res.send()
    // re-append the charset even after setHeader, so write the body via res.end.
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.end(JSON.stringify({
        associatedApplications: appIds.map(applicationId => ({ applicationId })),
    }));
});

// ── security.txt (RFC 9116) ──────────────────────────────────────────────────
//
// Without this file a researcher who finds something has no documented channel
// and ends up guessing an address, posting publicly, or dropping it — every one
// of which is worse than a coordinated report. nginx used to answer
// /.well-known/security.txt with the SPA shell (text/html), so scanners and
// humans alike saw a 200 that contained no contact at all.

// Turn a `host[:port]` config value into a domain we are willing to build an
// e-mail address on. Anything that is not a routable public name — localhost,
// a bare IP, an empty value — yields null: security@127.0.0.1 is not a mailbox
// anyone can reach, and publishing it is worse than publishing nothing.
function mailDomainFromHost(hostValue) {
    if (!hostValue) return null;
    const host = String(hostValue).trim()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')  // tolerate a full URL
        .split('/')[0]
        .replace(/:\d+$/, '')                     // strip :port
        .replace(/^www\./i, '')
        .toLowerCase();
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) return null;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;  // dotted quad, not a domain
    return host;
}

// Whose inbox the report lands in. Deliberately NOT hard-coded to Bee Flow's:
// a self-hosted install that advertises security@beeflow.nl sends reports about
// THEIR data and THEIR configuration to a company that cannot act on them, and
// leaves the operator unaware. So we derive the address from the deployment's
// own public host, exactly like the Microsoft route refuses to hand out our app
// IDs off-cloud.
//
// When nothing resolvable is configured this returns NULL and the route 404s.
// There used to be a `security@beeflow.nl` fallback here, and it was wrong in
// the most common case: the shipped defaults are CLIENT_PUBLIC_HOST=localhost,
// which is not a mailbox domain, so every local and every not-yet-configured
// self-hosted install published Bee Flow's address as its own security contact
// — the exact outcome the paragraph above says must not happen. Serving no
// file at all is the honest answer for an install that has not told us where
// it lives; a real deployment sets CLIENT_PUBLIC_HOST anyway, and
// SECURITY_TXT_CONTACT pins an address explicitly (a full URI — mailto:,
// https: — or a bare e-mail address).
function securityContact() {
    const explicit = (process.env.SECURITY_TXT_CONTACT || '').trim();
    if (explicit) return /^[a-z][a-z0-9+.-]*:/i.test(explicit) ? explicit : `mailto:${explicit}`;

    const domain = mailDomainFromHost(process.env.CLIENT_PUBLIC_HOST)
        || mailDomainFromHost(process.env.SERVER_PUBLIC_HOST);
    return domain ? `mailto:security@${domain}` : null;
}

// RFC 9116 §2.5.5 makes Expires REQUIRED and says a file whose Expires is in
// the past should be considered stale. A date baked into the source therefore
// silently invalidates itself on a schedule nobody is watching — every install
// that has not redeployed in a year starts serving an expired file. Computing
// it per request (now + 1 year, the maximum the RFC recommends) means it can
// never lapse while the service is up.
function expiresAt(now = new Date()) {
    const expires = new Date(now.getTime());
    expires.setUTCFullYear(expires.getUTCFullYear() + 1);
    return expires.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Canonical must name the URI the file is served from. We build it from the
// CONFIGURED public host, never from the request's Host header: that header is
// attacker-controlled, and reflecting it would let anyone who can reach this
// route have us publish their URL as our canonical location — cached, and
// treated by RFC 9116 consumers as the authoritative location of our policy.
// No configured host → omit the field (it is optional) rather than guess.
//
// It is validated with the SAME predicate as the contact address, not merely
// checked for emptiness. Otherwise the two disagree on the shipped defaults:
// `localhost:5176` is rejected as a mailbox domain but accepted as a URL, so
// the file went out advertising someone else's e-mail next to a Canonical of
// http://localhost:5176/… — self-contradicting, and useless to a researcher.
// The port is deliberately preserved: a deployment on a non-standard port is
// still reachable there, it just has to be a routable name.
function canonicalUrl() {
    const raw = (process.env.CLIENT_PUBLIC_HOST || '').trim();
    if (!mailDomainFromHost(raw)) return null;
    const protocol = process.env.CLIENT_PROTOCOL || 'https';
    return `${protocol}://${raw}/.well-known/security.txt`;
}

// ── CRA disclosure policy (Annex I Part II(5)) ──────────────────────────────
//
// The CRA check `CRA-AnnexI-II5-disclosure-policy` asks for a Policy line
// (where the coordinated-disclosure policy lives) and a contact the PSIRT
// actually reads. Both are org settings — `vuln_disclosure_url` and
// `psirt_contact_email` — and they only enter the file once the admin (or the
// check's auto-fix `cra_publish_security_txt_policy`) has set
// `security_txt_policy_enabled`. With the flag off the file is exactly what it
// was before this block existed.
//
// LIMITATION: security.txt is one file per host, so this reads ONE org —
// `SECURITY_TXT_POLICY_ORG_ID` or 'default'. On a multi-tenant cloud the
// operator sets that env var to the id of the organisation that runs the
// platform; other tenants' settings never reach the public file (publishing
// tenant A's policy URL as the host's would be wrong for every other tenant).
//
// The store is required lazily and every failure degrades to "no extra
// lines": a scanner must never be able to turn a DB hiccup into a 500 on a
// public discovery document, and requiring this router must stay free of the
// db layer (routes/wellKnown.test.js mocks only ../auth/permissions).

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function policyOrgId(env = process.env) {
    const explicit = (env[SECURITY_TXT_POLICY_ORG_ID] || '').trim();
    return explicit || 'default';
}

function httpUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    let u;
    try { u = new URL(value.trim()); } catch { return null; }
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
}

function mailtoContact(value) {
    if (typeof value !== 'string') return null;
    const addr = value.trim().replace(/^mailto:/i, '');
    return EMAIL_RE.test(addr) ? `mailto:${addr}` : null;
}

/** Pure: settings row → { policy, contact } (either may be null). */
function disclosureLinesFromSettings(settings) {
    if (!settings || settings.security_txt_policy_enabled !== true) return { policy: null, contact: null, enabled: false };
    return {
        enabled: true,
        policy: httpUrl(settings.vuln_disclosure_url),
        contact: mailtoContact(settings.psirt_contact_email),
    };
}

let _policyMemo = null;   // { at, value }
let _warnedPolicyRead = false;

async function disclosurePolicyLines(now = Date.now()) {
    if (_policyMemo && now - _policyMemo.at < POLICY_MEMO_TTL_MS) return _policyMemo.value;
    let value = { policy: null, contact: null, enabled: false };
    try {
        const complianceStore = require('../stores/complianceStore');
        const settings = await complianceStore.getSettings(policyOrgId());
        value = disclosureLinesFromSettings(settings);
    } catch (e) {
        if (!_warnedPolicyRead) {
            _warnedPolicyRead = true;
            log.warn(`[WellKnown] could not read compliance settings for security.txt (org ${policyOrgId()}): ${e?.message || e}`);
        }
    }
    _policyMemo = { at: now, value };
    return value;
}

function resetPolicyMemo() { _policyMemo = null; _warnedPolicyRead = false; }

let _warnedNoContact = false;

router.get('/security.txt', async (req, res) => {
    const disclosure = await disclosurePolicyLines();
    // The org's PSIRT address is the preferred contact when published: it is an
    // inbox somebody chose, where security@<host> is only derived. It also
    // makes the file servable on an install whose host yields no mailbox.
    const derived = securityContact();
    const contacts = [];
    for (const c of [disclosure.contact, derived]) {
        if (c && !contacts.some(x => x.toLowerCase() === c.toLowerCase())) contacts.push(c);
    }
    const contact = contacts[0] || null;
    if (!contact) {
        // Once per process — an operator who has not configured a public host
        // should hear about it, but a scanner must not be able to fill the log.
        if (!_warnedNoContact) {
            _warnedNoContact = true;
            log.warn('[WellKnown] /.well-known/security.txt is not being served: no SECURITY_TXT_CONTACT and no routable CLIENT_PUBLIC_HOST/SERVER_PUBLIC_HOST to derive one from.');
        }
        return res.status(404).json({ error: 'Not configured' });
    }

    const lines = [
        '# Found a security problem in this Bee Flow install? Tell us before',
        '# you tell anyone else — we will confirm receipt and keep you posted.',
        ...contacts.map(c => `Contact: ${c}`),
        `Expires: ${expiresAt()}`,
        'Preferred-Languages: nl, en',
    ];
    const canonical = canonicalUrl();
    if (canonical) lines.push(`Canonical: ${canonical}`);
    if (disclosure.policy) lines.push(`Policy: ${disclosure.policy}`);

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    // A day of caching keeps Expires roughly a year out at all times while
    // still absorbing scanner traffic.
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(`${lines.join('\n')}\n`);
});

module.exports = router;
module.exports._test = { mailDomainFromHost, securityContact, expiresAt, canonicalUrl, disclosureLinesFromSettings, policyOrgId, resetPolicyMemo };
