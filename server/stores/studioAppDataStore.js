// @typecheck
/**
 * Studio App Data Store — PostgreSQL metadata for the App Studio v2 DATA
 * ENGINE. Sits between the per-app SQLite engine (studioAppDbStore.js) and the
 * data-model contract (../appStudio/dataModel.js).
 *
 * Where studioAppDbStore owns the *rows* (in per-app SQLite), THIS store owns
 * the *metadata about the data*: the versioned data model, per-table data
 * versions + row counts (cache-invalidation tokens), saved datasets and their
 * cached results, app membership/roles, and the attachment ledger.
 *
 * Tables (all self-init: CREATE TABLE IF NOT EXISTS + additive ALTER loop):
 *   • studio_app_data_meta      — one row per app: the data model (JSONB) +
 *                                 optimistic model_version, data_versions,
 *                                 row_counts. saveDataModel diffs old→new via
 *                                 dataModel.migrationPlan and pushes the DDL
 *                                 through studioAppDbStore.applyMigration.
 *   • studio_app_datasets       — named, reusable query descriptors over a
 *                                 table (source + descriptor + cache TTL).
 *   • studio_app_dataset_cache  — memoised dataset results keyed by
 *                                 viewer_scope_key + params_hash + data_version.
 *   • studio_app_members        — app_id + user_id → role_key (RLS input).
 *   • studio_app_attachments    — file attachment ledger (mirrors
 *                                 webpage_extra_files) with scan/quarantine.
 *
 * OWNERSHIP: every mutation is owner-scoped in its WHERE — either directly via
 * an owner_user_id column, or (for the ownerless studio_app_members PK) via an
 * ownsApp() gate against studio_apps. A foreign app id can never be written
 * through. See studioAppDataStore.idor.test.js.
 *
 * The parts live in stores/studioAppData/: cycleDeps.js, schema.js (DDL + init),
 * rowMappers.js, dataModel.js (CAS save + migration, reconcile), rowCounts.js
 * (data versions + row counts), datasets.js (datasets + result cache),
 * connectorSync.js (sync state + e-mail ledger), members.js and
 * attachments.js. This file is the store's one public entry.
 */

// The three collaborators in the server's big import cycle are required HERE
// (in their original order) and handed to the parts, so the split does not
// grow that cycle.
const appStudioDataModel = require('../appStudio/dataModel');
const studioAppDbStore = require('./studioAppDbStore');
const studioAppStore = require('./studioAppStore');
const { bindCycleDeps } = require('./studioAppData/cycleDeps');
bindCycleDeps({ dataModel: appStudioDataModel, studioAppDbStore, studioAppStore });

const { initDB } = require('./studioAppData/schema');
const dataModel = require('./studioAppData/dataModel');
const rowCounts = require('./studioAppData/rowCounts');
const datasets = require('./studioAppData/datasets');
const connectorSync = require('./studioAppData/connectorSync');
const members = require('./studioAppData/members');
const attachments = require('./studioAppData/attachments');

module.exports = {
    // Both spellings, like studioAppStore: awaiting `ready` is the same as
    // calling initDB(), and requiring this module creates nothing yet.
    get ready() { return initDB(); },
    initDB,
    // Data model
    getDataModel: dataModel.getDataModel,
    saveDataModel: dataModel.saveDataModel,
    makeDataModelSaver: dataModel.makeDataModelSaver,
    additiveModel: dataModel.additiveModel,
    reconcileDataModel: dataModel.reconcileDataModel,
    bumpDataVersion: rowCounts.bumpDataVersion,
    getRowCounts: rowCounts.getRowCounts,
    setRowCount: rowCounts.setRowCount,
    bumpRowCount: rowCounts.bumpRowCount,
    recountRows: rowCounts.recountRows,
    // Datasets
    createDataset: datasets.createDataset,
    listDatasets: datasets.listDatasets,
    getDataset: datasets.getDataset,
    updateDataset: datasets.updateDataset,
    deleteDataset: datasets.deleteDataset,
    // Dataset cache
    getCache: datasets.getCache,
    putCache: datasets.putCache,
    invalidateCache: datasets.invalidateCache,
    // Connector sync state
    getSyncState: connectorSync.getSyncState,
    listSyncStates: connectorSync.listSyncStates,
    claimSync: connectorSync.claimSync,
    finishSync: connectorSync.finishSync,
    listDueSyncs: connectorSync.listDueSyncs,
    deleteSyncState: connectorSync.deleteSyncState,
    reconcileSyncStates: connectorSync.reconcileSyncStates,
    SYNC_STALE_MS: connectorSync.SYNC_STALE_MS,
    // Outbound e-mail ledger
    logEmailSend: connectorSync.logEmailSend,
    listEmailSends: connectorSync.listEmailSends,
    // Members
    addMember: members.addMember,
    listMembers: members.listMembers,
    removeMember: members.removeMember,
    getMemberRole: members.getMemberRole,
    // Attachments
    addAttachment: attachments.addAttachment,
    listAttachments: attachments.listAttachments,
    getAttachment: attachments.getAttachment,
    setAttachmentScan: attachments.setAttachmentScan,
    deleteAttachment: attachments.deleteAttachment,
    countAttachments: attachments.countAttachments,
    countAttachmentsBySha: attachments.countAttachmentsBySha,
};
