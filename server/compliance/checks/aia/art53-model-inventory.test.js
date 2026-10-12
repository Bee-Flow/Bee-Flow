/**
 * AIA-Art53-model-inventory — which configured providers count as EXTERNAL.
 *
 * Self-hosted runtimes come from core/providers/localModels.js, the one list
 * the provider factory uses. A hand-kept copy here once missed llama.cpp,
 * SGLang, TGI, Jan, KoboldCpp and openai-compatible, and told admins those
 * on-premise servers lacked an SCC/DPA attestation.
 *
 * Run: cd server && node --test compliance/checks/aia/art53-model-inventory.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');
const { LOCAL_PROVIDER_TYPES } = require('../../../core/providers/localModels');

const fx = { providers: [], scc: [], agents: [], agentsError: null };
const restore = installResolveStub({
    // Ignores the parameters on purpose: the check's own filter must mirror
    // the SQL org predicate.
    '../../../db': { getAll: async () => { if (fx.agentsError) throw fx.agentsError; return fx.agents; } },
    '../../../stores/configStore': { getConfig: async (key) => (key === 'ai' ? { providers: fx.providers } : null) },
    '../../../stores/complianceStore': { getSettings: async () => ({ scc_confirmed_operators: fx.scc }) },
    // The real store opens a pool on first use.
    '../../../stores/aiActAssessmentStore': { stats: async () => ({ attested: 0, expired: 0 }), listForOrg: async () => [] },
});
const check = require('./art53-model-inventory');
test.after(restore);
test.beforeEach(() => { fx.providers = []; fx.scc = []; fx.agents = []; fx.agentsError = null; });

test('every self-hosted runtime type counts as internal', async () => {
    fx.providers = LOCAL_PROVIDER_TYPES.map((type, i) => ({ id: `p${i}`, type }));
    fx.scc = [];
    const r = await check.evaluate('org1');
    assert.deepEqual(r.evidence.external_uncovered, []);
    assert.ok(r.evidence.providers.every(p => p.external === false));
    assert.equal(r.status, 'pass');
});

test('a hosted provider without an attestation still warns', async () => {
    fx.providers = [{ id: 'gpu', type: 'llamacpp' }, { id: 'main', type: 'claude' }];
    fx.scc = [];
    const r = await check.evaluate('org1');
    assert.deepEqual(r.evidence.external_uncovered, ['claude']);
    assert.equal(r.status, 'warn');
});

test('an SCC attested under the operator name covers the provider type of the same company', async () => {
    // The ROPA toggle records 'Anthropic' / 'Microsoft'; the providers are
    // configured as 'claude' / 'azure'.
    fx.providers = [{ id: 'main', type: 'claude' }, { id: 'az', type: 'azure' }];
    fx.scc = [{ operator: 'Anthropic' }, { operator: 'Microsoft' }];
    const r = await check.evaluate('org1');
    assert.deepEqual(r.evidence.external_uncovered, []);
    assert.equal(r.status, 'pass');
});

test('a failed agent read warns instead of passing on the providers alone', async () => {
    fx.providers = [{ id: 'main', type: 'openai' }];
    fx.scc = [{ operator: 'openai' }];
    fx.agentsError = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.agents_readable, false);
    assert.equal(r.evidence.error_code, '57014');
    assert.deepEqual(r.evidence.providers.map(p => p.type), ['openai']);
    assert.doesNotMatch(JSON.stringify(r), /statement timeout/, 'never the driver message');

    // Not provisioned (fresh install) is an empty agent list, as before.
    fx.agentsError = Object.assign(new Error('relation "agents" does not exist'), { code: '42P01' });
    assert.equal((await check.evaluate('org1')).status, 'pass');
    fx.providers = [];
    assert.equal((await check.evaluate('org1')).status, 'not_applicable');
});

test('a platform agent (no organisation) is the default bucket\'s, never in a tenant\'s inventory', async () => {
    fx.agents = [
        { id: 'g', name: 'Platform', model: 'openai/gpt-4o', organization_id: null },
        { id: 'a', name: 'A', model: 'mistral/mistral-large', organization_id: 'org-a' },
    ];
    const r = await check.evaluate('org-a');
    assert.deepEqual(r.evidence.models.map(m => m.model), ['mistral/mistral-large']);
    assert.equal(JSON.stringify(r.evidence).includes('Platform'), false);
    const def = await check.evaluate('default');
    assert.deepEqual(def.evidence.models.map(m => m.agents), [['Platform']]);
});
