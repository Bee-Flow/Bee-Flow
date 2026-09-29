/**
 * URL probe for compliance checks — a bounded, SSRF-guarded GET.
 *
 * Built on utils/ssrfGuard.safeFetch, so private/internal hosts are refused
 * before any network activity and re-checked on every connect (redirect
 * hops included) — the same stance as connectors/tls-endpoints.js: this
 * probe is for PUBLIC URLs an auditor could reach too.
 *
 *   probe(url, { maxBytes = 64_000, timeoutMs = 8_000 })
 *     → { ok, status, content_type, snippet, error, final_url, truncated, bytes }
 *
 * Never throws: every failure is a structured `error` code/message so a check
 * can turn it into warn/fail without a try/catch of its own. Codes:
 *   'invalid_url' | 'unsupported_scheme' | 'private_host' | 'timeout' | <message>
 *
 *   parseSecurityTxt(text) → RFC 9116 fields:
 *     { contact: [...], expires, expires_valid, expired, policy, policies: [...],
 *       canonical, canonicals: [...], preferred_languages: [...], field_count }
 *
 * Used by CRA-AnnexI-II5-disclosure-policy (security.txt) and the EAA
 * accessibility-statement check; a natural upgrade path for GDPR Art. 12's
 * attested privacy-notice URL.
 */

const { safeFetch, isPrivateHostname, isPrivateAddressError } = require('../../utils/ssrfGuard');

const DEFAULT_MAX_BYTES = 64_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const USER_AGENT = 'BeeFlow-ComplianceProbe/1.0 (+https://beeflow.nl)';

function _result(patch) {
    return {
        ok: false,
        status: null,
        content_type: null,
        snippet: '',
        error: null,
        final_url: null,
        truncated: false,
        bytes: 0,
        ...patch,
    };
}

async function _readBounded(body, maxBytes) {
    if (!body || typeof body.getReader !== 'function') return { text: '', truncated: false, bytes: 0 };
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    let truncated = false;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            const remaining = maxBytes - total;
            if (value.byteLength > remaining) {
                chunks.push(value.subarray(0, Math.max(0, remaining)));
                total += Math.max(0, remaining);
                truncated = true;
                break;
            }
            chunks.push(value);
            total += value.byteLength;
        }
    } finally {
        if (truncated) { try { await reader.cancel(); } catch { /* stream already gone */ } }
    }
    return { text: Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8'), truncated, bytes: total };
}

/**
 * @param {string} url
 * @param {{ maxBytes?: number, timeoutMs?: number, fetchImpl?: Function, headers?: object }} [opts]
 */
async function probe(url, opts = {}) {
    const maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_MAX_BYTES;
    const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : safeFetch;

    let parsed;
    try {
        parsed = new URL(String(url));
    } catch {
        return _result({ error: 'invalid_url' });
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return _result({ error: 'unsupported_scheme' });
    }
    if (isPrivateHostname(parsed.hostname)) {
        return _result({ error: 'private_host' });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetchImpl(parsed.toString(), {
            method: 'GET',
            redirect: 'follow',
            signal: controller.signal,
            headers: {
                accept: 'text/plain, text/html;q=0.9, application/json;q=0.8, */*;q=0.5',
                'user-agent': USER_AGENT,
                ...(opts.headers || {}),
            },
        });
        const { text, truncated, bytes } = await _readBounded(res.body, maxBytes);
        const contentType = typeof res.headers?.get === 'function' ? res.headers.get('content-type') : null;
        return _result({
            ok: res.status >= 200 && res.status < 300,
            status: res.status,
            content_type: contentType || null,
            snippet: text,
            final_url: res.url || parsed.toString(),
            truncated,
            bytes,
        });
    } catch (e) {
        if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR' || controller.signal.aborted)) {
            return _result({ error: 'timeout' });
        }
        if (isPrivateAddressError(e)) return _result({ error: 'private_host' });
        return _result({ error: String(e?.cause?.message || e?.message || e).slice(0, 200) });
    } finally {
        clearTimeout(timer);
    }
}

// ── RFC 9116 security.txt ───────────────────────────────────────────────────

function _splitField(line) {
    const idx = line.indexOf(':');
    if (idx <= 0) return null;
    const name = line.slice(0, idx).trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(name)) return null;
    return { name, value: line.slice(idx + 1).trim() };
}

/**
 * Parse a security.txt body. Comments (`#`) and a clearsigned PGP wrapper
 * are skipped; field names are case-insensitive; multi-valued fields keep
 * their order of preference (RFC 9116 §2.5.3).
 */
function parseSecurityTxt(text) {
    const out = {
        contact: [],
        expires: null,
        expires_valid: false,
        expired: null,
        policy: null,
        policies: [],
        canonical: null,
        canonicals: [],
        preferred_languages: [],
        field_count: 0,
    };
    if (typeof text !== 'string') return out;
    // A clearsigned file opens with armor headers (`Hash: SHA256`) that end at
    // the first blank line — those are not security.txt fields.
    let inArmorHeader = false;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (inArmorHeader) { if (!line) inArmorHeader = false; continue; }
        if (/^-----BEGIN PGP SIGNED MESSAGE-----$/.test(line)) { inArmorHeader = true; continue; }
        if (line.startsWith('-----BEGIN PGP SIGNATURE-----')) break;
        if (!line || line.startsWith('#') || line.startsWith('-----')) continue;
        const f = _splitField(line);
        if (!f || !f.value) continue;
        out.field_count += 1;
        switch (f.name) {
            case 'contact': out.contact.push(f.value); break;
            case 'expires': {
                if (out.expires === null) {
                    out.expires = f.value;
                    const t = Date.parse(f.value);
                    out.expires_valid = Number.isFinite(t);
                    out.expired = out.expires_valid ? t <= Date.now() : null;
                }
                break;
            }
            case 'policy': out.policies.push(f.value); break;
            case 'canonical': out.canonicals.push(f.value); break;
            case 'preferred-languages':
                out.preferred_languages.push(...f.value.split(',').map(s => s.trim()).filter(Boolean));
                break;
            default: break;
        }
    }
    out.policy = out.policies[0] || null;
    out.canonical = out.canonicals[0] || null;
    return out;
}

module.exports = { probe, parseSecurityTxt, DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT_MS, USER_AGENT };
