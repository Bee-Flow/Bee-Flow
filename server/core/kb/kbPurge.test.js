'use strict';
/**
 * purgeKbChunks: every chunk of a base goes, in the search service (per
 * document, the only removal it has) and in the local table; strict mode
 * throws so an erasure can be retried. Run: node --test core/kb/kbPurge.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { purgeKbChunks } = require('./kbPurge.mts');

function fakes({ provider = 'remote', docs = [{ id: 'd1' }, { id: 'd2' }], remoteFails = false } = {}) {
    const calls = { remote: [], local: [], warn: [] };
    return {
        calls,
        deps: {
            resolveKbProvider: async () => provider,
            listDocuments: async (_kb, { offset }) => (offset === 0 ? docs : []),
            purgeDocumentChunks: async (kbId, docId, tenantId) => {
                if (remoteFails) throw new Error('search-service returned 503');
                calls.remote.push([kbId, docId, tenantId]);
            },
            deleteChunksLocally: async (tenantId, kbId) => { calls.local.push([tenantId, kbId]); },
            warn: (m) => calls.warn.push(m),
        },
    };
}

test('remote provider: every document is purged in the service, then the local chunks', async () => {
    const { calls, deps } = fakes();
    await purgeKbChunks({ id: 'kb1', tenant_id: 'u1' }, { deps });
    assert.deepEqual(calls.remote, [['kb1', 'd1', 'u1'], ['kb1', 'd2', 'u1']]);
    assert.deepEqual(calls.local, [['u1', 'kb1']]);
});

test('local provider: only the local table', async () => {
    const { calls, deps } = fakes({ provider: 'local' });
    await purgeKbChunks({ id: 'kb1', tenant_id: 'u1' }, { deps });
    assert.deepEqual(calls.remote, []);
    assert.deepEqual(calls.local, [['u1', 'kb1']]);
});

test('a failed service purge is logged by default and thrown in strict mode', async () => {
    const lenient = fakes({ remoteFails: true });
    await purgeKbChunks({ id: 'kb1', tenant_id: 'u1' }, { deps: lenient.deps });
    assert.equal(lenient.calls.warn.length, 1);
    assert.deepEqual(lenient.calls.local, [['u1', 'kb1']], 'the local chunks still go');

    const strict = fakes({ remoteFails: true });
    await assert.rejects(() => purgeKbChunks({ id: 'kb1', tenant_id: 'u1' }, { strict: true, deps: strict.deps }), /503/);
});
