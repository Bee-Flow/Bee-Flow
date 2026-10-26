// @typecheck strict
/**
 * Studio App Store — PostgreSQL persistence for App Studio apps.
 *
 * An app is a structured JSON component tree (never code) whose schema is
 * owned by ../appStudio/componentSpecs.js — this store treats the definition
 * as an opaque JSONB blob and only enforces the byte ceiling
 * (LIMITS.MAX_DEFINITION_BYTES). Validation/canonicalization happen in the
 * appStudio layer before anything reaches saveDefinition.
 *
 * Two tables:
 *   • studio_apps          — one row per app: working definition (+ optimistic
 *                            definition_version), the frozen published_definition
 *                            served to viewers, publish/share scope, and the AI
 *                            builder-session snapshot.
 *   • studio_app_versions  — immutable definition snapshots taken at publish
 *                            time (newest 20 kept per app).
 *
 * Publishing follows the same 3-mode model as agents/KBs/webpages:
 * Personal (is_published=false), Entire Org (is_published=true,
 * shared_groups=[]), Specific Groups (is_published=true, shared_groups=[...]).
 *
 * A barrel since the split: schema and init in stores/studioApp/schema.js, app
 * CRUD in studioApp/apps.js, publish / audience / deploy flip in
 * studioApp/publish.js, deletion with its data purge in studioApp/deleteApp.js,
 * version history in studioApp/versions.js, the access predicates in
 * studioApp/access.js, the builder snapshot in studioApp/builderSession.js,
 * Nextcloud menu / projects / public pages in studioApp/publication.js, and
 * the guarded writers with the automation-usage reindex in
 * studioApp/writers.js. The exported keys are unchanged.
 */

// The studioApp modules get the db, the logger and the lazily required
// collaborators from here (see studioApp/deps.js): the same require strings,
// from the same file, as before the split. Installed before the first loads.
require('./studioApp/deps').install({
    db: require('../db'),
    log: require('../telemetry/log'),
    // Lazy, as they always were: required on first use, not at load.
    migration: (/** @type {string} */ name) => require(`../migrations/${name}`),
    managedPartsDefault: () => require('./managedPartsDefault'),
    engineFlag: () => require('../utils/engineFlag'),
    projectStore: () => require('./projectStore'),
    projectAccess: () => require('../auth/projectAccess'),
    studioAppDbStore: () => require('./studioAppDbStore'),
    storageStore: () => require('./storageStore'),
    automationUsageSync: () => require('../appStudio/automationUsageSync'),
});

const { initDB } = require('./studioApp/schema');
const {
    getStudioApp, getStudioAppsByUser, getAccessibleStudioApps, setTemplateStamp, setTemplateProvenance,
} = require('./studioApp/apps');
const { MAX_VERSIONS_PER_APP, createVersionSnapshot, listVersions, getVersion } = require('./studioApp/versions');
const {
    canReadStudioApp, canReadStudioAppAsync, canWriteStudioApp, userHasAnyStudioAppAccess,
} = require('./studioApp/access');
const {
    SNAPSHOT_MAX_BYTES, PINNED_SNAPSHOT_KEYS, SNAPSHOT_TRIM_MARKER, getBuilderSession, clearBuilderSession,
} = require('./studioApp/builderSession');
const {
    setStudioAppNextcloudMenu, listNextcloudMenuApps, MAX_NEXTCLOUD_MENU_APPS,
    listProjectApps, countProjectApps, setAppProject, clearProjectFromApps,
    createPublicPage, getPublicPage, listPublicPages, deletePublicPage, touchPublicPage,
} = require('./studioApp/publication');
const {
    makeStudioAppWriters, writers, createStudioAppIndexed, saveDefinitionIndexed, restoreVersionIndexed,
    setStudioAppPublishedIndexed, deleteStudioAppIndexed,
} = require('./studioApp/writers');

module.exports = {
    get ready() { return initDB(); },
    initDB,
    listProjectApps,
    countProjectApps,
    setAppProject,
    clearProjectFromApps,
    MAX_VERSIONS_PER_APP,
    SNAPSHOT_MAX_BYTES,
    PINNED_SNAPSHOT_KEYS,
    SNAPSHOT_TRIM_MARKER,
    // Apps — the three definition writers and the delete go through their
    // reindexing wrapper; see studioApp/writers.js.
    createStudioApp: createStudioAppIndexed,
    getStudioApp,
    getStudioAppsByUser,
    getAccessibleStudioApps,
    updateStudioApp: writers.updateStudioApp,
    setTemplateStamp,
    setTemplateProvenance,
    saveDefinition: saveDefinitionIndexed,
    setStudioAppPublished: setStudioAppPublishedIndexed,
    // Solution stages: the audience alone (never the published copy), the
    // deploy's commit flip, and the stage an app belongs to.
    setStudioAppAudience: writers.setStudioAppAudience,
    // No reindex here: it runs inside the deploy's commit, and a detached
    // reindex would read before the commit lands. The deploy's converge phase
    // reindexes the app's automation usage after the commit.
    publishDefinitionWith: writers.publishDefinitionWith,
    managedInfoOfApp: writers.managedInfoOfApp,
    makeStudioAppWriters,
    deleteStudioApp: deleteStudioAppIndexed,
    // Nextcloud app-menu publication
    setStudioAppNextcloudMenu,
    listNextcloudMenuApps,
    MAX_NEXTCLOUD_MENU_APPS,
    // Publish-version history
    createVersionSnapshot,
    listVersions,
    getVersion,
    // Also a definition writer, so also through the wrapper — a restored
    // version can name other automations than the version it replaces.
    restoreVersion: restoreVersionIndexed,
    // Access
    canReadStudioApp,
    canReadStudioAppAsync,
    canWriteStudioApp,
    userHasAnyStudioAppAccess,
    // Builder session
    getBuilderSession,
    setBuilderSession: writers.setBuilderSession,
    clearBuilderSession,
    // Public pages (anonymous entry points)
    createPublicPage,
    getPublicPage,
    listPublicPages,
    deletePublicPage,
    touchPublicPage,
};
