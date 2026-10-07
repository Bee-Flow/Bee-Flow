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

const fx = { providers: [], scc: [] };
const restore = installResolveStub({
    '../../../db': { getAll: async () => [] },
    '../../../stores/configStore': { getConfig: async (key) => (key === 'ai' ? { providers: fx.providers } : null) },
    '../../../stores/complianceStore': { getSettings: async () => ({ scc_confirmed_operators: fx.scc }) },
});
const check = require('./art53-model-inventory');
test.after(restore);

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
