'use strict';
/**
 * The fixture of callSites.test.js and its module halves (callSites.<module>.test.js): an org
 * with two of its own data types and NO guard installed. Requiring this kit sets the test
 * environment and an empty recorder for the database, as those files did at their top.
 *
 *   const { PROJ, CUST, TEXT, SHIELD } = require('./callSites.testkit').useCustomTypesFixture(test);
 */

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET ??= 'ci-session-secret-value-at-least-32-chars-long';
delete process.env.PII_SERVICE_URL;
require('../../../testUtils/routeHarness').recordDb();

const registry = require('./registry');
const { ALL_PII_CATEGORY_IDS } = require('../piiDetection/categories');
const { _resetLegacyRunner } = require('./legacyRunner');

const PROJ = 'cdt_00000000a1';
const CUST = 'cdt_00000000b2';
const TYPES = [
    { id: PROJ, name: 'Project code names', method: 'words', tokenKey: 'project_code', words: { values: ['Falcon'], caseSensitive: false, wholeWord: true } },
    { id: CUST, name: 'Customer numbers', method: 'pattern', tokenKey: 'customer_number', pattern: { source: 'KL-\\d{5}', caseSensitive: false, engine: 're2' } },
];
const TEXT = 'Status of Falcon for customer KL-12345, please';
const SHIELD = {
    enabled: true, privacyScanEnabled: true, dlpEnabled: true, dlpScope: 'all', dlpMode: 'auto_redact',
    piiDetectionAction: 'tokenize', privacyAction: 'redact', piiFailureMode: 'fail_open',
    piiDetectionCategories: [...ALL_PII_CATEGORY_IDS, PROJ, CUST],
    toolPiiPolicy: { external: { blockCategories: [CUST] }, internal: { blockCategories: [] } },
    customTypesDigest: 'digest-1',
};

/**
 * Registers the org's types before the file's tests and resets the legacy runner after them.
 * @param {typeof import('node:test')} test
 */
function useCustomTypesFixture(test) {
    test.before(() => { registry._resetRegistry(); registry.syncOrg('org1', TYPES); });
    test.after(() => _resetLegacyRunner());
    return { PROJ, CUST, TYPES, TEXT, SHIELD };
}

module.exports = { useCustomTypesFixture };
