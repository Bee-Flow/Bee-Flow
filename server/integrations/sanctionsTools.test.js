// @typecheck
'use strict';
/**
 * The sanctions tools: the licence is checked on every call, the screening runs on stored rows,
 * the PEP check needs only a function, and the family counts as local (no egress).
 * Run: cd server && node --test integrations/sanctionsTools.test.js
 */

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { SANCTIONS_TOOLS, isSanctionsTool, executeSanctionsTool } = require('./sanctionsTools.mts');
const service = require('../core/sanctions/service.mts');
const { resolveIntegration } = require('../core/integrations/integrationToolMap');
const { classifyToolClass } = require('../core/privacy/orgShield');

const rows = [{
    listId: 'un_sc', entityId: '9001', kind: 'person', primaryName: 'ALDO EXAMPLO', name: 'ALDO EXAMPLO',
    birthDates: ['1968'], countries: ['NL'], programmes: ['TST'], reference: 'TSi.001', url: 'https://example.test/un',
}];

function stub({ licensed = true } = {}) {
    const asked = [];
    service._setServiceDeps({
        hasFeature: async (scope, feature) => { asked.push({ scope, feature }); return licensed; },
        store: () => ({
            candidates: async () => rows,
            listStatus: async () => [{ id: 'un_sc', label: 'UN', status: 'ok', entityCount: 1, nameCount: 1, lastAttemptAt: null, lastSuccessAt: '2026-01-01T00:00:00.000Z', replacedAt: null, lastError: null, etag: null, lastModified: null, contentHash: null }],
        }),
        log: { info: () => {} },
    });
    return asked;
}

afterEach(() => service._setServiceDeps(null));

test('two tools, both recognised', () => {
    assert.deepStrictEqual(SANCTIONS_TOOLS.map((t) => t.function.name), ['sanctions_screen', 'sanctions_pep_function_check']);
    assert.ok(isSanctionsTool('sanctions_screen'));
    assert.ok(!isSanctionsTool('maps_directions'));
});

test('sanctions_screen: licence asked for the caller\'s organisation, candidates and list status back', async () => {
    const asked = stub();
    const out = /** @type {any} */ (await executeSanctionsTool('sanctions_screen', { name: 'Aldo Examplo', birthDate: '1968', function: 'Minister' }, { userId: 'u1', orgId: 'o1' }));
    assert.deepStrictEqual(asked, [{ scope: { organizationId: 'o1', userId: 'u1' }, feature: 'sanctions_screening' }]);
    assert.strictEqual(out.candidateCount, 1);
    assert.strictEqual(out.candidates[0].reference, 'TSi.001');
    assert.strictEqual(out.pep.isPep, true);
    assert.deepStrictEqual(out.missingLists.sort(), ['eu_fsf', 'nl_terrorism', 'uk_fcdo', 'us_ofac_sdn']);
});

test('without the licence nothing is screened', async () => {
    stub({ licensed: false });
    assert.deepStrictEqual(await executeSanctionsTool('sanctions_screen', { name: 'Aldo Examplo' }, { userId: 'u1', orgId: 'o1' }),
        { error: 'Sanctions screening is not part of this licence.', code: 'feature_locked' });
});

test('arguments: a name for the screening, a function for the PEP check', async () => {
    stub();
    assert.match(String(/** @type {any} */ (await executeSanctionsTool('sanctions_screen', {}, { userId: 'u1' })).error), /name is required/);
    assert.match(String(/** @type {any} */ (await executeSanctionsTool('sanctions_pep_function_check', {}, { userId: 'u1' })).error), /function is required/);
    const pep = /** @type {any} */ (await executeSanctionsTool('sanctions_pep_function_check', { function: 'Ambassadeur' }, { userId: 'u1' }));
    assert.strictEqual(pep.isPep, true);
});

test('the family is local: no outbound server, internal for the outside-tools PII rules', () => {
    const meta = resolveIntegration('sanctions_screen', { name: 'x' });
    assert.strictEqual(meta?.isLocal, true);
    assert.strictEqual(meta?.server, null);
    assert.strictEqual(classifyToolClass('sanctions_screen', { name: 'x' }), 'internal');
    assert.strictEqual(classifyToolClass('sanctions_pep_function_check', {}), 'internal');
});
