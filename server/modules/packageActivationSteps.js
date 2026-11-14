// @typecheck strict
/**
 * The steps of activating a verified package (packageActivation.js runs them
 * in order and loads the module code itself): the entry path guard, the mv2
 * permission invariant, the capability descriptors, the gate capability and
 * the persisted settings. Each throws the error activation fails with.
 */

'use strict';

const path = require('path');

const { deps, _remoteDescriptors, _healthOf, _logSystem } = require('./packageState');
const { _manifestSummary } = require('./packageStaging');
const { _projectDescriptors, _pushDescriptors } = require('./packageRuntime');
const log = require('../telemetry/log');
const { fallback } = require('../utils/bestEffort');

const { store, packageStore, registry } = deps;

/** @typedef {import('./packageVerify').PackageManifest} PackageManifest */
/** @typedef {{ list?: string[] } & Record<string, unknown>} PermissionGrant */

/**
 * The module's entry file, which must live inside its version directory.
 * @param {string} dir
 * @param {PackageManifest} manifest
 */
function resolveEntryPath(dir, manifest) {
    const entryRel = manifest.server && manifest.server.entry;
    if (!entryRel) throw new Error('manifest missing server.entry');
    const entryAbs = path.resolve(dir, entryRel);
    if (entryAbs !== dir && !entryAbs.startsWith(dir + path.sep)) {
        throw new Error(`entry escapes module dir: ${entryRel}`);
    }
    return entryAbs;
}

/**
 * The operator's grant: the one passed in, else the stored one (a failed read is no grant).
 * @param {string} moduleId
 * @param {PermissionGrant | null} grantedPermissions
 * @returns {Promise<string[]>}
 */
async function grantedListOf(moduleId, grantedPermissions) {
    const passed = (grantedPermissions && grantedPermissions.list) || null;
    if (passed) return passed;
    try {
        const row = await store().getState(moduleId);
        return (row && row.settings && row.settings.grantedPermissions
            && row.settings.grantedPermissions.list) || [];
    } catch (_) { return []; }
}

/**
 * mv2 permission invariant (M2): EVERY activation (boot and reconcile
 * included) re-checks that the SIGNED manifest's permission list is covered
 * by the operator's persisted grant. A package updated to demand more than
 * was consented to fails closed. Answers the surface the module's hostApi
 * gets: the manifest's list for mv2, null (the full mv1 surface) otherwise.
 * @param {string} moduleId
 * @param {PackageManifest} manifest
 * @param {PermissionGrant | null} grantedPermissions
 * @returns {Promise<string[] | null>}
 */
async function modulePermissionsFor(moduleId, manifest, grantedPermissions) {
    const isMv2 = Number(manifest.manifestVersion || 1) >= 2;
    if (!isMv2) return null;
    /** @type {string[]} */
    const neededPermissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
    if (!neededPermissions.length) return neededPermissions;
    const grantedList = await grantedListOf(moduleId, grantedPermissions);
    const missing = neededPermissions.filter(p => !grantedList.includes(p));
    if (missing.length) {
        /** @type {Error & { code?: string, missingPermissions?: string[] }} */
        const e = new Error(`permissions_not_granted: ${missing.join(',')}`);
        e.code = 'permissions_not_granted';
        e.missingPermissions = missing;
        throw e;
    }
    return neededPermissions;
}

/**
 * The capability ids of these descriptors another module or a built-in already owns.
 * @param {string} moduleId
 * @param {{ id: string }[]} capDescriptors
 */
function conflictingCapabilityIds(moduleId, capDescriptors) {
    /** @type {string[]} */
    const conflicts = [];
    for (const c of capDescriptors) {
        /** @type {{ moduleId?: string | null } | null | undefined} */
        let existing = null;
        try { existing = registry().getCapability(c.id); } catch (err) { fallback('modules/packageActivation:activate', err); /* registry not ready */ }
        if (existing && existing.moduleId !== moduleId) conflicts.push(c.id);
    }
    return conflicts;
}

/**
 * Descriptors first, so capability lookups resolve while createModule runs.
 * Capability-id CONFLICTS: hard-fail new installs; boot re-activation
 * (persist:false) grandfathers mv1's shadowing semantics: skip the
 * conflicting descriptor, warn, and surface it in health (review F16).
 * @param {string} moduleId
 * @param {PackageManifest} manifest
 * @param {boolean} persist
 */
function registerDescriptors(moduleId, manifest, persist) {
    const projected = _projectDescriptors(moduleId, manifest);
    const conflicts = conflictingCapabilityIds(moduleId, projected.capDescriptors);
    if (conflicts.length) {
        if (persist) throw new Error(`capability_conflict: ${conflicts.join(',')}`);
        log.warn(`[Modules] ${moduleId}: skipping conflicting capability ids at boot: ${conflicts.join(', ')}`);
        _logSystem(moduleId, `capability conflict (grandfathered, descriptors skipped): ${conflicts.join(', ')}`);
        projected.capDescriptors = projected.capDescriptors.filter(c => !conflicts.includes(c.id));
        projected.betaDescriptors = projected.betaDescriptors.filter(c => !conflicts.includes(c.id));
        _healthOf(moduleId).capabilityConflicts = conflicts;
    }
    _remoteDescriptors.set(moduleId, projected);
    _pushDescriptors();
}

/**
 * The id of the manifest's first capability, if it has one.
 * @param {PackageManifest} manifest
 * @returns {string | null}
 */
const firstCapabilityId = (manifest) => (Array.isArray(manifest.capabilities) && manifest.capabilities[0] && manifest.capabilities[0].id) || null;

/**
 * Gate capability: manifest override, then the studioApp gate (the SDK's
 * actual spelling), then the frontend gate, then the first own capability.
 * The gate MUST be module-own: an id this module doesn't declare would let it
 * hide behind (or expose itself via) someone else's entitlement.
 * @param {string} moduleId
 * @param {PackageManifest} manifest
 * @returns {string | null}
 */
function gateCapabilityOf(moduleId, manifest) {
    const ownCapIds = new Set((Array.isArray(manifest.capabilities) ? manifest.capabilities : [])
        .map((/** @type {{ id?: string } | null} */ c) => c && c.id).filter(Boolean));
    const declared = manifest.gateCapability
        || (manifest.frontend && manifest.frontend.studioApp && manifest.frontend.studioApp.gateCapability)
        || (manifest.frontend && manifest.frontend.gateCapability)
        || firstCapabilityId(manifest);
    if (!declared || ownCapIds.has(declared)) return declared;
    log.warn(`[Modules] ${moduleId}: gateCapability '${declared}' is not module-own — falling back`);
    return firstCapabilityId(manifest);
}

/**
 * Persist the activation: the module's settings (merged with the stored ones
 * so entitlement survives a re-activate) and the active package row.
 * @param {string} moduleId
 * @param {string} version
 * @param {PackageManifest} manifest
 * @param {{ actorId: string | null, kid: string | null, sha256: string | null, entitlement: unknown,
 *   grantedPermissions: PermissionGrant | null, source: string | null }} opts
 */
async function persistActivation(moduleId, version, manifest, { actorId, kid, sha256, entitlement, grantedPermissions, source }) {
    /** @type {{ settings?: Record<string, any> | null } | null} */
    let existing = null;
    let existingRead = true;
    try { existing = await store().getState(moduleId); } catch (err) {
        existingRead = false;
        log.warn('module state lookup failed, keeping the stored settings as they are', err);
    }
    const settings = {
        remote: true,
        manifest: _manifestSummary(manifest),
        entitlement: entitlement || (existing && existing.settings && existing.settings.entitlement) || null,
        package: { version, sha256, kid },
        latestVersion: version,
        grantedPermissions: grantedPermissions
            || (existing && existing.settings && existing.settings.grantedPermissions) || null,
    };
    // Without the stored row, an entitlement or grant not passed in would be written as null: skip that write.
    const wouldDropStored = !existingRead && (!entitlement || !grantedPermissions);
    if (!wouldDropStored) await store().setImported(moduleId, { actorId, version, settings });
    await packageStore().setActive(moduleId, version, { manifest: _manifestSummary(manifest), kid, packageSha256: sha256, actorId, source });
}

module.exports = { resolveEntryPath, modulePermissionsFor, registerDescriptors, gateCapabilityOf, persistActivation };
