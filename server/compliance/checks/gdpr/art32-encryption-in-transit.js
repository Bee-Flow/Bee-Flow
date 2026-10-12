/**
 * GDPR Art. 32 — Encryption in transit (TLS).
 * Best-effort: if NODE_ENV=production and TRUST_PROXY is set (reverse-proxy
 * terminating TLS) we assume HTTPS. Otherwise warn.
 *
 * "Set" means switched ON: TRUST_PROXY=false (or 0, no, off, none) and
 * TLS_TERMINATOR=none say the opposite of what the check attests to, and a
 * bare truthiness test used to read them as "TLS termination detected".
 */

const OFF = /^(0|false|no|off|none)$/i;

/** An env value as "on" (non-empty and not an off-word), trimmed, or null. */
function _onValue(name) {
    const v = String(process.env[name] || '').trim();
    return v && !OFF.test(v) ? v : null;
}

module.exports = {
    id: 'GDPR-Art32-encryption-in-transit',
    regulation: 'GDPR',
    article: '32',
    frameworks: [{ regulation: 'NIS2', ref: 'Art. 21(2)(h)' }],
    severity: 'high',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.checks.gdpr_art32_eit.title',
    descriptionKey: 'compliance.checks.gdpr_art32_eit.desc',
    remediationKey: 'compliance.checks.gdpr_art32_eit.fix',
    async evaluate() {
        const isProd = process.env.NODE_ENV === 'production';
        const trustProxy = _onValue('TRUST_PROXY') !== null;
        const tlsTerminator = _onValue('TLS_TERMINATOR');
        let status = 'pass';
        let details = 'TLS termination detected at reverse proxy.';
        if (!isProd) {
            status = 'warn';
            details = 'NODE_ENV is not "production" — assumed to be a dev/test deployment. Ensure the production stack terminates TLS.';
        } else if (!trustProxy && !tlsTerminator) {
            status = 'warn';
            details = 'Cannot confirm TLS termination. Set TRUST_PROXY=1 or TLS_TERMINATOR=<name> so audits can attest to HTTPS.';
        }
        return {
            status,
            evidence: { NODE_ENV: process.env.NODE_ENV || 'unset', TRUST_PROXY: trustProxy, TLS_TERMINATOR: tlsTerminator },
            details,
        };
    },
};
