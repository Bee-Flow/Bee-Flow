'use strict';
/**
 * The automation module's door of callSites.test.js: the org's own data types come out as the
 * admin's placeholders in an automation step's input too (automationRunner/safety and its
 * token vault).
 *
 * Run: cd server && node --test core/privacy/customTypes/callSites.automation.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { TEXT, SHIELD } = require('./callSites.testkit').useCustomTypesFixture(test);

test('automations: the same placeholders in a step\'s input', async () => {
    const safety = require('../../automationRunner/safety');
    const { createTokenVault } = require('../../automationRunner/tokenVault');
    const ctx = { tokenVault: createTokenVault({}) };
    const policy = {
        shield: SHIELD, orgId: 'org1', piiEnabled: true, action: 'tokenize', regexRules: [], monitorIntegrations: true,
        scope: { toolInput: true }, privacyScope: 'external', confidence: 0.7, categories: SHIELD.piiDetectionCategories,
        failureMode: 'fail_open', largeInputPolicy: 'fail_open',
    };
    const r = await safety.guardToolInput({ body: TEXT }, policy, { organization_id: 'org1', step_id: 's1' }, 'live', ctx);
    assert.equal(r.value.body, 'Status of [project_code_1] for customer [customer_number_1], please');
    assert.equal(ctx.tokenVault.all()['[customer_number_1]'], 'KL-12345');
});
