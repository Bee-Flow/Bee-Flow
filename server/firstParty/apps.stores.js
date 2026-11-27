// @typecheck strict
/**
 * The store schemas of the module "apps" (part of firstParty/apps.js, see
 * modules/firstParty/parts.js). The rows were the module's entries of
 * storeModules.js STORE_MODULES; their order stays the core's
 * (modules/firstParty/order.json).
 */

'use strict';

/** @type {import('../modules/firstParty/contract').StoreRow[]} */
const stores = [
    { name: 'appStore', file: './stores/appStore' },
    // App Studio — studio_apps / studio_app_versions (self-init on load).
    { name: 'studioAppStore', file: './stores/studioAppStore' },
    // App Studio v2 DATA ENGINE metadata — studio_app_data_meta / datasets /
    // dataset_cache / members / attachments. FK-depends on studio_apps, so it
    // MUST come after studioAppStore (its initDB awaits studioAppStore.ready).
    { name: 'studioAppDataStore', file: './stores/studioAppDataStore' },
    // App Studio LARGE DATASET manifests (multi-GB genome files) — multipart
    // upload state + ingest claims + artifact keys. Own DDL, no FK.
    { name: 'datasetFileStore', file: './stores/datasetFileStore' },
    { name: 'studioAppTemplateStore', file: './stores/studioAppTemplateStore' },
];

module.exports = { stores };
