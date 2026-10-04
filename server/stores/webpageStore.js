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
const managedParts = require('./lib/managedParts');
const log = require('../telemetry/log');

/**
 * ── DE DEPENDENTS-INDEX HANGT AAN DE SCHRIJVER, NIET AAN DE ROUTE ────
 *
 * `automation_datatable_usage` beantwoordt "wie raakt deze tabel aan", en drie
 * oppervlakken geloven wat er staat: de Wordt-gebruikt-door-lijst van een
 * tabel, de 409 die haar verwijdering tegenhoudt, en de waarschuwing bij het
 * laten vallen van een kolom. `reconcileUsageFor` is delete-then-insert, dus
 * een schrijver die de reconcile overslaat laat de rijen van de VORIGE versie
 * staan: een tabelverwijzing die uit de code verdwijnt houdt een 409 in de
 * lucht, en een die erbij komt staat er nooit in.
 *
 * Die reconcile heeft eerst in de ROUTES gewoond, en daar bleef elke nieuwe
 * schrijver een nieuw gat: de gewone assistent-chat (`routes/ai/directChat/
 * toolExec.js`), een agent of automatisering via de tooldispatcher
 * (`core/tools/toolDispatcher.js` → `integrations/webpageAutomationTools.js`),
 * de automation-bouwerchat (`routes/ai/automationBuilder/chatStream.js`) en het
 * upgrade-pad van een Oplossing (`projects/packaging/upgrade.js`) schrijven
 * alle vier paginacode zonder ooit langs een webpagina-route te komen.
 *
 * Daarom staat hij hier, om de vier functies die de code van een pagina echt
 * veranderen. Dat is de enige plek waar "een pagina is veranderd" en "de index
 * is achterhaald" hetzelfde feit zijn. Gedebouncet en detached: het is een
 * index, geen bewerking, en een save wacht er niet op en gaat er niet aan
 * kapot. De aanroepen in de routes blijven staan — ze zijn nu overtollig maar
 * niet fout, en `automation/usageSync.savePaths.test.js` leest ze.
 *
 * Bewust NIET om `upsertBinaryExtraFile`: die schrijft `is_text=false` en
 * `readPageCode` leest zulke bestanden niet, dus hij kan niet veranderen wat de
 * pagina bindt.
 */
function reindex(webpageId) {
    if (!webpageId) return;
    try {
        require('../core/webpages/webpageUsageSync').reconcileWebpageUsageDetached(webpageId);
    } catch (_) {
        // Een index mag een schrijfactie nooit laten omvallen.
    }
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
