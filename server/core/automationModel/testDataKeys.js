// @typecheck strict
/**
 * Test data never travels inside a definition.
 *
 * Test cases, captured fixtures, golden runs and form scenarios live in their
 * own tables (stores/automationTestingStore.js), tied to the automation and to
 * the runs they were captured from. They hold values from real runs, so a
 * definition, an export file, a release or a PRD stage must not carry them,
 * whatever a hand-edited file or a future writer puts there. This strip is the
 * defensive end of that rule: it removes the keys at the definition root, on
 * every layer and on every node.
 *
 * Lives in core/automationModel so the projects layer can use it without reaching into automation/. Called by portability.buildExport and sanitizeImport and by
 * projects/stages/stagePayload canonicalAutomation (through stripCapturedData).
 * Mutates the definition it is given (callers pass a copy) and returns it.
 */

'use strict';

const { walkAllSteps } = require('../packaging/walkers');

const TEST_DATA_KEYS = Object.freeze(['testCases', 'testFixtures', 'goldenRuns', 'formScenarios']);

const isObject = (/** @type {{ [x: string]: unknown; }} */ v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {{ [x: string]: unknown; }} node
 */
function stripFrom(node) {
    let removed = 0;
    if (!isObject(node)) return removed;
    for (const key of TEST_DATA_KEYS) {
        if (Object.prototype.hasOwnProperty.call(node, key)) {
            delete node[key];
            removed++;
        }
    }
    return removed;
}

/**
 * @param {any} def  an automation definition
 * @param {string[]} [warnings]  gets one line when something was removed
 * @returns {any} the same definition
 */
function stripTestData(def, warnings) {
    if (!isObject(def)) return def;
    let removed = stripFrom(def);
    if (isObject(def.layers)) {
        for (const layer of Object.values(def.layers)) removed += stripFrom(layer);
    }
    walkAllSteps(def, (/** @type {{ [x: string]: unknown; }} */ node) => { removed += stripFrom(node); });
    if (removed > 0 && Array.isArray(warnings)) {
        warnings.push('Removed test data from the definition — test cases and captured run data stay with the workspace they were made in and are not portable.');
    }
    return def;
}

/**
 * Everything a definition must not carry out of the workspace that captured it:
 * the sample payload saved for manual test runs (real subjects, senders, bodies)
 * and the test data above. Used by the export and by the stage payload.
 *
 * @param {any} def
 * @param {string[]} [warnings]
 */
function stripCapturedData(def, warnings) {
    if (isObject(def) && def.manualTriggerPayload !== undefined) {
        delete def.manualTriggerPayload;
        if (Array.isArray(warnings)) warnings.push('Removed the saved manual-trigger sample payload — it is captured from your data and is not portable.');
    }
    return stripTestData(def, warnings);
}

module.exports = { TEST_DATA_KEYS, stripTestData, stripCapturedData };
