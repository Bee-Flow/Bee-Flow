// @typecheck strict
/**
 * Knowledge Bases Store — Multi-KB management
 * 
 * Tables: knowledge_bases, documents
 * Chunks are managed by the search-service (kb_chunks table).
 *
 * Since the split this barrel only wires the pieces together: the vocabulary
 * (status model, projections, filters) in stores/kb/model.js, the schema in
 * kb/schema.js, the Solution-stage write guard in kb/managedWrite.js, KB CRUD,
 * categories and favourites in kb/catalog.js, listing and access predicates
 * in kb/access.js, document writes in kb/documents.js and reads in
 * kb/documentQueries.js, version snapshots in kb/versions.js.
 *
 * Every dependency is still required HERE, under the same request strings
 * (the hermetic tests stub '../db', './managedPartsDefault', ...), and handed
 * to the kb/ factories. The export is ONE object with the same keys in the
 * same order; methods call each other through it (`self`), so a method a test
 * or caller swaps on the export is the one the others reach.
 */

const { run, getOne, getAll, exec } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { runDdl, CODES } = require('./lib/_ddl');
const log = require('../telemetry/log');
const managedParts = require('./managedPartsDefault');
const { DOC_STATUSES, ACTIVE_DOC_STATUSES, PII_STATUSES, DOCUMENT_COLUMNS } = require('./kb/model');
const { makeSchemaInit } = require('./kb/schema');
const { makeKbWriteGuard } = require('./kb/managedWrite');
const { makeCatalogFns } = require('./kb/catalog');
const { makeAccessFns } = require('./kb/access');
const { makeDocumentFns } = require('./kb/documents');
const { makeDocumentQueryFns } = require('./kb/documentQueries');
const { makeVersionFns } = require('./kb/versions');

// kbSources requires this store back (lazily, in its own initDB): resolve it
// per call, never at load.
const _initDB = makeSchemaInit({
    exec, getOne, runDdl, CODES, log,
    ensureSourcesSchema: () => require('./kbSources').ensureSchema(),
});
const initDB = makeStoreInit('KnowledgeBases', _initDB);

const { assertKbWrite, kbUpdateChanges } = makeKbWriteGuard(managedParts);

/** @type {Record<string, any>} */
const KnowledgeBasesStore = {};
const ctx = {
    run, getOne, getAll, initDB, log, managedParts, assertKbWrite, kbUpdateChanges,
    // Lazy: solutionStageStore sits in the stores' stage knot.
    stageStore: () => require('./solutionStageStore'),
    self: KnowledgeBasesStore,
};
const catalog = makeCatalogFns(ctx);
const access = makeAccessFns(ctx);
const documents = makeDocumentFns(ctx);
const queries = makeDocumentQueryFns(ctx);
const versions = makeVersionFns(ctx);

Object.assign(KnowledgeBasesStore, {
    DOC_STATUSES,
    ACTIVE_DOC_STATUSES,
    PII_STATUSES,
    DOCUMENT_COLUMNS,
    /** Resolves once the schema is initialised. Used by dependent stores (kbSources). */
    whenReady: () => initDB(),

    // ── KB CRUD ──
    createKB: catalog.createKB,
    getSystemKBBySlug: catalog.getSystemKBBySlug,
    listSystemKBs: catalog.listSystemKBs,
    isSystemKB: catalog.isSystemKB,
    isProjectFilesKB: catalog.isProjectFilesKB,
    listKBs: access.listKBs,
    filterByGroupAccess: access.filterByGroupAccess,
    canUserAccessKB: access.canUserAccessKB,
    canUserManageKB: access.canUserManageKB,
    getKB: catalog.getKB,
    updateKB: catalog.updateKB,
    setPublished: catalog.setPublished,
    listKBCategories: catalog.listKBCategories,
    createKBCategory: catalog.createKBCategory,
    deleteKBCategory: catalog.deleteKBCategory,
    assertKbWrite: catalog.assertKbWrite,
    managedPayload: catalog.managedPayload,
    deleteKB: catalog.deleteKB,
    bumpKBVersion: catalog.bumpKBVersion,

    // ── Document CRUD ──
    createDocument: documents.createDocument,
    recordDuplicate: documents.recordDuplicate,
    findNearDuplicateBySimhash: queries.findNearDuplicateBySimhash,
    updateDocumentStatus: documents.updateDocumentStatus,
    replaceDocumentContent: documents.replaceDocumentContent,
    findDocumentsBySourceExternalId: queries.findDocumentsBySourceExternalId,
    findDocumentBySourceExternalId: queries.findDocumentBySourceExternalId,
    countsBySource: queries.countsBySource,
    countDocumentsByStatus: queries.countDocumentsByStatus,
    listDocuments: queries.listDocuments,
    countDocuments: queries.countDocuments,
    listThreads: queries.listThreads,
    listDocumentsByThread: queries.listDocumentsByThread,
    getDocument: queries.getDocument,
    getDocumentOriginalContent: queries.getDocumentOriginalContent,
    deleteDocument: documents.deleteDocument,
    updateDocumentSourceUri: documents.updateDocumentSourceUri,
    hasContentHash: queries.hasContentHash,
    findDocumentByContentHash: queries.findDocumentByContentHash,
    findDocumentBySourceUri: queries.findDocumentBySourceUri,
    updateChunkCount: documents.updateChunkCount,
    hashContent: documents.hashContent,

    // ── KB Favorites ──
    listFavorites: catalog.listFavorites,
    addFavorite: catalog.addFavorite,
    removeFavorite: catalog.removeFavorite,

    // ── KB Versioning ──
    snapshotKBVersion: versions.snapshotKBVersion,
    listKBVersions: versions.listKBVersions,
    getKBVersion: versions.getKBVersion,
    snapshotDocumentVersion: versions.snapshotDocumentVersion,
    pruneDocumentVersions: versions.pruneDocumentVersions,
    listDeletedDocuments: versions.listDeletedDocuments,
});

module.exports = Object.assign(KnowledgeBasesStore, {
    // Awaitbare init-ingang voor migrateDb.
    initDB,
});
