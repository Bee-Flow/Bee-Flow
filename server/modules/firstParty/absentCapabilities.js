// @typecheck strict
/**
 * The capabilities of the first-party modules that are ABSENT in this process: an absent module
 * offers nothing, so modules/index.js listInactiveCapabilityIds leaves these out of the
 * capability projection (the registry, the entitlement ceiling, the admin matrices), the same way
 * it leaves out the capabilities of a catalog module that is unavailable or removed.
 *
 * Which module offers which capability is core data (capabilityOwners.json): the catalog's
 * capabilityIds for a catalog module, the record for the others. Absent is the loader's verdict
 * (modules/firstParty/moduleState.js moduleStateOf after loader.load()): no composition in the tree
 * (core mode, not installed), not available in this edition, or requiring a module that is not.
 *
 * Only ever removes, and only for an absent module. A FAILED module keeps its capabilities, as an
 * installed but broken catalog module does: the catalog path asks only the catalog and the import
 * state, never the loader, so a broken module is still offered and its requests fail visibly.
 */

'use strict';

const OWNERS = require('./capabilityOwners.json');
const { moduleStateOf } = require('./moduleState');

/** @typedef {(id: string) => { capabilityIds?: readonly string[] } | null} CatalogLookup */
/** @typedef {{ load?: () => unknown, stateOf?: (moduleId: string) => string }} AbsentDeps */

/**
 * Module id -> the capability ids it offers.
 * @param {CatalogLookup} getModule the catalog's getModule (modules/catalog.js)
 * @returns {Map<string, string[]>}
 */
function capabilitiesByModule(getModule) {
    /** @type {Map<string, string[]>} */
    const out = new Map();
    for (const id of OWNERS.catalogModules) out.set(id, [...(getModule(id)?.capabilityIds || [])]);
    /** @type {Record<string, string>} */
    const owned = OWNERS.capabilities;
    for (const [capId, moduleId] of Object.entries(owned)) out.set(moduleId, [...(out.get(moduleId) || []), capId]);
    return out;
}

/**
 * The capability ids of every first-party module the loader finds absent.
 * @param {CatalogLookup} getModule the catalog's getModule (modules/catalog.js)
 * @param {AbsentDeps} [deps] load: the loader's verdict (loader.load); stateOf: moduleStateOf
 * @returns {Set<string>}
 */
function absentModuleCapabilityIds(getModule, deps = {}) {
    (deps.load || (() => require('./loader').load()))();
    const stateOf = deps.stateOf || moduleStateOf;
    /** @type {Set<string>} */
    const out = new Set();
    for (const [moduleId, capIds] of capabilitiesByModule(getModule)) {
        if (stateOf(moduleId) === 'absent') for (const capId of capIds) out.add(capId);
    }
    return out;
}

module.exports = { absentModuleCapabilityIds, capabilitiesByModule };
