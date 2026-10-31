// @typecheck strict
/**
 * Account-erasure ports: what the storage layer needs from the features to
 * erase a user completely, injected so stores/user/ does not require
 * core/ or projects/ (that up-call closed a 500-file import cycle).
 *
 *   notebooks.deleteAllForUser(userId) -> { notebooks }   (core/kb/notebookCascade)
 *   projects.makeTeardown()            -> project teardown (projects/projectTeardown)
 *   content.erase*(userId)             -> meeting notes, web pages, apps, skills,
 *                                         the object-storage prefix (projects/accountContentErasure)
 *
 * Registered at boot by projects/erasurePorts.js (loaded from
 * boot/featureRegistrations.js). FAIL CLOSED: erasurePort() throws when a
 * port is not registered. For a GDPR erasure, silently skipping the notebooks
 * or the projects would leave personal data behind while reporting success.
 * Anything that deletes users outside the server process (scripts) must
 * require projects/erasurePorts.js itself.
 */

'use strict';

/**
 * @typedef {{
 *   notebooks: { deleteAllForUser: (userId: string) => Promise<{ notebooks?: number }> },
 *   projects: { makeTeardown: () => any },
 *   content: {
 *     eraseTranscriptions: (userId: string) => Promise<number>,
 *     eraseOrgTranscriptions: (orgId: string) => Promise<number>,
 *     eraseWebpages: (userId: string) => Promise<number>,
 *     eraseStudioApps: (userId: string) => Promise<number>,
 *     eraseSkills: (userId: string) => Promise<number>,
 *     eraseStoragePrefix: (userId: string) => Promise<number>,
 *   },
 * }} ErasurePorts
 */

/** @type {Partial<ErasurePorts>} */
let ports = {};

/** @param {Partial<ErasurePorts>} next  Merged over what is registered. */
function registerErasurePorts(next) {
    ports = { ...ports, ...next };
}

/**
 * @template {keyof ErasurePorts} K
 * @param {K} name
 * @returns {ErasurePorts[K]}
 */
function erasurePort(name) {
    const port = ports[name];
    if (!port) {
        throw new Error(`Erasure port '${name}' is not registered; refusing to erase (load projects/erasurePorts.js)`);
    }
    return /** @type {ErasurePorts[K]} */ (port);
}

/** Both ports at once (the notebooks port and a project teardown), so a caller can refuse before its first write. */
function resolveErasurePorts() {
    return { notebooks: erasurePort('notebooks'), teardown: erasurePort('projects').makeTeardown() };
}

/** Test helper: forget every registration. */
function resetErasurePortsForTests() {
    ports = {};
}

module.exports = { registerErasurePorts, erasurePort, resolveErasurePorts, resetErasurePortsForTests };
