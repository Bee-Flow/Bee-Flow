'use strict';

/**
 * Flowlet delegation hands the sub-agents the gates the main draft carries:
 * the datatable list, and the consent Set (a sub-agent cannot ask the user, so
 * a table that was not chosen is refused to it and the main agent asks).
 */
const test = require('node:test');
const assert = require('node:assert');

// Patched before layerDelegation destructures it.
const flowletAgent = require('../../../automation/flowletAgent');
let captured = null;
const original = flowletAgent.runLayersInParallel;
flowletAgent.runLayersInParallel = async (opts) => { captured = opts; return []; };
const { runDelegationTool } = require('./layerDelegation');
test.after(() => { flowletAgent.runLayersInParallel = original; });

const ctx = (draftWrap) => ({ draftWrap, thinkingModelId: 'm', userId: 'u1', userOrgId: 'o1', session: {}, catalog: {}, send: () => {} });

test('builder_generate_layers passes a COPY of the approved set, so a sub-agent never widens the main draft\'s', async () => {
    const approved = new Set(['tbl_1']);
    const draftWrap = { def: { layers: {} }, _datatables: [{ id: 'tbl_1' }], _approvedDatatableIds: approved };
    await runDelegationTool('builder_generate_layers', { layers: [{ title: 'A', instruction: 'x' }] }, ctx(draftWrap));
    assert.ok(captured.approvedDatatableIds instanceof Set);
    assert.deepStrictEqual([...captured.approvedDatatableIds], ['tbl_1']);
    assert.notStrictEqual(captured.approvedDatatableIds, approved);
    assert.deepStrictEqual(captured.datatables, [{ id: 'tbl_1' }]);
});

test('with no consent gate on the main draft (MCP, a turn outside a work mode) the sub-agents get none either', async () => {
    await runDelegationTool('builder_generate_layers', { layers: [{ title: 'A', instruction: 'x' }] }, ctx({ def: { layers: {} }, _datatables: null }));
    assert.strictEqual(captured.approvedDatatableIds, null);
});
