/**
 * EAA Art. 13(2) / Annex V (indicative) — an accessibility statement is
 * published.
 *
 * A service provider must explain, publicly, how its service meets the
 * accessibility requirements. HYBRID:
 *   • attested  — `settings.accessibility_statement_url` is where the admin
 *                 says the statement lives (Compliance → Settings);
 *   • automated — the URL is fetched through the SSRF-guarded probe
 *                 (lib/urlProbe.js, falling back to utils/ssrfGuard.safeFetch
 *                 when the probe module is not present) and the body is
 *                 searched for accessibility vocabulary.
 *
 *   URL missing / not http(s)                        → fail
 *   fetch refused / non-2xx / error                  → warn
 *   2xx but body without accessibility terms         → warn
 *   2xx with terms                                   → pass
 *
 * Evidence: the public URL, status, content-type, matched terms, and the
 * declared conformance level/date. Nothing about a person.
 */

const complianceStore = require('../../../stores/complianceStore');

const TERMS = [
    { key: 'toegankelijk', re: /toegankelijk/i },
    { key: 'accessib', re: /accessib/i },
    { key: 'barrierefrei', re: /barrierefrei/i },
    { key: 'WCAG', re: /\bWCAG\b/i },
    { key: 'EN 301 549', re: /EN\s?301\s?549/i },
    { key: 'conformance', re: /conformance|conformiteit/i },
];
const MAX_BYTES = 128_000;

function _notRelevant(settings) {
    let rel = settings && settings.framework_relevance;
    if (typeof rel === 'string') { try { rel = JSON.parse(rel); } catch { rel = null; } }
    return !!rel && rel.eaa === 'not_relevant';
}

function _httpUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    let u;
    try { u = new URL(value.trim()); } catch { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u;
}

function _iso(v) {
    if (!v) return null;
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** lib/urlProbe when present; a minimal safeFetch-based probe otherwise. */
async function _probe(url) {
    let probeMod = null;
    try { probeMod = require('../../lib/urlProbe'); } catch { probeMod = null; }
    if (probeMod && typeof probeMod.probe === 'function') {
        return probeMod.probe(url, { maxBytes: MAX_BYTES, timeoutMs: 8_000 });
    }
    const { safeFetch } = require('../../../utils/ssrfGuard');
    try {
        const res = await safeFetch(url, { method: 'GET', headers: { accept: 'text/html,*/*' }, signal: AbortSignal.timeout(8_000) });
        const text = (await res.text()).slice(0, MAX_BYTES);
        return { ok: res.ok, status: res.status, content_type: res.headers.get('content-type') || null, snippet: text, error: null };
    } catch (e) {
        return { ok: false, status: null, content_type: null, snippet: '', error: String(e?.code || e?.message || e).slice(0, 120) };
    }
}

function _stripTags(html) {
    return String(html || '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
}

module.exports = {
    id: 'EAA-Art13-accessibility-statement',
    regulation: 'EAA',
    article: 'Art. 13(2)',
    frameworks: [],
    severity: 'medium',
    scope: 'global',
    verification: 'hybrid',
    titleKey: 'compliance.check_eaa_statement_title',
    descriptionKey: 'compliance.check_eaa_statement_desc',
    remediationKey: 'compliance.check_eaa_statement_fix',
    remediationLink: 'admin/compliance/settings',
    TERMS,

    async evaluate(orgId) {
        const settings = await complianceStore.getSettings(orgId) || {};
        if (_notRelevant(settings)) {
            return {
                status: 'not_applicable',
                evidence: { relevance: 'not_relevant' },
                details: 'The EAA was marked not relevant for this organisation (Compliance → Frameworks).',
            };
        }

        const url = _httpUrl(settings.accessibility_statement_url);
        const evidence = {
            statement_url: url ? url.toString() : null,
            url_set: !!(typeof settings.accessibility_statement_url === 'string' && settings.accessibility_statement_url.trim()),
            http_status: null,
            content_type: null,
            probe_error: null,
            matched_terms: [],
            declared_level: typeof settings.accessibility_conformance_level === 'string' && settings.accessibility_conformance_level.trim()
                ? settings.accessibility_conformance_level.trim().slice(0, 40) : null,
            declared_at: _iso(settings.accessibility_conformance_at),
            attested_at: _iso(settings.updated_at),
        };

        if (!url) {
            return {
                status: 'fail',
                evidence,
                details: evidence.url_set
                    ? 'The accessibility statement URL is not a valid http(s) address — correct it under Compliance → Settings.'
                    : 'No accessibility statement URL is recorded. Publish a statement describing how the service meets the accessibility requirements (Art. 13) and paste its URL under Compliance → Settings.',
            };
        }

        const p = await _probe(url.toString());
        evidence.http_status = p.status ?? null;
        evidence.content_type = p.content_type || null;
        evidence.probe_error = p.error || null;

        if (!p.ok) {
            return {
                status: 'warn',
                evidence,
                details: p.error
                    ? `The accessibility statement URL could not be fetched (${p.error}). It must be publicly reachable.`
                    : `The accessibility statement URL answered HTTP ${p.status} — it must be publicly reachable with a 2xx response.`,
            };
        }

        const text = _stripTags(p.snippet);
        evidence.matched_terms = TERMS.filter(t => t.re.test(text)).map(t => t.key);
        if (!evidence.matched_terms.length) {
            return {
                status: 'warn',
                evidence,
                details: 'The page at the accessibility statement URL is reachable but mentions neither accessibility, WCAG nor EN 301 549 — check that the URL points at the statement itself.',
            };
        }
        return {
            status: 'pass',
            evidence,
            details: `Accessibility statement reachable (HTTP ${p.status}) and mentions ${evidence.matched_terms.join(', ')}${evidence.declared_level ? `; declared conformance ${evidence.declared_level}` : ''}.`,
        };
    },
};
