// @typecheck
/**
 * stores/studioApp/writers.js — the guarded writers bound to one database
 * (makeStudioAppWriters), the app's own set over db.js, and the wrappers that
 * keep the automation-usage index in step with every definition write.
 */

const { dep } = require('./deps');
const { initDB } = require('./schema');
const { guardOf } = require('./shared');
const { createStudioApp, updateStudioApp, saveDefinition } = require('./apps');
const { setStudioAppPublished, setStudioAppAudience, publishDefinitionWith } = require('./publish');
const { deleteStudioApp } = require('./deleteApp');
const { restoreVersion } = require('./versions');
const { setBuilderSession } = require('./builderSession');
const log = require('../../telemetry/log');

const { run, getOne, getAll, getClient } = dep('db');

// ── The guarded writers, over one database ─────────────────────────
//
// Every writer the managed-write lock covers takes an `io` context as its first
// argument: the database, its schema init and the guard. Those functions are
// module-private under their exported names; the app binds them to db.js below;
// a pglite test builds its own set with makeStudioAppWriters, so the lock is
// proven against a real Postgres without replacing a module.

/**
 * @param {{ run: Function, getOne: Function, getAll: Function, getClient: () => Promise<any> }} db
 * @param {{ ready?: () => Promise<unknown>, managedParts?: { assertManagedWrite: Function }|null }} [opts]
 */
function makeStudioAppWriters(db, { ready = async () => {}, managedParts = null } = {}) {
    const io = { db, ready, managedParts };
    return {
        updateStudioApp: (id, updates, ownerId, opts) => updateStudioApp(io, id, updates, ownerId, opts),
        saveDefinition: (id, ownerId, definition, opts) => saveDefinition(io, id, ownerId, definition, opts),
        setStudioAppPublished: (id, isPublished, ownerId, sharedGroups, organizationId, publishedDefinition, publishedVersion) =>
            setStudioAppPublished(io, id, isPublished, ownerId, sharedGroups, organizationId, publishedDefinition, publishedVersion),
        setStudioAppAudience: (id, ownerId, audience) => setStudioAppAudience(io, id, ownerId, audience),
        publishDefinitionWith: (client, id, definition, version, opts) => publishDefinitionWith(io, client, id, definition, version, opts),
        deleteStudioApp: (id, ownerId, opts) => deleteStudioApp(io, id, ownerId, opts),
        restoreVersion: (appId, versionId, ownerId, opts) => restoreVersion(io, appId, versionId, ownerId, opts),
        setBuilderSession: (appId, userId, snapshot, opts) => setBuilderSession(io, appId, userId, snapshot, opts),
        /** null | {solutionId, stage, stageProjectId}: the stage an app belongs to (cached lookup). */
        managedInfoOfApp: (app) => guardOf(io).managedInfo(app && app.projectId ? app.projectId : null),
    };
}

// The app's set: db.js behind the store's schema init. Wrapped, not bound, so
// a test that replaces '../db' before requiring this store is still honoured.
const writers = makeStudioAppWriters({
    run: (sql, params) => run(sql, params),
    getOne: (sql, params) => getOne(sql, params),
    getAll: (sql, params) => getAll(sql, params),
    getClient: () => getClient(),
}, { ready: initDB });

// ── THE AUTOMATION INDEX HANGS ON THE WRITER, NOT ON THE ROUTE ─────
//
// `automation_usage` answers "which button runs this automation", and the
// automation editor shows that as the capsule "Used by 1 button". It is the
// only screen on which someone about to delete or deactivate an automation
// sees that an app button depends on it.
//
// `reconcileAutomationUsage` is delete-then-insert on (consumer_kind,
// consumer_id), so a writer that skips the reconcile leaves the rows of the
// PREVIOUS definition in place: an action that loses its automation keeps the
// capsule alive, and one that gains one never gets in.
//
// That is why it sits here, around the THREE functions that really change
// `studio_apps.definition` — createStudioApp, saveDefinition and
// restoreVersion. This is the only place where "the app changed" and "the
// index is stale" are the same fact. In the routes every new writer would be
// a new hole: besides the four app routes, the install and the upgrade of a
// Solution (projects/packaging/install.js, upgrade.js) and the AI builder
// (appStudio/builderTools/persistence.js) write a definition without ever
// passing an app route. Together that is ten call sites on three writers;
// appStudio/automationUsage.savePaths.test.js COUNTS them instead of naming
// one.
//
// ALSO around `setStudioAppPublished`, and since the closing round of P4 that
// is a deliberate reversal. That function freezes a COPY
// (`published_definition`) and does not touch the working definition — but
// the index is about the question "who breaks if I throw this automation
// away", and that is a question about PRODUCTION. Visitors run the published
// copy, so it counts: the reconciler builds the UNION of draft and published
// (appStudio/automationUsageSync.js), and then publishing and UNPUBLISHING do
// change what belongs in the index.
//
// Debounced and detached: it is an index, not an edit. A save does not wait
// for it and does not break on it.
function reindexAutomationUsage(appId) {
    if (!appId) return;
    try {
        dep('automationUsageSync')().reconcileAppAutomationUsageDetached(appId);
    } catch (err) { log.debug('An index must never bring a write down.', err); }
}

async function createStudioAppIndexed(args) {
    const app = await createStudioApp(args);
    reindexAutomationUsage(app && app.id);
    return app;
}

async function saveDefinitionIndexed(id, ownerId, definition, opts) {
    const out = await writers.saveDefinition(id, ownerId, definition, opts);
    // Only after a REAL write. A CAS conflict or an app that was not found
    // changed nothing, and then a scan is just work.
    if (out && out.ok) reindexAutomationUsage(id);
    return out;
}

async function restoreVersionIndexed(appId, versionId, ownerId, opts) {
    const out = await writers.restoreVersion(appId, versionId, ownerId, opts);
    if (out) reindexAutomationUsage(appId);
    return out;
}

async function setStudioAppPublishedIndexed(id, ...rest) {
    const out = await writers.setStudioAppPublished(id, ...rest);
    // Publishing changes the PUBLISHED half of the union, unpublishing takes
    // it away. Only after a real write: `false` means the app does not exist
    // or is not this owner's, and then nothing changed.
    if (out) reindexAutomationUsage(id);
    return out;
}

/**
 * Deleting cleans up the index. No FK — `automations` and `automation_usage`
 * belong to other stores — so without this a row stays behind that tells an
 * automation owner that a button they cannot see triggers their automation.
 * Awaited, unlike the reconcile: a purge racing the deletion could put the
 * rows back. Never throws (the purge catches itself).
 */
async function deleteStudioAppIndexed(id, ownerId, opts) {
    const out = await writers.deleteStudioApp(id, ownerId, opts);
    if (out) {
        await dep('automationUsageSync')().purgeAppAutomationUsage(id);
    }
    return out;
}

module.exports = {
    makeStudioAppWriters,
    writers,
    createStudioAppIndexed,
    saveDefinitionIndexed,
    restoreVersionIndexed,
    setStudioAppPublishedIndexed,
    deleteStudioAppIndexed,
};
