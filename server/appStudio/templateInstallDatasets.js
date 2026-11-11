// @typecheck strict
/**
 * App Studio — the dataset side of a template install (./templateInstall.js step 3 and 4): the
 * template's datasets created in the app, and the stored definition's dataset bindings pointed at
 * them (./templateDatasetRefs.mts).
 */

'use strict';

const studioAppStore = require('../stores/studioAppStore');
const studioAppDataStore = require('../stores/studioAppDataStore');
const log = require('../telemetry/log');

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/**
 * The datasets of a template (BI descriptors). createDataset always mints a new
 * row, so an upgrade re-run dedupes by NAME: only datasets the app does not
 * have yet are created. Unknowable existing datasets fail safe (none created):
 * a duplicate dataset is confusing, a missing one is a one-click re-add.
 *
 * Returns the template's own dataset id → the id of the dataset that stands
 * for it in this app (created now, or on an upgrade the one of the same name),
 * for the bindings of the definition (templateDatasetRefs.mts).
 * @param {string} appId
 * @param {string} ownerId
 * @param {unknown[]} datasets
 * @param {boolean} missingOnly
 * @returns {Promise<Map<string, string>>}
 */
async function installDatasets(appId, ownerId, datasets, missingOnly) {
    const { datasetIdMap } = require('./templateDatasetRefs.mts');
    const existingByName = missingOnly ? await existingDatasetsByName(appId, ownerId) : null;
    /** @type {Array<[unknown, unknown]>} */
    const pairs = [];
    for (const ds of datasets) {
        if (!isObject(ds)) continue;
        const name = typeof ds.name === 'string' ? ds.name : '';
        if (missingOnly) {
            if (existingByName && existingByName.has(name)) pairs.push([ds.id, existingByName.get(name)]);
            if (!existingByName || existingByName.has(name)) continue;
        }
        try {
            const created = await studioAppDataStore.createDataset(appId, ownerId, {
                name,
                tableId: typeof ds.tableId === 'string' ? ds.tableId : undefined,
                // The store's JSDoc says string; it takes the source object and serializes it.
                source: /** @type {string | undefined} */ (ds.source),
                descriptor: ds.descriptor,
                cacheTtlSeconds: typeof ds.cacheTtlSeconds === 'number' ? ds.cacheTtlSeconds : undefined,
            });
            pairs.push([ds.id, created && created.id]);
        } catch (e) {
            log.warn(`[templateInstall] dataset skipped for ${appId}: ${errorText(e)}`);
        }
    }
    return datasetIdMap(pairs);
}

/**
 * The app's datasets by name, or null when they cannot be listed.
 * @param {string} appId
 * @param {string} ownerId
 * @returns {Promise<Map<string, string>|null>}
 */
async function existingDatasetsByName(appId, ownerId) {
    try {
        const existing = await studioAppDataStore.listDatasets(appId, ownerId);
        return new Map((existing || []).filter((d) => d && d.name).map((d) => [d.name, d.id]));
    } catch (e) {
        log.warn(`[templateInstall] dataset listing failed for ${appId} — skipping dataset creation: ${errorText(e)}`);
        return null;
    }
}

/** @param {unknown} e */
function errorText(e) {
    return e instanceof Error ? e.message : String(e);
}

/**
 * The stored definition with its dataset bindings pointed at this app's
 * datasets, saved. Returns the saved definition and its version, or null when no binding
 * needed it (or the save did not land: the bindings then keep the template's
 * ids, which the validator reports).
 * @param {{ id: string, definition?: unknown }} app
 * @param {string} ownerId
 * @param {Map<string, string>} datasetIds
 */
async function resolveStoredDatasetRefs(app, ownerId, datasetIds) {
    if (!datasetIds.size) return null;
    const { resolveDatasetRefs } = require('./templateDatasetRefs.mts');
    const current = await studioAppStore.getStudioApp(app.id);
    const resolved = resolveDatasetRefs(current && current.definition, datasetIds);
    if (!resolved.changed) return null;
    const saved = await studioAppStore.saveDefinition(app.id, ownerId, resolved.definition);
    if (!saved || saved.ok === false) {
        log.warn(`[templateInstall] dataset bindings not resolved for ${app.id}: the definition could not be saved`);
        return null;
    }
    return { definition: resolved.definition, definitionVersion: saved.version };
}


module.exports = { installDatasets, resolveStoredDatasetRefs };
