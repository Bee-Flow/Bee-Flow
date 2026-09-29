/**
 * Grant-subject resolution — the ONE place that knows which subject ids a
 * module grant may be bound to on this install.
 *
 * A grant's `sub` is either the install id (community installs) or a license
 * id. Licences get REPLACED (renewal, upgrade, re-activation) while the hub
 * keeps old grants bound to the superseded license_id — so verification also
 * accepts a short history of previous server license ids (recorded by
 * license/index.js on activation, capped at 5). Without the history, replacing
 * a licence would invalidate every paid module's grant until the hub re-mints.
 */

'use strict';
const log = require('../telemetry/log');

// Lazy requires (cycle-safety + test require.cache overrides).
let _hubClient, _licenseStore, _configStore;
function hubClient() { return _hubClient || (_hubClient = require('./hubClient')); }
function licenseStore() { return _licenseStore || (_licenseStore = require('../license/store')); }
function configStore() { return _configStore || (_configStore = require('../stores/configStore')); }

const LICENSE_ID_HISTORY_KEY = 'beeflow_license_id_history';
const HISTORY_MAX = 5;

/**
 * All subject ids a grant for this install may legitimately be bound to:
 * [installId, activeLicenseId, ...previousLicenseIds].
 * @returns {Promise<string[]>}
 */
async function subjectIds() {
    const ids = [];
    try { const iid = await hubClient().getInstallId(); if (iid) ids.push(iid); } catch (_) { /* not connected */ }
    try {
        const active = await licenseStore().getActiveLicenseForServer();
        if (active && active.id && !ids.includes(active.id)) ids.push(active.id);
    } catch (_) { /* unlicensed */ }
    try {
        const history = await configStore().getConfig(LICENSE_ID_HISTORY_KEY);
        for (const id of (Array.isArray(history) ? history : [])) {
            if (id && !ids.includes(id)) ids.push(id);
        }
    } catch (_) { /* no history */ }
    return ids;
}

/**
 * Record a superseded server license id (called by license activation when a
 * different licence replaces the active one). Deduped, newest-first, capped.
 */
async function recordSupersededLicenseId(licenseId) {
    if (!licenseId) return;
    try {
        const prev = await configStore().getConfig(LICENSE_ID_HISTORY_KEY);
        const list = (Array.isArray(prev) ? prev : []).filter(x => x && x !== licenseId);
        list.unshift(licenseId);
        await configStore().setConfig(LICENSE_ID_HISTORY_KEY, list.slice(0, HISTORY_MAX));
    } catch (e) {
        log.warn('[Modules] license-id history write failed:', e.message);
    }
}

module.exports = { subjectIds, recordSupersededLicenseId, LICENSE_ID_HISTORY_KEY };
