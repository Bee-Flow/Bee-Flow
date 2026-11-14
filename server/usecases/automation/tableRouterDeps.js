// @typecheck strict
/**
 * What the two routers that read a run's tables (runTables.js, tablePreview.js)
 * set up the same way: lazily required store and table store, the table limits,
 * the automation access and the journey reader. A test hands in its own through
 * `overrides`.
 */

'use strict';

const { makeAutomationAccess } = require('../../automation/access');
const { tableLimits } = require('../../core/automationRunner/tables/limits');
const { makeJourneyReader } = require('./runJourney');

/**
 * @param {any} [overrides]
 */
function tableRouterDeps(overrides = {}) {
    const store = () => overrides.store || require('../../stores/automationStore');
    const tables = () => overrides.tableStore || require('../../core/automationRunner/tables/tableStore');
    const limitsNow = () => (overrides.limits ? overrides.limits() : tableLimits());
    const access = makeAutomationAccess({
        store: overrides.store,
        ...(overrides.getUser ? { getUser: overrides.getUser } : {}),
        ...(overrides.hasPermission ? { hasPermission: overrides.hasPermission } : {}),
    });
    const journey = makeJourneyReader({ store, access, what: 'see its tables' });
    return { store, tables, limitsNow, access, journey };
}

module.exports = { tableRouterDeps };
