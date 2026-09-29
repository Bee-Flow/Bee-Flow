/**
 * TLS endpoint probe (credential-less) — certificate expiry and protocol
 * version for the org's public endpoints (A.8.24 cryptography in transit).
 * Config-state depth: one handshake per endpoint, no content fetched.
 *
 * Private/internal hostnames are refused (same SSRF stance as safeFetch) —
 * this probe is for PUBLIC endpoints an auditor could reach too.
 */

const tls = require('node:tls');

let _isPrivateHostname = null;
try { _isPrivateHostname = require('../../utils/ssrfGuard').isPrivateHostname; } catch { /* optional */ }

function _probe(host, port = 443, timeoutMs = 8000) {
    return new Promise((resolve) => {
        const socket = tls.connect({ host, port, servername: host, timeout: timeoutMs, rejectUnauthorized: false }, () => {
            const cert = socket.getPeerCertificate();
            const protocol = socket.getProtocol();
            const authorized = socket.authorized;
            socket.end();
            const validTo = cert?.valid_to ? new Date(cert.valid_to) : null;
            resolve({
                reachable: true,
                authorized,
                protocol,
                issuer: cert?.issuer?.O || cert?.issuer?.CN || null,
                valid_to: validTo ? validTo.toISOString() : null,
                days_remaining: validTo ? Math.floor((validTo.getTime() - Date.now()) / 86400000) : null,
            });
        });
        socket.on('error', (e) => resolve({ reachable: false, error: String(e.message || e).slice(0, 200) }));
        socket.on('timeout', () => { socket.destroy(); resolve({ reachable: false, error: 'timeout' }); });
    });
}

module.exports = {
    id: 'tls-endpoints',
    titleKey: 'compliance.connector.tls_endpoints.title',
    descKey: 'compliance.connector.tls_endpoints.desc',
    coveredControls: ['A.8.24'],
    checks: ['ISO27001-A.8.24-tls-endpoints'],
    credential: null,
    settingsHint: 'endpoints: ["beeflow.nl", "app.beeflow.nl"]',

    async collect({ settings }) {
        const endpoints = (Array.isArray(settings?.endpoints) ? settings.endpoints : [])
            .map(e => String(e).replace(/^https?:\/\//, '').replace(/[/:].*$/, '').trim().toLowerCase())
            .filter(Boolean)
            .slice(0, 20);
        const out = [];
        for (const host of endpoints) {
            if (_isPrivateHostname && _isPrivateHostname(host)) {
                out.push({ subject_id: host, payload: { host, skipped: 'private_hostname' } });
                continue;
            }
            const result = await _probe(host);
            out.push({ subject_id: host, payload: { host, ...result } });
        }
        return out;
    },
};
