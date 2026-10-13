// @typecheck
/**
 * stores/managedPartsDefault.js: the stage write guard the app uses.
 *
 * stores/lib/managedParts.js is the guard's logic (`makeManagedParts`); this
 * module is its one instance over the stores' default instances: the stage
 * lookups of projectStore and the deployment and knowledge-base reads of
 * solutionStageStore. It exports the whole guard surface (ALLOWED,
 * changedKeysOf, managedPartError, storeError, plus the instance's
 * managedInfo, managedInfoForKb, hasCapability and assertManagedWrite), so an
 * importer finds everything in one place.
 *
 * The two stores are required lazily, per call: projectStore requires this
 * module for its own write guard, and solutionStageStore requires projectStore
 * for the stage-project writers. That three-way knot is the composition
 * itself (the guard needs both stores, both stores need the guard or each
 * other); keeping it here, outside stores/lib/, is what keeps the platform
 * helpers a leaf.
 */

'use strict';

const parts = require('./lib/managedParts');

// Lazy: projectStore and solutionStageStore require this module (directly or
// through each other) at load.
const defaultParts = parts.makeManagedParts({
    stageOfProject: (id) => require('./projectStore').stageOfProject(id),
    stageOfProjectFresh: (id) => require('./projectStore').stageOfProjectFresh(id),
    isActiveDeployment: (d, p, c) => require('./solutionStageStore').isActiveDeployment(d, p, c),
    kbStageInfo: (kbId) => require('./solutionStageStore').kbStageInfo(kbId),
});

module.exports = {
    ALLOWED: parts.ALLOWED,
    makeManagedParts: parts.makeManagedParts,
    storeError: parts.storeError,
    managedPartError: parts.managedPartError,
    changedKeysOf: parts.changedKeysOf,
    managedInfo: defaultParts.managedInfo,
    managedInfoForKb: defaultParts.managedInfoForKb,
    hasCapability: defaultParts.hasCapability,
    assertManagedWrite: defaultParts.assertManagedWrite,
};
