/**
 * CRA Annex I Part II(5) / Art. 13(6) — coordinated vulnerability disclosure
 * policy published.
 *
 * A researcher who finds something must be able to discover HOW to report it
 * without guessing. RFC 9116 gives that a fixed address —
 * /.well-known/security.txt with a Contact, an Expires and a link to the
 * disclosure policy — and routes/wellKnown.js already serves the file for
 * this deployment. This check is HYBRID:
 *   • automated — the public file is fetched through the SSRF-guarded probe
 *     (lib/urlProbe.js) and parsed: served? contact present? not expired?
 *     Policy line present?
 *   • attested  — `settings.vuln_disclosure_url` is where the admin says the
 *     policy lives; when it is set the probe also checks it answers 2xx.
 *
 * Verdicts: pass when the file is served with a valid Expires AND (a Policy
 * line is published OR the policy URL is attested and reachable); warn when
 * the file is served but no policy is linked or the attested URL does not
 * answer; fail when the file is missing or carries no contact.
 *
 * autoFix `cra_publish_security_txt_policy` flips
 * `settings.security_txt_policy_enabled`, after which wellKnown.js appends
 * `Policy: <vuln_disclosure_url>` (and `Contact: mailto:<psirt_contact_email>`)
 * to the served file. The fix is refused while no policy URL is recorded — an
 * empty Policy line would be worse than none.
 *
 * Evidence carries counts and booleans about contacts, never the addresses
 * themselves (BFSF-441). Public URLs of the organisation are fine.
 * Also counts for NIS2 Art. 21(2)(e) and ISO 27001 A.8.8.
 */

const complianceStore = require('../../../stores/complianceStore');
const urlProbe = require('../../lib/urlProbe');
const { isPrivateHostname } = require('../../../utils/ssrfGuard');

const SECURITY_TXT_PATH = '/.well-known/security.txt';

/** Parse an http(s) URL; null for anything else (mailto:, garbage, empty). */
function _httpUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    let u;
    try { u = new URL(value.trim()); } catch { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u;
}

/**
 * Where the deployment is reachable from the outside — the org's
 * `public_base_url` first, the platform's CLIENT_PUBLIC_HOST otherwise. A
 * host the probe would refuse anyway (localhost, RFC 1918, bare IPs) yields
 * null: there is nothing an auditor could fetch there either.
 */
function _publicBaseUrl(settings, env = process.env) {
    const fromSettings = _httpUrl(settings?.public_base_url);
    if (fromSettings && !isPrivateHostname(fromSettings.hostname)) return fromSettings.origin;
    const rawHost = typeof env.CLIENT_PUBLIC_HOST === 'string' ? env.CLIENT_PUBLIC_HOST.trim() : '';
    if (!rawHost) return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawHost) ? rawHost : `${env.CLIENT_PROTOCOL || 'https'}://${rawHost}`;
    const fromEnv = _httpUrl(withScheme);
    if (!fromEnv || isPrivateHostname(fromEnv.hostname)) return null;
    return fromEnv.origin;
}

function _sameUrl(a, b) {
    const ua = _httpUrl(a);
    const ub = _httpUrl(b);
    if (!ua || !ub) return false;
    const norm = u => `${u.origin}${u.pathname.replace(/\/+$/, '')}${u.search}`.toLowerCase();
    return norm(ua) === norm(ub);
}

module.exports = {
    id: 'CRA-AnnexI-II5-disclosure-policy',
    regulation: 'CRA',
    article: 'Annex I Part II(5)',
    frameworks: [
        { regulation: 'NIS2', ref: 'Art. 21(2)(e)' },
        { regulation: 'ISO27001', ref: 'A.8.8' },
    ],
    severity: 'high',
    scope: 'global',
    verification: 'hybrid',
    titleKey: 'compliance.check_cra_disclosure_policy_title',
    descriptionKey: 'compliance.check_cra_disclosure_policy_desc',
    remediationKey: 'compliance.check_cra_disclosure_policy_fix',
    remediationLink: 'admin/compliance/settings',
    autoFixId: 'cra_publish_security_txt_policy',

    async evaluate(orgId) {
        const settings = await complianceStore.getSettings(orgId) || {};
        if (settings.framework_relevance?.cra === 'not_relevant') {
            return {
                status: 'not_applicable',
                evidence: { relevance: 'not_relevant' },
                details: 'The CRA was marked not relevant for this organisation.',
            };
        }

        const attestedPolicy = _httpUrl(settings.vuln_disclosure_url);
        const psirtSet = typeof settings.psirt_contact_email === 'string' && /@/.test(settings.psirt_contact_email);
        const policyEnabled = settings.security_txt_policy_enabled === true;
        const baseUrl = _publicBaseUrl(settings);
        const securityTxtUrl = baseUrl ? `${baseUrl}${SECURITY_TXT_PATH}` : null;

        const evidence = {
            public_base_url: baseUrl,
            security_txt_url: securityTxtUrl,
            served: false,
            http_status: null,
            probe_error: null,
            contact_count: 0,
            expires: null,
            expires_valid: false,
            expired: null,
            policy_published: false,
            policy_url: null,
            policy_url_matches_attested: false,
            attested_policy_url: attestedPolicy ? attestedPolicy.toString() : null,
            attested_policy_status: null,
            attested_policy_reachable: null,
            psirt_contact_set: psirtSet,
            security_txt_policy_enabled: policyEnabled,
        };

        // Second leg (attested URL) — probed regardless of the first, so the
        // admin sees a dead policy link even while security.txt is missing.
        if (attestedPolicy) {
            const p = await urlProbe.probe(attestedPolicy.toString());
            evidence.attested_policy_status = p.status;
            evidence.attested_policy_reachable = p.ok;
            if (!p.ok && p.error) evidence.probe_error = evidence.probe_error || `policy: ${p.error}`;
        }

        if (!securityTxtUrl) {
            const hint = 'No public base URL is known for this deployment — record it under Compliance → Settings (or set CLIENT_PUBLIC_HOST) so the published file can be verified.';
            if (attestedPolicy) {
                return {
                    status: 'warn',
                    evidence,
                    details: `The disclosure policy URL is attested${evidence.attested_policy_reachable === false ? ' but does not answer 2xx' : ''}, yet the served security.txt cannot be verified. ${hint}`,
                };
            }
            return {
                status: 'fail',
                evidence,
                details: `No disclosure policy is recorded and the served security.txt cannot be verified. ${hint} Then enter the disclosure-policy URL and PSIRT contact.`,
            };
        }

        const probe = await urlProbe.probe(securityTxtUrl);
        evidence.http_status = probe.status;
        if (!probe.ok && probe.error) evidence.probe_error = `security.txt: ${probe.error}`;

        if (!probe.ok) {
            const why = probe.status ? `answered HTTP ${probe.status}` : `could not be fetched (${probe.error || 'unknown error'})`;
            if (probe.status === 404 || probe.status === 410) {
                return {
                    status: 'fail',
                    evidence,
                    details: `${securityTxtUrl} ${why} — no security contact is published, so a researcher has no documented way to report a vulnerability. Set a PSIRT contact under Compliance → Settings (or SECURITY_TXT_CONTACT) and apply the fix.`,
                };
            }
            return {
                status: attestedPolicy && evidence.attested_policy_reachable ? 'warn' : 'fail',
                evidence,
                details: `${securityTxtUrl} ${why}.${attestedPolicy && evidence.attested_policy_reachable ? ' The attested policy URL does answer, so the policy itself is reachable — restore the well-known file.' : ' Neither the well-known file nor an attested policy URL proves a disclosure channel.'}`,
            };
        }

        const parsed = urlProbe.parseSecurityTxt(probe.snippet || '');
        evidence.contact_count = parsed.contact.length;
        evidence.expires = parsed.expires;
        evidence.expires_valid = parsed.expires_valid;
        evidence.expired = parsed.expired;
        evidence.policy_published = parsed.policies.length > 0;
        evidence.policy_url = parsed.policy;
        evidence.policy_url_matches_attested = !!attestedPolicy && parsed.policies.some(p => _sameUrl(p, attestedPolicy.toString()));

        if (parsed.contact.length === 0) {
            return {
                status: 'fail',
                evidence,
                details: `${securityTxtUrl} is served but contains no Contact field — RFC 9116 requires at least one. Set the PSIRT contact under Compliance → Settings (or SECURITY_TXT_CONTACT).`,
            };
        }
        evidence.served = true;

        const warnings = [];
        if (!parsed.expires_valid) warnings.push('the file has no valid Expires field (required by RFC 9116 §2.5.5)');
        else if (parsed.expired) warnings.push(`the file expired on ${String(parsed.expires).slice(0, 10)} — consumers treat it as stale`);

        const policyProven = evidence.policy_published || (attestedPolicy && evidence.attested_policy_reachable !== false);
        if (!evidence.policy_published && !attestedPolicy) {
            warnings.push('no Policy line is published and no disclosure-policy URL is attested — enter the URL under Compliance → Settings, then apply the fix to publish it');
        } else if (!evidence.policy_published && attestedPolicy && evidence.attested_policy_reachable === false) {
            warnings.push(`the attested disclosure-policy URL answers HTTP ${evidence.attested_policy_status ?? 'error'} and is not published in security.txt`);
        } else if (attestedPolicy && evidence.attested_policy_reachable === false) {
            warnings.push(`the attested disclosure-policy URL answers HTTP ${evidence.attested_policy_status ?? 'error'}`);
        } else if (!evidence.policy_published && attestedPolicy && !policyEnabled) {
            warnings.push('the disclosure-policy URL is attested but not yet published in security.txt — apply the fix to add the Policy line');
        }

        if (!policyProven || warnings.length) {
            return { status: 'warn', evidence, details: `${securityTxtUrl} is served with ${parsed.contact.length} contact(s), but ${warnings.join('; ')}.` };
        }
        return {
            status: 'pass',
            evidence,
            details: `${securityTxtUrl} is served with ${parsed.contact.length} contact(s), a valid Expires${evidence.policy_published ? ' and a Policy line' : ''}${attestedPolicy ? `; the attested disclosure policy answers HTTP ${evidence.attested_policy_status}` : ''}.`,
        };
    },

    /**
     * One-click remediation: publish the attested policy URL (and PSIRT
     * contact) in the served security.txt by enabling the org setting that
     * routes/wellKnown.js reads. Refused while no policy URL is recorded.
     * The returned object lands in the evidence chain — no e-mail address
     * in it, only booleans and the public policy URL.
     */
    async autoFix(orgId, { actorId } = {}) {
        const settings = await complianceStore.getSettings(orgId) || {};
        const policy = _httpUrl(settings.vuln_disclosure_url);
        const psirtSet = typeof settings.psirt_contact_email === 'string' && /@/.test(settings.psirt_contact_email);
        if (!policy) {
            return {
                changed: 0,
                summary: 'No disclosure-policy URL is recorded yet — enter it under Compliance → Settings first; an empty Policy line cannot be published.',
                policy_url: null,
                psirt_contact_set: psirtSet,
                actor_id: actorId || null,
            };
        }
        if (settings.security_txt_policy_enabled === true) {
            return {
                changed: 0,
                summary: 'security.txt already publishes the disclosure policy.',
                policy_url: policy.toString(),
                psirt_contact_set: psirtSet,
                actor_id: actorId || null,
            };
        }
        await complianceStore.saveSettings(orgId, { security_txt_policy_enabled: true });
        return {
            changed: 1,
            summary: `Enabled publication of the disclosure policy in /.well-known/security.txt (Policy: ${policy.toString()}${psirtSet ? ' + PSIRT contact' : ''}).`,
            setting: 'security_txt_policy_enabled',
            before: settings.security_txt_policy_enabled === true,
            after: true,
            policy_url: policy.toString(),
            psirt_contact_set: psirtSet,
            actor_id: actorId || null,
        };
    },
};

module.exports._test = { _publicBaseUrl, _httpUrl, _sameUrl, SECURITY_TXT_PATH };
