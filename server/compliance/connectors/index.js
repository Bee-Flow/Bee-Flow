/**
 * ISO evidence connector registry — auto-loads every module in this directory.
 *
 * A connector module exports:
 *   {
 *     id: 'github',
 *     titleKey: 'compliance.connector.github.title',
 *     descKey: 'compliance.connector.github.desc',
 *     // Which Annex A controls this connector's evidence feeds:
 *     coveredControls: ['A.8.8', 'A.8.4'],
 *     // Which registered checks read this connector's snapshots — the
 *     // collector re-runs exactly these on CONTROL_DRIFT:
 *     checks: ['ISO27001-A.8.8-vuln-mgmt'],
 *     // Credential requirement. null = credential-less probe (DNS/TLS).
 *     // Otherwise names the integration_connections provider + accepted kinds
 *     // so the UI can offer the right vault connections to link.
 *     credential: null | { provider: 'github', kinds: ['bearer', 'api_key'] },
 *     // Settings the org fills in (documented for the UI; free-form JSONB):
 *     settingsHint: 'repos: ["owner/repo"]',
 *
 *     // Fetch the MINIMUM assertion set (config-state depth — never a mirror).
 *     // `secret` is the decrypted connection secret object (null when
 *     // credential-less); `settings` the org's connector settings;
 *     // `safeFetch` an SSRF-guarded fetch. Returns snapshot rows.
 *     async collect({ orgId, secret, settings, safeFetch })
 *       -> [{ subject_id, payload }]
 *   }
 *
 * Snapshots must never contain secrets — they are hashed into the evidence
 * chain and exportable to auditors.
 */

const fs = require('fs');
const path = require('path');
const log = require('../../telemetry/log');

const _connectors = new Map();

for (const file of fs.readdirSync(__dirname)) {
    if (!file.endsWith('.js') || file === 'index.js') continue;
    // Tests live next to their source, and this loader runs at boot: requiring
    // a test file would run it inside the live process, including the stubs it
    // installs (compliance/checks/index.js skips them for the same reason).
    if (/\.(test|spec)\.js$/.test(file)) continue;
    try {
        const mod = require(path.join(__dirname, file));
        if (!mod?.id || typeof mod.collect !== 'function') {
            log.warn(`[IsoConnectors] ${file} missing id/collect — skipped`);
            continue;
        }
        _connectors.set(mod.id, mod);
    } catch (e) {
        log.error(`[IsoConnectors] Failed to load ${file}:`, e.message);
    }
}

function get(id) { return _connectors.get(id); }
function getAll() { return Array.from(_connectors.values()); }

module.exports = { get, getAll };
