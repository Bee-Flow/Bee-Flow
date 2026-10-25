/**
 * Package loader: the operator-driven install paths.
 *
 * Install from the hub (download → verify → consent → entitlement →
 * activate, or staged when a running module needs a restart), update,
 * sideload from an upload (the air-gapped path), activate a staged version,
 * list retained versions and roll back. Each path owns the install progress
 * (memory + install store) and the per-module install guard.
 */

'use strict';

const path = require('path');
const fsp = require('fs/promises');

const {
    deps, _dispatch, _progress, _installing, _healthOf, _logSystem, REPLICA_ID, packageKeyResolver,
} = require('./packageState');
const {
    packagePath, versionDir, _compatCheck, _extractAtomic, _manifestSummary,
    verifyAndStage, _reverifyFromDisk,
} = require('./packageStaging');
const { _entitlementGate, _sideloadEntitlementGate } = require('./packageEntitlement');
const { activate } = require('./packageActivation');
const log = require('../telemetry/log');
const { bestEffort, fallback } = require('../utils/bestEffort');

const { hubClient, store, packageStore, installStore, moduleAudit, packageVerify, remoteCatalog } = deps;

// ── Progress (dual-write: memory for the fast poll path, DB for other
//    replicas + restarts) ────────────────────────────────────────────────────
/**
 * @param {string} id
 * @param {string} phase
 * @param {number | null} [pct]
 * @param {string | null} [error]
 */
function _setProgress(id, phase, pct = null, error = null, detail = null) {
    _progress.set(id, { phase, pct, error, detail });
    installStore().setPhase(id, phase, pct, { error, detail }).catch((e) => bestEffort('modules/packageInstall:_setProgress', e));
}
/**
 * @param {string} id
 */
async function getInstallProgress(id) {
    const mem = _progress.get(id);
    if (mem) return mem;
    try {
        const row = await installStore().get(id);
        return row ? { phase: row.phase, pct: row.pct, error: row.error, detail: row.detail, replica: row.replica } : null;
    } catch (_) { return null; }
}
/**
 * @param {string} id
 */
function isInstalling(id) {
    return _installing.has(id);
}

// ── Install from Hub (download → verify → gate → activate) ─────────────────
/**
 * @param {string} moduleId
 */
async function installFromHub(moduleId, { version = null, actorId = null, acceptedPermissions = null } = {}) {
    const { HubError } = hubClient();
    // A built-in module always wins its slug — a hub package must never
    // shadow one.
    try {
        if (require('./catalog').getModule(moduleId)) {
            const e = new Error('module_id_conflict'); e.code = 'module_id_conflict'; throw e;
        }
    } catch (e) { if (e.code === 'module_id_conflict') throw e; /* catalog unavailable in some tests */ }
    if (_installing.has(moduleId)) {
        const e = new HubError('already_connected', 'install_in_progress'); e.inProgress = true; throw e;
    }
    // Cross-replica lease: exactly one live install per module. A DB hiccup
    // degrades to the in-memory guard rather than blocking installs.
    let leased = false;
    try {
        const lease = await installStore().acquire(moduleId, { version, actor: actorId, replica: REPLICA_ID });
        if (!lease) {
            const e = new HubError('already_connected', 'install_in_progress'); e.inProgress = true; throw e;
        }
        leased = true;
    } catch (e) {
        if (e && e.inProgress) throw e;
        log.warn(`[Modules] install lease unavailable for ${moduleId} (continuing single-replica):`, /** @type {Error} */ (e).message);
    }
    void leased;
    _installing.add(moduleId);
    _setProgress(moduleId, 'downloading', 0);
    let resolvedVersion = version;
    try {
        if (!resolvedVersion) {
            const cat = await hubClient().fetchCatalogEntry(moduleId);
            resolvedVersion = cat && cat.module && cat.module.latest_version;
            if (!resolvedVersion) throw new HubError('hub_unavailable', 'no downloadable version for module');
        }
        _setProgress(moduleId, 'downloading', 20);
        const staged = await verifyAndStage(moduleId, resolvedVersion, { download: true });
        _setProgress(moduleId, 'verifying', 60);

        // ── Consent gate (M2) — enforced against the SIGNED manifest ────────
        // Catalog-advertised permission lists are display-only; a package
        // demanding more than the operator accepted fails closed here.
        const manifest = staged.manifest;
        const isMv2 = Number(manifest.manifestVersion || 1) >= 2;
        const needed = (isMv2 && Array.isArray(manifest.permissions)) ? manifest.permissions : [];
        let grantedPermissions = null;
        if (isMv2) {
            let existingList = [];
            try {
                const row = await store().getState(moduleId);
                existingList = (row && row.settings && row.settings.grantedPermissions
                    && row.settings.grantedPermissions.list) || [];
            } catch (_) { log.warn('module state lookup failed, no earlier granted permissions merged', _); }
            const granted = new Set([...existingList, ...(Array.isArray(acceptedPermissions) ? acceptedPermissions : [])]);
            const missing = needed.filter(p => !granted.has(p));
            if (missing.length) {
                const e = new Error('consent_required');
                e.code = 'consent_required';
                e.missingPermissions = missing;
                throw e;
            }
            grantedPermissions = { list: needed, acceptedBy: actorId, acceptedAt: new Date().toISOString() };
        }

        const gate = await _entitlementGate(moduleId, manifest);

        // Updates of a RUNNING module that can't hot-swap are staged: verified,
        // entitled and consented, but activated by the NEXT restart (boot
        // processes staged rows first). Fresh installs always activate — no old
        // code is loaded yet.
        if (staged.requiresRestart && _dispatch.has(moduleId)) {
            await packageStore().setStaged(moduleId, resolvedVersion, {
                manifest: _manifestSummary(manifest), kid: staged.kid,
                packageSha256: staged.sha256, actorId,
            });
            if (grantedPermissions) {
                try { await store().mergeSettings(moduleId, { grantedPermissions }); } catch (_) { log.warn('could not persist the granted permissions', _); }
            }
            _setProgress(moduleId, 'staged', 100);
            _logSystem(moduleId, `update to v${resolvedVersion} staged — restart required`);
            await moduleAudit().emit('platform.module.update', moduleId, actorId, { version: resolvedVersion, staged: true });
            return { ok: true, version: resolvedVersion, requiresRestart: true };
        }

        await activate(moduleId, resolvedVersion, {
            actorId,
            manifest,
            kid: staged.kid,
            sha256: staged.sha256,
            entitlement: gate.entitlement,
            grantedPermissions,
            onPhase: (/** @type {string} */ phase, /** @type {number | null | undefined} */ pct) => _setProgress(moduleId, phase, pct),
        });
        _setProgress(moduleId, 'done', 100);
        await moduleAudit().emit('platform.module.install', moduleId, actorId, { version: resolvedVersion, permissions: needed });
        if (grantedPermissions) {
            await moduleAudit().emit('platform.module.consent', moduleId, actorId, { permissions: needed });
        }
        return { ok: true, version: resolvedVersion, requiresRestart: false };
    } catch (e) {
        _healthOf(moduleId).lastActivationError = /** @type {Error} */ (e).message;
        _setProgress(moduleId, 'error', null, e.code || /** @type {Error} */ (e).message,
            e.missingPermissions ? { missingPermissions: e.missingPermissions } : null);
        if (resolvedVersion) {
            try {
                await packageStore().setFailed(moduleId, resolvedVersion, {
                    error: /** @type {Error} */ (e).message,
                    status: e.compat ? 'incompatible' : 'failed',
                });
            } catch (err) { bestEffort('modules/packageInstall:installFromHub', err); /* best effort */ }
        }
        throw e;
    } finally {
        _installing.delete(moduleId);
    }
}

/**
 * @param {string} moduleId
 */
async function updateModule(moduleId, { actorId = null, acceptedPermissions = null } = {}) {
    const cat = await hubClient().fetchCatalogEntry(moduleId);
    const hm = (cat && cat.module) || {};
    if (cat && Array.isArray(cat.versions) && !hm.versions) hm.versions = cat.versions;

    // Policy-aware resolution: highest non-yanked candidate on the install's
    // channel satisfying its pin (v1-hub fallback: flat latest_version).
    let row = null;
    try { row = await store().getState(moduleId); } catch (_) { log.warn('module state lookup failed, installed version unknown', _); }
    const installedVersion = (row && (row.version || (row.settings && row.settings.package && row.settings.package.version))) || null;
    const updatePolicy = (row && row.settings && row.settings.updatePolicy) || null;
    const latest = installedVersion
        ? remoteCatalog().resolveUpdateTarget(hm, installedVersion, updatePolicy)
        : (hm.latest_version || null);
    if (!latest) { const e = new (hubClient().HubError)('hub_unavailable', 'no update available'); throw e; }
    const r = await installFromHub(moduleId, { version: latest, actorId, acceptedPermissions });
    if (!r.requiresRestart) {
        await moduleAudit().emit('platform.module.update', moduleId, actorId, { version: latest });
    }
    // Hot activation for pure-JS modules; native/restart:'always' packages are
    // staged and report requiresRestart honestly.
    return { ok: true, version: latest, requiresRestart: !!r.requiresRestart };
}

/**
 * Install a `.bfmod` from a raw upload — the air-gapped path. Same trust root
 * and verify pipeline as a hub download; the only difference is where the
 * entitlement comes from. An unentitled upload is RETAINED and ledgered
 * 'staged' so a later grant + activate-staged completes it without re-upload.
 * @param {Buffer<ArrayBufferLike>} buffer
 */
async function sideloadFromBuffer(buffer, { actorId = null, acceptedPermissions = null } = {}) {
    const result = await packageVerify().verifyPackage(buffer, { publicKeyResolver: packageKeyResolver() });
    if (!result.ok) { const e = new Error(`package_verify_failed:${result.error}`); e.code = 'package_verify_failed'; e.detail = result.error; throw e; }
    const manifest = result.manifest;
    const moduleId = manifest.id;
    const version = manifest.version;
    if (require('./catalog').getModule(moduleId)) { const e = new Error('module_id_conflict'); e.code = 'module_id_conflict'; throw e; }
    _compatCheck(manifest, result.signature && result.signature.payload);

    if (_installing.has(moduleId)) { const e = new Error('install_in_progress'); e.code = 'install_in_progress'; throw e; }
    _installing.add(moduleId);
    _setProgress(moduleId, 'verifying', 30);
    try {
        // Retain the package + extract (same layout as a hub install).
        const pkgPath = packagePath(moduleId, version);
        await fsp.mkdir(path.dirname(pkgPath), { recursive: true });
        await fsp.writeFile(pkgPath, buffer);
        const sha256 = require('crypto').createHash('sha256').update(buffer).digest('hex');
        await _extractAtomic(versionDir(moduleId, version), result.files);
        const kid = (result.signature && result.signature.kid) || null;

        // Consent gate — identical to the hub path, against the signed manifest.
        const isMv2 = Number(manifest.manifestVersion || 1) >= 2;
        const needed = (isMv2 && Array.isArray(manifest.permissions)) ? manifest.permissions : [];
        let grantedPermissions = null;
        if (isMv2) {
            let existingList = [];
            try {
                const row = await store().getState(moduleId);
                existingList = (row && row.settings && row.settings.grantedPermissions
                    && row.settings.grantedPermissions.list) || [];
            } catch (_) { log.warn('module state lookup failed, no earlier granted permissions merged', _); }
            const granted = new Set([...existingList, ...(Array.isArray(acceptedPermissions) ? acceptedPermissions : [])]);
            const missing = needed.filter(p => !granted.has(p));
            if (missing.length) {
                const e = new Error('consent_required'); e.code = 'consent_required'; e.missingPermissions = missing; throw e;
            }
            grantedPermissions = { list: needed, acceptedBy: actorId, acceptedAt: new Date().toISOString() };
        }

        /** @type {{ entitlement: GateEntitlement; }} */
        let gate;
        try {
            gate = await _sideloadEntitlementGate(moduleId, manifest, result.signature && result.signature.payload);
        } catch (e) {
            // Keep the verified package for a later grant.
            await packageStore().setStaged(moduleId, version, {
                manifest: _manifestSummary(manifest), kid, packageSha256: sha256, actorId, source: 'sideload',
            });
            _setProgress(moduleId, 'error', null, e.code || /** @type {Error} */ (e).message);
            throw e;
        }

        const requiresRestart = ([...result.files.keys()].some(n => n.endsWith('.node'))
            || !!(manifest.server && (manifest.server.native === true || manifest.server.restart === 'always')))
            && _dispatch.has(moduleId);
        if (requiresRestart) {
            await packageStore().setStaged(moduleId, version, {
                manifest: _manifestSummary(manifest), kid, packageSha256: sha256, actorId, source: 'sideload',
            });
            if (grantedPermissions) { try { await store().mergeSettings(moduleId, { grantedPermissions }); } catch (_) { log.warn('could not persist the granted permissions', _); } }
            _setProgress(moduleId, 'staged', 100);
            return { ok: true, version, requiresRestart: true };
        }

        await activate(moduleId, version, {
            actorId, manifest, kid, sha256,
            entitlement: gate.entitlement, grantedPermissions, source: 'sideload',
            onPhase: (/** @type {string} */ phase, /** @type {number | null | undefined} */ pct) => _setProgress(moduleId, phase, pct),
        });
        _setProgress(moduleId, 'done', 100);
        await moduleAudit().emit('platform.module.install', moduleId, actorId, { version, source: 'sideload', permissions: needed });
        return { ok: true, version, requiresRestart: false };
    } catch (e) {
        if (!_progress.get(moduleId) || _progress.get(moduleId).phase !== 'error') {
            _setProgress(moduleId, 'error', null, e.code || /** @type {Error} */ (e).message,
                e.missingPermissions ? { missingPermissions: e.missingPermissions } : null);
        }
        throw e;
    } finally {
        _installing.delete(moduleId);
    }
}

/**
 * Activate a previously staged version (sideload waiting on a grant, or an
 * operator choosing to apply a staged update NOW instead of at restart —
 * only valid when a hot swap is actually safe).
 * @param {string} moduleId
 */
async function activateStaged(moduleId, { version = null, actorId = null } = {}) {
    const rows = await packageStore().listForModule(moduleId);
    const staged = (rows || []).filter(r => r.status === 'staged');
    const target = version ? staged.find(r => r.version === version) : staged[0];
    if (!target) { const e = new Error('no_staged_version'); e.code = 'no_staged_version'; throw e; }

    const { manifest, kid } = await _reverifyFromDisk(moduleId, target.version);
    let gate = null;
    if (target.source === 'sideload') {
        gate = await _sideloadEntitlementGate(moduleId, manifest, null);
    } else {
        gate = await _entitlementGate(moduleId, manifest);
    }
    await activate(moduleId, target.version, {
        actorId, manifest, kid, sha256: target.packageSha256,
        entitlement: gate.entitlement, source: target.source,
    });
    await moduleAudit().emit('platform.module.install', moduleId, actorId, { version: target.version, source: target.source, fromStaged: true });
    return { ok: true, version: target.version };
}

// ── Version retention + rollback (M3.2) ─────────────────────────────────────

/**
 * Ledger versions joined with an fs probe (does the .bfmod still exist?).
 * @param {string} moduleId
 */
async function listVersions(moduleId) {
    const rows = await packageStore().listForModule(moduleId);
    const out = [];
    for (const r of (rows || [])) {
        let hasPackageFile = false;
        try { await fsp.access(packagePath(r.moduleId, r.version)); hasPackageFile = true; } catch (_) { fallback('modules/packageInstall:listVersions', _); /* package file absent */ }
        out.push({ ...r, hasPackageFile });
    }
    return out;
}

/**
 * Roll back to a retained retired version. Guards: lease, package file present,
 * full re-verify, schema-downgrade check (the target's server.schemaVersion
 * must not be lower than the active one's unless forced), offline entitlement.
 * @param {string} moduleId
 */
async function rollbackTo(moduleId, { version = null, force = false, actorId = null } = {}) {
    const candidates = await packageStore().listRollbackCandidates(moduleId);
    const target = version
        ? (candidates || []).find(r => r.version === version)
        : (candidates || [])[0];
    if (!target) { const e = new Error('no_rollback_candidate'); e.code = 'no_rollback_candidate'; throw e; }

    if (_installing.has(moduleId)) { const e = new Error('install_in_progress'); e.code = 'install_in_progress'; throw e; }
    _installing.add(moduleId);
    try {
        try { await installStore().acquire(moduleId, { version: target.version, actor: actorId, replica: REPLICA_ID }); } catch (_) { log.warn('install lock could not be acquired, continuing without it', _); }
        _setProgress(moduleId, 'verifying', 30);
        const { manifest, kid } = await _reverifyFromDisk(moduleId, target.version);

        // Schema-downgrade guard: module data written by a NEWER schema may be
        // unreadable to older code — refuse unless the operator forces it.
        const activeRow = await packageStore().getActive(moduleId);
        const activeSchema = Number(activeRow && activeRow.manifest && activeRow.manifest.schemaVersion
            || (activeRow && activeRow.manifest && activeRow.manifest.server && activeRow.manifest.server.schemaVersion) || 0);
        const targetSchema = Number((manifest.server && manifest.server.schemaVersion) || 0);
        if (!force && activeSchema && targetSchema && targetSchema < activeSchema) {
            const e = new Error('schema_downgrade'); e.code = 'schema_downgrade';
            e.detail = `target schemaVersion ${targetSchema} < active ${activeSchema}`;
            throw e;
        }

        // Offline entitlement: the persisted timestamp gate must still hold.
        let row = null;
        try { row = await store().getState(moduleId); } catch (_) { log.warn('module state lookup failed before the entitlement check', _); }
        if (!remoteCatalog().isEntitled(row)) { const e = new Error('not_entitled'); e.code = 'not_entitled'; throw e; }

        await activate(moduleId, target.version, {
            actorId, manifest, kid, sha256: target.packageSha256, source: target.source,
        });
        _setProgress(moduleId, 'done', 100);
        _logSystem(moduleId, `rolled back to v${target.version} by ${actorId || 'operator'}`);
        await moduleAudit().emit('platform.module.update', moduleId, actorId, { version: target.version, rollback: true, forced: !!force });
        return { ok: true, version: target.version };
    } catch (e) {
        _setProgress(moduleId, 'error', null, e.code || /** @type {Error} */ (e).message);
        throw e;
    } finally {
        _installing.delete(moduleId);
    }
}

module.exports = {
    getInstallProgress,
    isInstalling,
    installFromHub,
    updateModule,
    sideloadFromBuffer,
    activateStaged,
    listVersions,
    rollbackTo,
};

/** @typedef {import('crypto').BinaryLike} BinaryLike */
