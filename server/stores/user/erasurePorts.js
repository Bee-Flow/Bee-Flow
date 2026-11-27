// @typecheck strict
/**
 * Account-erasure ports: what the storage layer needs from the features to
 * erase a user completely, injected so stores/user/ does not require
 * core/ or projects/ (that up-call closed a 500-file import cycle).
 *
 *   notebooks.deleteAllForUser(userId) -> { notebooks }   (core/kb/notebookCascade)
 *   projects.makeTeardown()            -> project teardown (projects/projectTeardown)
 *   content.erase*(userId)             -> meeting notes, web pages, apps, skills,
 *                                         the object-storage prefix, the person's id in every
 *                                         organisation-wide Teams import setting (projects/accountContentErasure)
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
 *     erasePersonalKnowledgeBases: (userId: string) => Promise<number>,
 *     eraseOrgKnowledgeBases: (orgId: string) => Promise<number>,
 *     forgetTeamsAppImportMember: (userId: string) => Promise<number>,
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

/**
 * A teardown that refuses at its first use: the account owns a project, the projects module's
 * code is not here to tear it down (its folding back, detaching and files base), and skipping it
 * would report an erasure that left the project behind.
 */
function refusingTeardown() {
    const refuse = async () => {
        const { ModuleDataPresentError } = require('../../modules/firstParty/moduleData');
        throw new ModuleDataPresentError('projects', 'erase the projects an account owns');
    };
    return { teardownRefusal: refuse, deleteProject: refuse };
}

/**
 * The project teardown of account erasure. The projects module registers its port when it is
 * loaded. When it is absent (core mode, an edition without it) the projects themselves are still
 * in the core's tables: its teardown file runs when it is in the tree, and an owned project
 * refuses the erasure when it is not (an account that owns none is erased as before).
 * A loaded or failed module without its port refuses as before.
 */
function projectTeardown() {
    const { moduleStateOf } = require('../../modules/firstParty/moduleState');
    if (ports.projects || moduleStateOf('projects') !== 'absent') return erasurePort('projects').makeTeardown();
    const file = /** @type {typeof import('../../projects/projectTeardown') | null} */ (
        require('../../modules/firstParty/moduleData').moduleFileInTree('projects/projectTeardown'));
    return file ? file.makeProjectTeardown() : refusingTeardown();
}

/** Both ports at once (the notebooks port and a project teardown), so a caller can refuse before its first write. */
function resolveErasurePorts() {
    return { notebooks: erasurePort('notebooks'), teardown: projectTeardown() };
}

/**
 * Every registered port name, in registration order (boot/composition.registries.characterisation.test.js).
 * @returns {string[]}
 */
function erasurePortNames() {
    return Object.keys(ports);
}

/** Test helper: forget every registration. */
function resetErasurePortsForTests() {
    ports = {};
}

module.exports = { registerErasurePorts, erasurePort, projectTeardown, resolveErasurePorts, erasurePortNames, resetErasurePortsForTests };
