// @typecheck
/**
 * Test data of Automations: test cases (with the run inputs they were captured
 * from), golden runs and form scenarios.
 *
 *   automation_test_fixtures / automation_test_cases   stores/lib/automationTestingCases.js
 *   automation_golden_runs                             stores/lib/automationTestingGoldens.js
 *   automation_form_scenarios                          stores/lib/automationTestingScenarios.js
 *
 * Everything cascades from `automations` and `automation_runs`: deleting an
 * automation, or the retention reaper deleting a run, removes the test data
 * captured from it. Test data is never part of a definition, an export or a
 * release (core/automationModel/testDataKeys.js).
 *
 * Built by a factory over a `{ query }` handle so the pg test runs the store's
 * own SQL against PGlite without module mocking; the default instance wraps the
 * pool. Its init awaits automationStore's, which owns the tables it references.
 */

'use strict';

const { pool, exec } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const log = require('../telemetry/log');
const { DDL } = require('./lib/automationTestingSchema');
const { makeTestCases } = require('./lib/automationTestingCases');
const { makeGoldens } = require('./lib/automationTestingGoldens');
const { makeScenarios } = require('./lib/automationTestingScenarios');

/**
 * @param {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number|null }> }} db
 * @param {{ ready?: () => Promise<void> }} [opts]
 */
function makeAutomationTestingStore(db, { ready = async () => {} } = {}) {
    return {
        ...makeTestCases(db, ready),
        ...makeGoldens(db, ready),
        ...makeScenarios(db, ready),
    };
}

const initDB = makeStoreInit('AutomationTestingStore', _initDB);

async function _initDB() {
    // Boot starts every store's init at once; the FK targets are created first
    // rather than assumed.
    await require('./automationStore').initDB();
    await exec(DDL);
    log.info('[AutomationTestingStore] PostgreSQL initialized');
}

const defaultStore = makeAutomationTestingStore({
    query: (sql, params) => pool.query(sql, params),
}, { ready: initDB });

module.exports = { initDB, DDL, makeAutomationTestingStore, ...defaultStore };
