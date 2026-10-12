'use strict';

/**
 * A draft that still points at a table that was only PROPOSED ("pending:<n>")
 * must never be saved: persistDraft throws and writes nothing.
 */
const test = require('node:test');
const assert = require('node:assert');
const automationStore = require('../../stores/automationStore');
const { persistDraft } = require('./persistence');
const { emptyDefinition } = require('./draftGraph');

test('persistDraft throws datatable_pending and writes nothing', async () => {
    const calls = [];
    const orig = { create: automationStore.createAutomation, update: automationStore.updateAutomation };
    automationStore.createAutomation = async (...a) => { calls.push(['create', a]); return {}; };
    automationStore.updateAutomation = async (...a) => { calls.push(['update', a]); return {}; };
    try {
        const def = emptyDefinition();
        def.steps = [{ id: 's1', type: 'datatable', op: 'add_row', datatableId: 'pending:1', datatableKey: 'facturen', values: {} }];
        def.edges = [{ from: 'trg', to: 's1' }];
        await assert.rejects(
            () => persistDraft({ userId: 'u1', def, automationId: null }),
            (e) => e.code === 'datatable_pending' && /proposed but never created/.test(e.message),
        );
        assert.deepStrictEqual(calls, []);
    } finally {
        automationStore.createAutomation = orig.create;
        automationStore.updateAutomation = orig.update;
    }
});

test('a pending ref anywhere counts: a loop body and a layer', async () => {
    const def = emptyDefinition();
    def.steps = [{ id: 'l', type: 'loop', body: [{ id: 'b', type: 'datatable', datatableId: 'pending:2' }] }];
    await assert.rejects(() => persistDraft({ userId: 'u1', def }), (e) => e.code === 'datatable_pending');
    const def2 = emptyDefinition();
    def2.layers = { sub: { steps: [{ id: 'd', type: 'datatable', datatableId: 'pending:3' }], edges: [] } };
    await assert.rejects(() => persistDraft({ userId: 'u1', def: def2 }), (e) => e.code === 'datatable_pending');
});
