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
    createVersion, getVersions, getVersion, getVersionMeta, deleteVersion, shouldAutoVersion,
    VERSION_SOURCES,
} = require('./webpage/versions');
const {
    getBridgeGrants, updateBridgeGrants, upsertBridgeGrantEntry,
    removeBridgeGrantEntry, checkGrant, normalizeBridgeGrants,
} = require('./webpage/bridgeGrants');

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
 * toolExec.js`), een agent of routine via de tooldispatcher
 * (`core/tools/toolDispatcher.js` → `integrations/webpageAutomationTools.js`),
 * de routine-bouwerchat (`routes/ai/automationBuilder/chatStream.js`) en het
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

async function writeSlotIndexed(userId, webpageId, slot, content) {
    const out = await writeSlot(userId, webpageId, slot, content);
    reindex(webpageId);
    return out;
}

async function upsertExtraFileIndexed(args) {
    const out = await upsertExtraFile(args);
    reindex(args && args.webpageId);
    return out;
}

async function deleteExtraFileIndexed(args) {
    const out = await deleteExtraFile(args);
    reindex(args && args.webpageId);
    return out;
}

async function restoreSlotFromVersionIndexed(userId, webpageId, versionId, slot) {
    const out = await restoreSlotFromVersion(userId, webpageId, versionId, slot);
    reindex(webpageId);
    return out;
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
    upsertBinaryExtraFile,
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
    getVersions,
    getVersion,
    getVersionMeta,
    deleteVersion,
    shouldAutoVersion,
};
