// @typecheck
/**
 * Small helpers the Studio app routes share (routes/studioApps/).
 *
 * The managed-part label, the client-error rethrow, the row sanitiser and the
 * loaders validate.js cross-checks a definition against.
 */

const log = require('../../telemetry/log');
const studioAppDataStore = require('../../stores/studioAppDataStore');
const automationStore = require('../../stores/automationStore');
// `managed` on GET /:id: which Solution stage, if any, owns this app.
const managedParts = require('../../stores/managedPartsDefault');
const solutionStageStore = require('../../stores/solutionStageStore');

/**
 * `managed: null | {solutionId, solutionName, stage, releaseSeq, devRef}` for
 * an app of a Solution stage (design 5.3); the client never derives it. The
 * cached stage lookup answers the common case (no stage) without a query. A
 * failed read is null: it labels the builder, it decides nothing (the store
 * refuses a managed write on its own).
 */
async function managedOf(app) {
    if (!app || !app.projectId) return null;
    try {
        if (!await managedParts.managedInfo(app.projectId)) return null;
        return await solutionStageStore.managedPayloadFor({ projectId: app.projectId, kind: 'app', entityId: app.id });
    } catch (e) {
        log.warn(`[StudioApps] managed lookup failed for ${app.id}: ${e.message}`);
        return null;
    }
}

// Ceiling on the directory category (APPS-04). Not a validation of the value —
// the org's closed list is what decides that, and it does not live here yet —
// only a ceiling, so a pasted paragraph can never become a filter pill.
const MAX_CATEGORY_LEN = 64;

// The store never puts builder_session on app rows, but strip it anyway so a
// future store change can't silently start leaking the AI chat snapshot.
function sanitizeAppRow(app) {
    if (!app || typeof app !== 'object') return app;
    const { builderSession, builder_session, ...rest } = app;
    return rest;
}

// Owner's automations in the shape validate.js expects for opts.ownedAutomations.
async function loadOwnedAutomations(ownerId) {
    const owned = await automationStore.getAutomationsForUser(ownerId);
    return (owned || []).map(a => ({ id: a.id, userId: a.userId, isActive: a.isActive }));
}

// The app's data model + dataset ids in the shape validate.js expects for
// opts.dataModel/opts.datasets (data-reference cross-checks). `model` is null
// when the app has no data model yet — validate treats every table reference
// as unknown then, which is exactly right.
//
// `datatables` is de derde: zonder die lijst was `binding.unknown_datatable`
// onbereikbaar (geen enkele aanroeper vulde opts.datatables) en kreeg élke
// binding op een gekoppelde tabel bij élke save de waarschuwing
// `binding.datatable_unverified` die de auteur nooit kon wegwerken — terwijl
// een app met een datatableId die nergens naar wijst schoon publiceerde en pas
// bij de eerste lezing brak.
async function loadDataRefs(appId, ownerId) {
    const meta = await studioAppDataStore.getDataModel(appId, ownerId);
    const datasets = await studioAppDataStore.listDatasets(appId, ownerId);
    return {
        dataModel: (meta && meta.model) ? meta.model : null,
        datasets: (datasets || []).map(d => d.id),
        datatables: await require('../../appStudio/datatableSource').listOwnerDatatableIds(ownerId),
    };
}

module.exports = {
    managedOf,
    MAX_CATEGORY_LEN,
    sanitizeAppRow,
    loadOwnedAutomations,
    loadDataRefs,
};
