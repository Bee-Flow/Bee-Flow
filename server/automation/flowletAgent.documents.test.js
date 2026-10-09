'use strict';

/**
 * The flowlet sub-agent and the document-discovery gate.
 *
 * documentDiscovery.inspectBindings refuses a fill_document step until
 * builder_read_document ran for its document ("Read builder_read_document(...)
 * before configuring this document"). The sub-agent's tool set had a step
 * builder but not the reader, so a flowlet could never build that step: the
 * refusal named a tool it did not have. Both ways in are covered: the main
 * builder's delegation (draft flag) and a parallel agent's isolated draft
 * (carried document list).
 *
 * Also pinned here: the agents and knowledge-base blocks reach the sub-agent's
 * prompt, with "could not read" kept apart from "none".
 *
 * Run: cd server && node --test automation/flowletAgent.documents.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

// A designed document with one placeholder; the store answers for any user.
// The store's own functions are replaced for the duration of this file (and put
// back after): no module-cache surgery.
const DOC = { id: 'doc1', kind: 'document', name: 'Invoice', versionId: 'v1', bodyHtml: '<p>{{customer.name}}</p>', settings: {} };
const documentStore = require('../stores/documentStore');
const realStore = { getDocument: documentStore.getDocument, getDocumentVersion: documentStore.getDocumentVersion, listTemplates: documentStore.listTemplates };
documentStore.getDocument = async () => DOC;
documentStore.getDocumentVersion = async () => DOC;
documentStore.listTemplates = async () => [{ ...DOC, docType: 'invoice', parameters: [], sections: [] }];

const llmClient = require('../core/llm/llmClient');
const origChat = llmClient.chat;
const { runLayerAgent, runLayersInParallel } = require('./flowletAgent');
const { makeLayerSkeleton } = require('./builderTools');

after(() => {
    llmClient.chat = origChat;
    Object.assign(documentStore, realStore);
});

const tc = (name, args) => ({ id: `tc_${name}`, function: { name, arguments: JSON.stringify(args || {}) } });
const rootDef = (layers) => ({ schemaVersion: 2, trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} }, steps: [], edges: [], layers });

test('the sub-agent is offered the two document tools, and no write tool beyond the step builders', async () => {
    let offered = null;
    llmClient.chat = async (_model, _messages, options) => { offered = options.tools.map(t => t.function.name); return { content: 'done', toolCalls: [] }; };
    const def = rootDef({ inv: makeLayerSkeleton('Invoice', []) });
    await runLayerAgent({ draftWrap: { userId: 'u1', def, automationId: null }, layerKey: 'inv', instruction: 'x', modelId: 'stub', userId: 'u1', catalog: { apps: [] }, send: () => {} });
    assert.ok(offered.includes('builder_search_documents'));
    assert.ok(offered.includes('builder_read_document'));
    for (const withheld of ['builder_finalize', 'builder_request_dry_run', 'builder_create_datatable', 'builder_propose_trigger', 'builder_generate_layer']) {
        assert.ok(!offered.includes(withheld), `${withheld} stays withheld`);
    }
});

test('a flowlet builds a fill_document step: read the document first, then add it', async () => {
    const queue = [
        { content: null, toolCalls: [tc('builder_add_fill_document', { documentId: 'doc1' })] },
        { content: null, toolCalls: [tc('builder_read_document', { documentId: 'doc1' })] },
        { content: null, toolCalls: [tc('builder_add_fill_document', { documentId: 'doc1', values: { 'customer.name': 'Acme' } })] },
        { content: 'Fills the invoice.', toolCalls: [] },
    ];
    llmClient.chat = async () => queue.shift() || { content: 'done', toolCalls: [] };
    const def = rootDef({ inv: makeLayerSkeleton('Invoice', []) });
    const events = [];
    // The main builder's flag, as layerAgent.js sets it on the draft.
    const draftWrap = { userId: 'u1', def, automationId: null, _documentDiscoveryRequired: true, _documents: [{ id: 'doc1', versionId: 'v1' }] };
    await runLayerAgent({ draftWrap, layerKey: 'inv', instruction: 'x', modelId: 'stub', userId: 'u1', catalog: { apps: [] }, send: (e, d) => events.push([e, d]) });
    const results = events.filter(e => e[0] === 'tool_call').map(e => [e[1].name, e[1].result]);
    assert.match(results[0][1].error, /builder_read_document/, 'the gate refuses until the document was read');
    assert.equal(results[1][0], 'builder_read_document');
    assert.ok(!results[1][1].error, JSON.stringify(results[1][1]));
    assert.ok(!results[2][1].error, JSON.stringify(results[2][1]));
    assert.ok(def.layers.inv.steps.some(s => s.type === 'fill_document' && s.documentId === 'doc1'), 'the step is in the flowlet');
    assert.equal(def.steps.length, 0, 'and the main flow is untouched');
});

test('a parallel agent\'s isolated draft carries the gate too, and can pass it', async () => {
    const queue = [
        { content: null, toolCalls: [tc('builder_read_document', { documentId: 'doc1' })] },
        { content: null, toolCalls: [tc('builder_add_fill_document', { documentId: 'doc1', values: { 'customer.name': 'Acme' } })] },
        { content: 'Done.', toolCalls: [] },
    ];
    llmClient.chat = async () => queue.shift() || { content: 'done', toolCalls: [] };
    const root = rootDef({});
    const results = await runLayersInParallel({
        rootDef: root, specs: [{ title: 'Invoice', instruction: 'x' }], modelId: 'stub', userId: 'u1', catalog: { apps: [] }, send: () => {},
        documents: [{ id: 'doc1', versionId: 'v1' }],
    });
    assert.ok(results[0].ok, JSON.stringify(results));
    const layer = Object.values(root.layers)[0];
    assert.ok(layer.steps.some(s => s.type === 'fill_document'), 'the isolated flowlet built the step');
});

test('the sub-agent prompt carries the agents and knowledge-base blocks, "could not read" apart from "none"', async () => {
    let system = '';
    llmClient.chat = async (_m, messages) => { system = messages[0].content; return { content: 'done', toolCalls: [] }; };
    const run = async (catalog) => {
        const def = rootDef({ inv: makeLayerSkeleton('Invoice', []) });
        await runLayerAgent({ draftWrap: { userId: 'u1', def, automationId: null }, layerKey: 'inv', instruction: 'x', modelId: 'stub', userId: 'u1', catalog, send: () => {} });
        return system;
    };
    const listed = await run({ apps: [], agents: [{ id: 'agt_1', name: 'Sales helper', canUse: true, scope: 'personal' }], agentsError: null, knowledgeBases: [{ id: 'kb_1', name: 'Handbook', canWrite: false, scope: 'org' }], knowledgeBasesError: null });
    assert.match(listed, /Agents you may use/);
    assert.match(listed, /agt_1/);
    assert.match(listed, /kb_1 · "Handbook" · read-only/);
    const failed = await run({ apps: [], agents: [], agentsError: 'identity unavailable', knowledgeBases: [], knowledgeBasesError: 'db down' });
    assert.match(failed, /could not be read just now/);
    assert.doesNotMatch(failed, /none —/, 'a failed read is never rendered as "none"');
    const none = await run({ apps: [], agents: [], agentsError: null, knowledgeBases: [], knowledgeBasesError: null });
    assert.match(none, /none — this user has no agent/);
    const silent = await run({ apps: [] });
    assert.doesNotMatch(silent, /Agents you may use|Knowledge bases you may use/, 'a caller that never asked gets no block');
});

test('a parallel agent\'s isolated draft carries the datatable consent gate: an unchosen table is refused to it, a chosen one passes', async () => {
    const tables = [
        { id: 'tbl_ok', key: 'facturen', name: 'Facturen', canWrite: true, columns: [{ key: 'datum', name: 'Datum', type: 'date' }] },
        { id: 'tbl_no', key: 'klanten', name: 'Klanten', canWrite: true, columns: [{ key: 'naam', name: 'Naam', type: 'text' }] },
    ];
    const queue = [
        { content: null, toolCalls: [tc('builder_add_datatable', { op: 'find_rows', datatableId: 'tbl_no' })] },
        { content: null, toolCalls: [tc('builder_add_datatable', { op: 'find_rows', datatableId: 'tbl_ok' })] },
        { content: 'Done.', toolCalls: [] },
    ];
    llmClient.chat = async () => queue.shift() || { content: 'done', toolCalls: [] };
    const root = rootDef({});
    const approved = new Set(['tbl_ok']);
    const events = [];
    await runLayersInParallel({
        rootDef: root, specs: [{ title: 'Lookup', instruction: 'x' }], modelId: 'stub', userId: 'u1', catalog: { apps: [] }, send: (e, d) => events.push([e, d]),
        datatables: tables, approvedDatatableIds: approved,
    });
    const results = events.filter(e => e[0] === 'tool_call').map(e => e[1].result);
    assert.equal(results[0].code, 'datatable_choice_required', 'a sub-agent cannot ask, so the refusal reaches the main agent');
    assert.ok(!results[1].error, JSON.stringify(results[1]));
    const layer = Object.values(root.layers)[0];
    assert.deepEqual(layer.steps.filter(s => s.type === 'datatable').map(s => s.datatableId), ['tbl_ok']);
    // Without a Set (MCP, or a turn outside a work mode) there is no gate.
    const open = rootDef({});
    queue.push({ content: null, toolCalls: [tc('builder_add_datatable', { op: 'find_rows', datatableId: 'tbl_no' })] }, { content: 'Done.', toolCalls: [] });
    const openEvents = [];
    await runLayersInParallel({ rootDef: open, specs: [{ title: 'Lookup', instruction: 'x' }], modelId: 'stub', userId: 'u1', catalog: { apps: [] }, send: (e, d) => openEvents.push([e, d]), datatables: tables });
    assert.ok(openEvents.filter(e => e[0] === 'tool_call').every(e => !e[1].result.error));
});
