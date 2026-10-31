// @typecheck strict
/**
 * The features' side of stores/user/erasurePorts.js: account erasure deletes
 * a user's notebooks (core/kb) and owned projects (projects/) without the
 * storage layer requiring either.
 *
 * Loaded at boot by boot/featureRegistrations.js, and by the scripts that
 * delete users. Requires are lazy so loading costs nothing.
 */

'use strict';

const { registerErasurePorts } = require('../stores/user/erasurePorts');

registerErasurePorts({
    notebooks: {
        deleteAllForUser: (userId) => require('../core/kb/notebookCascade').deleteAllNotebooksForUser(userId),
    },
    projects: {
        makeTeardown: () => require('./projectTeardown').makeProjectTeardown(),
    },
    content: {
        eraseTranscriptions: (userId) => require('./accountContentErasure').eraseTranscriptions(userId),
        eraseOrgTranscriptions: (orgId) => require('./accountContentErasure').eraseOrgTranscriptions(orgId),
        eraseWebpages: (userId) => require('./accountContentErasure').eraseWebpages(userId),
        eraseStudioApps: (userId) => require('./accountContentErasure').eraseStudioApps(userId),
        eraseSkills: (userId) => require('./accountContentErasure').eraseSkills(userId),
        eraseStoragePrefix: (userId) => require('./accountContentErasure').eraseStoragePrefix(userId),
    },
});
