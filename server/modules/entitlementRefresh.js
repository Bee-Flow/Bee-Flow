/**
 * Hub Entitlement Refresh Scheduler.
 *
 * Periodically re-fetches the install's entitlements from the Hub, re-verifies
 * each grant's signature, and persists the fresh TIMESTAMP gate
 * (settings.entitlement) onto every remote platform_modules row. The request
 * path then gates purely on those persisted timestamps (remoteCatalog /
 * modules.isActive) — so a lapsed or revoked subscription deactivates its
 * module without any per-request network dependency.
 *
 * Fail-safe on a Hub outage: a FAILED fetch is a NO-OP (we never flip a paid
 * module off because the Hub blipped). Only a SUCCESSFUL fetch reconciles —
 * a module absent from the returned list is treated as revoked. A grant that
 * fails re-VERIFICATION is stamped 'invalid' with an invalidSince timestamp;
 * remoteCatalog grants it a bounded grace and then fails closed.
 *
 * Two extra loops ride on the scheduler:
 *  - crlTick(): polls the hub's public revocation list (5-min cadence) with a
 *    persisted cursor, so an explicit hub-side revoke lands in minutes instead
 *    of waiting out the hourly refresh. Fail-open: CRL unreachable = no-op.
 *  - install-kill: 3+ consecutive hub_denied (401/403 — NOT network/5xx)
 *    spanning >= HUB_DENIED_GRACE_MS flips every remote row to revoked; the
 *    hub has actively rejected this install's credentials for a full day.
 *
 * Mirrors server/license/refresh.js (start/stop/tick/getHealth, 45s boot delay,
 * unref'd timers).
 */

'use strict';
const log = require('../telemetry/log');

const INTERVAL_SEC = parseInt(process.env.HUB_ENTITLEMENT_REFRESH_INTERVAL_SECONDS || '3600', 10);
const BOOT_DELAY_MS = parseInt(process.env.HUB_ENTITLEMENT_REFRESH_BOOT_DELAY_MS || '45000', 10);
const CRL_POLL_SEC = parseInt(process.env.HUB_CRL_POLL_SECONDS || '300', 10);
const CRL_PAGE_LIMIT = 500;
const DENIED_GRACE_MS = parseInt(process.env.HUB_DENIED_GRACE_MS || String(24 * 60 * 60 * 1000), 10);
const DENIED_THRESHOLD = 3;

const CRL_CURSOR_KEY = 'beeflow_hub_crl_cursor';

// Lazy requires — nothing here may load before boot decides to.
let _hubClient, _store, _remoteCatalog, _moduleEnt, _modules, _subjects, _configStore;
function hubClient() { return _hubClient || (_hubClient = require('./hubClient')); }
function store() { return _store || (_store = require('../stores/platformModuleStore')); }
function remoteCatalog() { return _remoteCatalog || (_remoteCatalog = require('./remoteCatalog')); }
function moduleEntitlements() { return _moduleEnt || (_moduleEnt = require('./entitlements')); }
function modulesRuntime() { return _modules || (_modules = require('./index')); }
function subjects() { return _subjects || (_subjects = require('./subjects')); }
function configStore() { return _configStore || (_configStore = require('../stores/configStore')); }

let _timer = null;
let _crlTimer = null;
const _health = {
    enabled: false,
    lastTickAt: null,
    lastTickDurationMs: null,
    lastTickError: null,
    lastProcessed: 0,
    lastRevoked: 0,
    lastConnected: null,
    lastCrlAt: null,
    lastCrlError: null,
    crlCursor: null,
    deniedCount: 0,
    installRevoked: false,
};

// Consecutive hub_denied tracking for the install-kill interpretation.
let _denied = { count: 0, firstAt: null };

/** Reconcile one remote row against the (successfully fetched) entitlement map. */
async function _reconcileRow(row, byModule, subjectIds, now) {
    const prev = (row.settings && row.settings.entitlement) || {};

    // OFFLINE (sideloaded) entitlements are never hub-reconciled — the hub has
    // no record of them. Re-verify the retained grant JWS locally instead;
    // free-class sideloads (no grant token) are permanent.
    if (prev.source === 'offline') {
        if (!prev.grantToken) return { changed: false, revoked: false };
        const res = await moduleEntitlements().verifyModuleGrant(prev.grantToken, {
            moduleId: row.moduleId,
            subjectIds: subjectIds.length ? subjectIds : undefined,
            now,
        });
        if (!res.valid) {
            if (prev.status === 'invalid') return { changed: false, revoked: true };
            await store().mergeSettings(row.moduleId, {
                entitlement: {
                    ...prev, status: 'invalid',
                    invalidSince: prev.invalidSince || new Date().toISOString(),
                    lastError: res.error || 'verify_failed',
                },
            });
            return { changed: true, revoked: true };
        }
        if (prev.status !== 'active' || prev.invalidSince) {
            const { invalidSince, lastError, ...rest } = prev;
            await store().mergeSettings(row.moduleId, { entitlement: { ...rest, status: 'active', exp: res.payload.exp } });
            return { changed: true, revoked: false };
        }
        return { changed: false, revoked: false };
    }

    const ent = byModule.get(row.moduleId);

    if (!ent || !ent.grant_token) {
        // Present in a SUCCESSFUL fetch but no grant ⇒ revoked/lapsed.
        if (prev.status === 'revoked') return { changed: false, revoked: false };
        await store().mergeSettings(row.moduleId, { entitlement: { ...prev, status: 'revoked' } });
        return { changed: true, revoked: true };
    }

    const res = await moduleEntitlements().verifyModuleGrant(ent.grant_token, {
        moduleId: row.moduleId,
        subjectIds: subjectIds.length ? subjectIds : undefined,
        now,
    });
    if (!res.valid) {
        // Stamp WHEN verification first started failing — remoteCatalog grants
        // a bounded grace from invalidSince, then fails closed. A later
        // successful verify clears it (the fresh write below has no invalidSince).
        await store().mergeSettings(row.moduleId, {
            entitlement: {
                ...prev,
                status: 'invalid',
                invalidSince: prev.invalidSince || new Date().toISOString(),
                lastError: res.error || 'verify_failed',
            },
        });
        return { changed: true, revoked: true };
    }
    await store().mergeSettings(row.moduleId, {
        entitlement: {
            kind: res.payload.kind || ent.kind || prev.kind || 'unknown',
            status: 'active',
            exp: res.payload.exp,
            entitlement_id: res.payload.entitlement_id || ent.entitlement_id || prev.entitlement_id || null,
            current_period_end: ent.current_period_end || null,
        },
    });
    return { changed: true, revoked: false };
}

/** Flip every remote row to revoked — the hub has durably rejected this install. */
async function _revokeAllRemoteRows(reason) {
    let rows = [];
    try { rows = await store().getAllStates(); } catch (_) { return; }
    let changed = 0;
    for (const row of rows.filter(r => remoteCatalog().isRemoteRow(r))) {
        const prev = (row.settings && row.settings.entitlement) || {};
        if (prev.status === 'revoked') continue;
        try {
            await store().mergeSettings(row.moduleId, { entitlement: { ...prev, status: 'revoked', revokedReason: reason } });
            changed++;
        } catch (e) {
            log.warn(`[HubEntitlements] install-revoke persist failed for ${row.moduleId}:`, e.message);
        }
    }
    if (changed) {
        modulesRuntime().invalidateCache();
        await modulesRuntime().refreshModuleActivations();
    }
}

async function _trackDenied(e) {
    if (!e || e.code !== 'hub_denied') return; // network/5xx never counts
    const now = Date.now();
    if (!_denied.firstAt) _denied = { count: 1, firstAt: now };
    else _denied.count++;
    _health.deniedCount = _denied.count;
    if (_denied.count >= DENIED_THRESHOLD && (now - _denied.firstAt) >= DENIED_GRACE_MS && !_health.installRevoked) {
        log.error(`[HubEntitlements] hub denied this install ${_denied.count}x over ${Math.round((now - _denied.firstAt) / 3600000)}h — revoking remote modules`);
        _health.installRevoked = true;
        await _revokeAllRemoteRows('install_revoked');
    }
}

function _clearDenied() {
    _denied = { count: 0, firstAt: null };
    _health.deniedCount = 0;
    _health.installRevoked = false;
}

async function tick() {
    const startedAt = Date.now();
    _health.lastTickAt = new Date(startedAt).toISOString();
    _health.lastTickError = null;
    let processed = 0, revoked = 0;
    try {
        const connected = await hubClient().isConnected();
        _health.lastConnected = connected;
        if (!connected) return; // nothing to refresh

        let list;
        try {
            ({ entitlements: list } = await hubClient().fetchEntitlements());
        } catch (e) {
            // Hub outage ⇒ NO-OP. Never flip modules off on a transient failure.
            // An explicit credential rejection, however, feeds the install-kill counter.
            _health.lastTickError = e.code || e.message;
            await _trackDenied(e);
            return;
        }
        _clearDenied();

        let rows = [];
        try { rows = await store().getAllStates(); } catch (e) { _health.lastTickError = e.message; return; }
        const remoteRows = rows.filter(r => remoteCatalog().isRemoteRow(r));
        if (remoteRows.length === 0) return;

        const byModule = new Map((list || []).filter(e => e && e.module_id).map(e => [e.module_id, e]));
        const subjectIds = await subjects().subjectIds();
        const now = Math.floor(Date.now() / 1000);

        for (const row of remoteRows) {
            try {
                const r = await _reconcileRow(row, byModule, subjectIds, now);
                if (r.changed) processed++;
                if (r.revoked) revoked++;
            } catch (e) {
                log.warn(`[HubEntitlements] reconcile failed for ${row.moduleId}:`, e.message);
            }
        }

        // Re-project the capability ceiling from the fresh timestamps.
        modulesRuntime().invalidateCache();
        await modulesRuntime().refreshModuleActivations();
    } catch (e) {
        _health.lastTickError = e.message;
        log.error('[HubEntitlements] tick error:', e.message);
    } finally {
        _health.lastProcessed = processed;
        _health.lastRevoked = revoked;
        _health.lastTickDurationMs = Date.now() - startedAt;
        // Ride the CRL check on every entitlement tick too (own errors, never
        // fails the tick).
        try { await crlTick(); } catch (_) { /* recorded in _health.lastCrlError */ }
    }
}

/**
 * Poll the hub's public certificate-revocation list from a persisted cursor
 * and flip matching rows to revoked. Fail-OPEN: an unreachable CRL is a no-op
 * (absence of the list must never read as revocation); the cursor only
 * advances after a fully processed page sweep.
 */
async function crlTick() {
    _health.lastCrlAt = new Date().toISOString();
    _health.lastCrlError = null;
    try {
        if (!(await hubClient().isConnected())) return;

        let rows = [];
        try { rows = await store().getAllStates(); } catch (e) { _health.lastCrlError = e.message; return; }
        const remoteRows = rows.filter(r => remoteCatalog().isRemoteRow(r));
        if (remoteRows.length === 0) return;

        let cursor = 0;
        try {
            const stored = await configStore().getConfig(CRL_CURSOR_KEY);
            cursor = Number(stored) > 0 ? Number(stored) : 0;
        } catch (_) { /* start from 0 */ }

        // Page through the CRL; collect every revocation past the cursor.
        const revokedEntries = [];
        let since = cursor;
        for (let page = 0; page < 20; page++) { // hard page cap — a CRL this big means something is wrong
            const data = await hubClient().fetchRevocationList({ since, limit: CRL_PAGE_LIMIT });
            const list = Array.isArray(data.revoked) ? data.revoked : [];
            revokedEntries.push(...list);
            const next = Number(data.next_since) || since;
            if (list.length < CRL_PAGE_LIMIT || next <= since) { since = next; break; }
            since = next;
        }

        if (revokedEntries.length) {
            const byEntId = new Map();
            const byModuleId = new Map();
            for (const r of revokedEntries) {
                if (!r) continue;
                if (r.entitlement_id) byEntId.set(r.entitlement_id, r);
                if (r.module_id) byModuleId.set(r.module_id, r);
            }
            let changed = 0;
            for (const row of remoteRows) {
                const prev = (row.settings && row.settings.entitlement) || {};
                if (prev.status === 'revoked') continue;
                // Match by entitlement id; module-id fallback only for rows
                // whose entitlement was never persisted with an id (a fresh
                // entitlement with a DIFFERENT id must not be killed by an old
                // revocation of the same module).
                const hit = prev.entitlement_id
                    ? byEntId.get(prev.entitlement_id)
                    : byModuleId.get(row.moduleId);
                if (!hit) continue;
                await store().mergeSettings(row.moduleId, {
                    entitlement: { ...prev, status: 'revoked', revokedReason: hit.reason || 'crl' },
                });
                changed++;
            }
            if (changed) {
                modulesRuntime().invalidateCache();
                await modulesRuntime().refreshModuleActivations();
            }
        }

        // Full success — advance the cursor.
        if (since !== cursor) {
            try { await configStore().setConfig(CRL_CURSOR_KEY, since); } catch (_) { /* retry next tick */ }
        }
        _health.crlCursor = since;
    } catch (e) {
        _health.lastCrlError = e.code || e.message;
    }
}

/**
 * Fire-and-forget nudge after a server licence change: ask the hub to REBIND
 * license-scoped entitlements to the new license_id (a v1 hub 404s — swallowed;
 * the subject-id history carries the load there), then re-fetch entitlements
 * soon so grants re-verify instead of waiting out the hourly interval.
 */
function onLicenseChanged() {
    const t = setTimeout(async () => {
        try { await hubClient().rebindLicense(); } catch (e) {
            log.warn('[HubEntitlements] rebind failed (will rely on id history):', e.message);
        }
        tick().catch(err => log.error('[HubEntitlements] license-change tick unhandled:', err.message));
    }, 2000);
    if (typeof t.unref === 'function') t.unref();
}

function start() {
    if (_timer) return;
    _health.enabled = true;
    setTimeout(() => {
        tick().catch(err => log.error('[HubEntitlements] boot tick unhandled:', err.message));
    }, BOOT_DELAY_MS).unref();
    _timer = setInterval(() => {
        tick().catch(err => log.error('[HubEntitlements] tick unhandled:', err.message));
    }, INTERVAL_SEC * 1000);
    _timer.unref();
    _crlTimer = setInterval(() => {
        crlTick().catch(err => log.error('[HubEntitlements] crl tick unhandled:', err.message));
    }, CRL_POLL_SEC * 1000);
    _crlTimer.unref();
    log.info(`[HubEntitlements] Scheduler started — every ${INTERVAL_SEC}s, CRL every ${CRL_POLL_SEC}s (boot delay ${BOOT_DELAY_MS}ms)`);
}

function stop() {
    if (_timer) { clearInterval(_timer); _timer = null; }
    if (_crlTimer) { clearInterval(_crlTimer); _crlTimer = null; }
    _health.enabled = false;
}

function getHealth() {
    return { ..._health };
}

module.exports = { start, stop, tick, crlTick, onLicenseChanged, getHealth, CRL_CURSOR_KEY };
