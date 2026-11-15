// @typecheck strict
/**
 * imports.js: the import report of an automation imported from another
 * workflow tool, as the automationStore facade exposes it. The SQL lives in
 * stores/automationImportStore.mts; this file only gives it the pool.
 *
 * The activation gate (automation/importGate.mts) reads it through the facade,
 * so a store double without these functions (a handler test) has no imports.
 */

const { initDB, pool } = require('./core');
// Node strips the types of a .mts file on load, and require() takes an ES module.
const { makeAutomationImportStore } = require('../automationImportStore.mts');

const store = makeAutomationImportStore({
    query: (sql, params) => pool.query(sql, params),
    ready: initDB,
});

module.exports = {
    insertImportReport: store.insertReport,
    getImportForAutomation: store.getForAutomation,
    acknowledgeImportItems: store.acknowledge,
    markImportDryRunOk: store.markDryRunOk,
    markImportCleared: store.markCleared,
    setImportComparison: store.setComparison,
};
