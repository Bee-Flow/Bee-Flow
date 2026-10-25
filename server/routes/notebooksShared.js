// @typecheck strict
/**
 * What every notebook route module shares: the role gates, the collaborators
 * a test swaps (`seams`, re-exported as routes/notebooks.js `.seams`), the
 * multipart upload and the schema parts the closed request bodies are built
 * from.
 *
 * Moved here unchanged from routes/notebooks.js, so the route modules
 * (routes/notebooks.js, routes/notebooksSources.js, routes/notebooksGenerate.js)
 * hold one copy of each.
 */

const multer = require('multer');
const { z, worded } = require('../core/http/schemaParts');
const { requireNotebookRole } = require('./notebooksAccess');
const notebookCollab = require('../agents/notebooks/notebookCollab');
const { makeNotebookFeed } = require('../agents/notebooks/notebookFeed');

// Role gates, one per level (see routes/notebooksAccess.js).
const asViewer = requireNotebookRole('viewer');
const asEditor = requireNotebookRole('editor');
const asOwner = requireNotebookRole('owner');

/**
 * Collaborators a test swaps on this object (testUtils/swaps.js) instead of
 * reaching into the module system. Resolved at call time.
 */
const seams = {
    /** @param {string} id */
    getProject: (id) => require('../stores/projectStore').getProject(id),
    /** @param {string} userId @param {string} projectId */
    projectRoleOf: (userId, projectId) => require('../stores/lib/projectRole').projectRoleOf(userId, projectId),
    /** The co-editing facade, or null. */
    collab: () => notebookCollab.defaultFacade(),
    /** The project change feed. */
    feed: () => makeNotebookFeed(),
};

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB

// ── Schema parts ───────────────────────────────────────────────────
// Every JSON body and query the notebook routes read is closed (see "What a
// caller may send" in routes/notebooks.js); these are the parts they share.
/**
 * @param {string} message
 * @param {number} max
 */
const text = (message, max) => worded(message).max(max, message);
const NOTEBOOK_ID_TEXT = 'Every id is a non-empty id of at most 200 characters.';
const ids = (/** @type {string} */ message) => z.array(worded(message).min(1, NOTEBOOK_ID_TEXT).max(200, NOTEBOOK_ID_TEXT), { error: message });

module.exports = { asViewer, asEditor, asOwner, seams, upload, text, ids };
