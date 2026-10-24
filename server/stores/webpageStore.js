// @typecheck
/**
 * Webpage Store — PostgreSQL metadata + RustFS object storage for static webpages.
 *
 * Three tables:
 *   • webpages          — top-level webpage (name, instructions, KB links, settings, file hashes/sizes)
 *   • webpage_sources   — individual sources within a webpage (PDF, DOCX, URL, text, etc.)
 *   • webpage_versions  — immutable file-trio snapshots for version history
 *
 * File storage layout (RustFS):
 *   users/{userId}/webpages/{webpageId}/current/index.html       (slot='html')
 *   users/{userId}/webpages/{webpageId}/current/style.css        (slot='css')
 *   users/{userId}/webpages/{webpageId}/current/script.js        (slot='js')
 *   users/{userId}/webpages/{webpageId}/versions/{versionId}/<filename>
 *
 * The DB carries hashes + sizes for change detection and cheap list rendering;
 * file bytes never live in Postgres rows.
 *
 * Facade: the implementation lives in ./webpage/* aggregates behind this
 * stable path — every require('../stores/webpageStore') caller is unchanged.
 * Each aggregate exports its public functions; this file re-exports the same
 * references under the identical surface this file had before the split.
 */

const webpageSchema = require('./webpage/schema');
const { SLOTS, VERSIONED_SLOTS, sha256, keyFor } = require('./webpage/shared');
const {
    readSlot, readAllSlots, writeSlot, restoreSlotFromVersion, slotsAreReadable,
    thumbnailKey, writeThumbnail, readThumbnail, purgeWebpageObjects,
} = require('./webpage/storage');
const {
    listExtraFiles, getExtraFile, readExtraFile,
    upsertExtraFile, upsertBinaryExtraFile, deleteExtraFile,
    validateExtraPath, isTextFile, guessMime,
} = require('./webpage/extraFiles');
const {
    createWebpage, getWebpages, getWebpage, getWebpageRaw,
    setWebpagePublished, setPublishedVersion, updateWebpageMetadata,
    getChatMessages, setChatMessages, cloneWebpage, deleteWebpage,
} = require('./webpage/webpages');
const {
    getAccessibleWebpages, userHasAnyWebpageAccess,
    canReadWebpage, canWriteWebpage, canReadWebpageAsync, resolveReadVersion,
} = require('./webpage/access');
const {
    listProjectWebpages, countProjectWebpages, setWebpageProject, clearProjectFromWebpages,
} = require('./webpage/projects');
const {
    addSource, getSources, getSource, updateSource, deleteSource, timeoutStuckSources,
} = require('./webpage/sources');
const {
    createVersion, createVersionSnapshotFromFiles, getVersions, getVersion, getVersionMeta, deleteVersion,
    shouldAutoVersion, VERSION_SOURCES,
} = require('./webpage/versions');
const {
    getBridgeGrants, updateBridgeGrants, upsertBridgeGrantEntry,
    removeBridgeGrantEntry, checkGrant, normalizeBridgeGrants, assertWebpageWrite,
} = require('./webpage/bridgeGrants');
const managedParts = require('./managedPartsDefault');
const log = require('../telemetry/log');
const { bestEffort } = require('../utils/bestEffort');

/**
 * ── THE DEPENDENTS INDEX HANGS ON THE WRITER, NOT ON THE ROUTE ────────
 *
 * `automation_datatable_usage` answers "who touches this table", and three surfaces believe
 * what it says: the Used-by list of a table, the 409 that holds back its deletion, and the
 * warning when a column is dropped. `reconcileUsageFor` is delete-then-insert, so a writer that
 * skips the reconcile leaves the rows of the PREVIOUS version in place: a table reference that
 * disappears from the code keeps a 409 up, and one that is added never appears in it.
 *
 * That reconcile used to live in the ROUTES, and there every new writer kept opening a new gap:
 * the ordinary assistant chat (`routes/ai/directChat/toolExec.js`), an agent or automation via
 * the tool dispatcher (`core/tools/toolDispatcher.js` → `integrations/webpageAutomationTools.js`),
 * the automation builder chat (`routes/ai/automationBuilder/chatStream.js`) and the upgrade path
 * of a Solution (`projects/packaging/upgrade.js`) all write page code without ever passing
 * through a webpage route.
 *
 * That is why it lives here, in the four functions that really change a page's code. This is the
 * only place where "a page has changed" and "the index is out of date" are the same fact.
 * Debounced and detached: it is an index, not an edit, and a save neither waits for it nor breaks
 * because of it. The calls in the routes remain — they are now redundant but not wrong, and
 * `automation/usageSync.savePaths.test.js` reads them.
 *
 * Deliberately NOT around `upsertBinaryExtraFile`: that writes `is_text=false` and `readPageCode`
 * does not read such files, so it cannot change what the page binds.
 */
function reindex(webpageId) {
    if (!webpageId) return;
    try {
        require('../core/webpages/webpageUsageSync').reconcileWebpageUsageDetached(webpageId);
    } catch (err) { bestEffort('stores/webpageStore:reindex', err); /* Een index mag een schrijfactie nooit laten omvallen. */ }
}

/*
 * ── MANAGED PAGES (Solution stages) ─────────────────────────────────
 *
 * The file writers below are guarded HERE, before any byte reaches object
 * storage: a page filed into a stage project is managed
 * (stores/lib/managedParts.js), and its files change only through a deploy,
 * which passes `{ managedWrite: { deploymentId } }` as the last argument
 * (inside the args object for the extra-file writers). Extra files are not
 * carried by a release in v1, so a managed page refuses them outright unless
 * a deploy writes them. The row writers (metadata, pointer, grants, chat,
 * delete) guard themselves in ./webpage/*.
 */

async function writeSlotIndexed(userId, webpageId, slot, content, opts = {}) {
    await assertWebpageWrite(webpageId, ['files'], opts);
    const out = await writeSlot(userId, webpageId, slot, content);
    reindex(webpageId);
    return out;
}

async function upsertExtraFileIndexed(args) {
    await assertWebpageWrite(args && args.webpageId, ['extraFiles'], { managedWrite: args && args.managedWrite });
    const out = await upsertExtraFile(args);
    reindex(args && args.webpageId);
    return out;
}

async function upsertBinaryExtraFileGuarded(args) {
    await assertWebpageWrite(args && args.webpageId, ['extraFiles'], { managedWrite: args && args.managedWrite });
    return upsertBinaryExtraFile(args);
}

async function deleteExtraFileIndexed(args) {
    await assertWebpageWrite(args && args.webpageId, ['extraFiles'], { managedWrite: args && args.managedWrite });
    const out = await deleteExtraFile(args);
    reindex(args && args.webpageId);
    return out;
}

async function restoreSlotFromVersionIndexed(userId, webpageId, versionId, slot, opts = {}) {
    await assertWebpageWrite(webpageId, ['files'], opts);
    const out = await restoreSlotFromVersion(userId, webpageId, versionId, slot);
    reindex(webpageId);
    return out;
}

/**
 * The stage that manages this page, or null (cached, see managedParts).
 *
 * @param {{ projectId?: string|null }|null} webpage
 */
async function managedInfoOf(webpage) {
    return managedParts.managedInfo(webpage && webpage.projectId ? webpage.projectId : '');
}

/**
 * What a webpage GET adds as `managed` (design 5.3): null, or
 * `{solutionId, solutionName, stage, releaseSeq, devRef}`. A failed lookup
 * answers null and is logged; a GET never fails on it.
 *
 * @param {{ id: string, projectId?: string|null }|null} webpage
 */
async function managedPayloadOf(webpage) {
    if (!webpage || !webpage.projectId) return null;
    try {
        return await require('./solutionStageStore').managedPayloadFor({
            projectId: webpage.projectId, kind: 'webpage', entityId: webpage.id,
        });
    } catch (err) {
        log.warn(`[WebpageStore] managed lookup for ${webpage.id} failed: ${err.message}`);
        return null;
    }
}

module.exports = {
    SLOTS,
    VERSIONED_SLOTS,
    // Forwarded as a getter so requiring this facade does not start the
    // schema init — see webpage/schema.js.
    get ready() { return webpageSchema.ready; },
    // Webpages
    createWebpage,
    getWebpages,
    getWebpage,
    getWebpageRaw,
    getAccessibleWebpages,
    canReadWebpage,
    canWriteWebpage,
    resolveReadVersion,
    // Project membership
    listProjectWebpages,
    countProjectWebpages,
    setWebpageProject,
    clearProjectFromWebpages,
    canReadWebpageAsync,
    userHasAnyWebpageAccess,
    setWebpagePublished,
    setPublishedVersion,
    updateWebpageMetadata,
    cloneWebpage,
    deleteWebpage,
    // Chat history
    getChatMessages,
    setChatMessages,
    // RustFS slot I/O
    sha256,
    keyFor,
    readSlot,
    slotsAreReadable,
    readAllSlots,
    writeSlot: writeSlotIndexed,
    restoreSlotFromVersion: restoreSlotFromVersionIndexed,
    purgeWebpageObjects,
    // Thumbnail
    writeThumbnail,
    readThumbnail,
    thumbnailKey,
    // Extra files (multi-file)
    listExtraFiles,
    getExtraFile,
    readExtraFile,
    upsertExtraFile: upsertExtraFileIndexed,
    upsertBinaryExtraFile: upsertBinaryExtraFileGuarded,
    deleteExtraFile: deleteExtraFileIndexed,
    validateExtraPath,
    isTextFile,
    guessMime,
    // Runtime bridge grants
    getBridgeGrants,
    updateBridgeGrants,
    upsertBridgeGrantEntry,
    removeBridgeGrantEntry,
    checkGrant,
    normalizeBridgeGrants, // exported for unit tests (pure)
    // Managed pages (Solution stages)
    assertWebpageWrite,
    managedInfoOf,
    managedPayloadOf,
    // Sources
    addSource,
    getSources,
    getSource,
    updateSource,
    deleteSource,
    timeoutStuckSources,
    // Versions
    VERSION_SOURCES,
    createVersion,
    createVersionSnapshotFromFiles,
    getVersions,
    getVersion,
    getVersionMeta,
    deleteVersion,
    shouldAutoVersion,
};
