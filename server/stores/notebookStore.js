// @typecheck strict
/**
 * Notebook Store — PostgreSQL-backed notebook management.
 *
 * Three tables:
 *   • notebooks          — top-level notebook (name, instructions, KB links, settings)
 *   • notebook_sources   — individual sources within a notebook (PDF, DOCX, URL, text, etc.)
 *   • notebook_versions  — immutable content snapshots for version history
 *
 * Backwards-compatible: existing `word_templates` rows are migrated into notebooks on first access.
 *
 * A barrel since the split: schema in stores/notebook/schema.js, notebook CRUD in
 * notebook/notebooks.js, the card listing's query and shape in notebook/cards.js, project membership
 * and the co-editing hook in notebook/membership.js, sources in notebook/sources.js,
 * versions in notebook/versions.js (model in notebook/versionModel.js), row
 * mappers in notebook/rowMappers.js. The exported keys are unchanged.
 */

const contentCrypto = require('./lib/documentCrypto');
// The notebook modules get their cycle-bound dependencies from here (see
// notebook/deps.js); installed before the first of them loads.
require('./notebook/deps').install({
    contentCrypto,
    db: contentCrypto.readingDb(require('../db')),
    documentSharing: require('./lib/documentSharing'),
    // Lazy, as they always were: required on first use, not at load.
    projectRole: () => require('./lib/projectRole'),
    documentSharingCrypto: () => require('./lib/documentSharingCrypto'),
    notebookFileCrypto: () => require('./lib/notebookFileCrypto'),
});

const { initDB } = require('./notebook/schema');
const { MAX_CARD_LIMIT, buildListCardsQuery, mapNotebookCardRow } = require('./notebook/cards');
const {
    createNotebook, getNotebooks, listNotebookCards, getNotebook, updateNotebook, updateNotebookCas, attachKnowledgeBaseIfAbsent, deleteNotebook,
} = require('./notebook/notebooks');
const {
    resolveNotebookRole, notebookRoleForProjectRole, setNotebookProject, detachNotebookFromProject,
    listProjectNotebooks, countProjectNotebooks, clearProjectFromNotebooks, writeCollabContent,
} = require('./notebook/membership');
const {
    touchActivity, addSource, getSources, getSource, getSourceContent, getSourceStatus, countSources,
    deleteSources, reorderSources, updateSource, claimSourceForRetry, deleteSource, timeoutStuckSources,
} = require('./notebook/sources');
const { VERSION_SOURCES, VERSION_NAME_MAX, contentHash } = require('./notebook/versionModel');
const {
    recordVersion, latestVersion, listVersions, createVersion, getVersions, getVersion,
    getNotebookVersion, nameVersion, deleteVersion, shouldAutoVersion,
} = require('./notebook/versions');

module.exports = {
    // Notebooks
    MAX_CARD_LIMIT,
    createNotebook,
    getNotebooks,
    listNotebookCards,
    buildListCardsQuery,
    mapNotebookCardRow,
    getNotebook,
    updateNotebook,
    updateNotebookCas,
    touchActivity,
    attachKnowledgeBaseIfAbsent,
    deleteNotebook,
    // Project membership
    resolveNotebookRole,
    notebookRoleForProjectRole,
    setNotebookProject,
    detachNotebookFromProject,
    listProjectNotebooks,
    countProjectNotebooks,
    clearProjectFromNotebooks,
    // Sources
    addSource,
    getSources,
    getSource,
    getSourceContent,
    getSourceStatus,
    countSources,
    deleteSources,
    reorderSources,
    updateSource,
    claimSourceForRetry,
    deleteSource,
    timeoutStuckSources,
    // Versions
    VERSION_SOURCES,
    VERSION_NAME_MAX,
    recordVersion,
    latestVersion,
    listVersions,
    createVersion,
    getVersions,
    getVersion,
    getNotebookVersion,
    nameVersion,
    deleteVersion,
    shouldAutoVersion,
    contentHash,
    // Co-editing
    writeCollabContent,
    // Awaitable init entry for migrateDb (memoised: the same promise as the load-time init).
    initDB,
};
