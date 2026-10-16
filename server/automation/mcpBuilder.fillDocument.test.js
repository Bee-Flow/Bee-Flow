/**
 * The MCP call sequence for a fill_document step, at the tool layer:
 * builder_read_document, then builder_add_fill_document in a LATER call.
 * Every MCP call builds a fresh draft wrap, so the read has to survive on its
 * own, scoped to the caller and the automation.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const mcpBuilder = require('./mcpBuilder');
const mcpDocumentReads = require('./mcpDocumentReads');
const automationStore = require('../stores/automationStore');
const documentStore = require('../stores/documentStore');
const catalogModule = require('./builderDocumentCatalog');
const builderCatalog = require('./builderCatalog');
const datatableCatalog = require('./builderDatatableCatalog');

const DOC = {
    id: 'doc_1', name: 'Invoice', kind: 'document', docType: 'invoice', versionId: 'v1',
    bodyHtml: '<p>{{customer.name}}</p>', settings: {},
};

function stubAll() {
    const saved = [];
    const orig = {
        getAutomation: automationStore.getAutomation,
        getDocument: documentStore.getDocument,
        build: catalogModule.buildDocumentCatalogForUser,
        cat: builderCatalog.buildCatalogForUser,
        tables: datatableCatalog.buildDatatableCatalogForUser,
        update: automationStore.updateAutomation,
    };
    automationStore.getAutomation = async (id) => (['auto_1', 'auto_2'].includes(id)
        ? { id, userId: 'u1', organizationId: null, title: 'T', description: '', definition: saved.at(-1)?.def || { schemaVersion: 1, trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} }, steps: [], edges: [] } }
        : null);
    automationStore.updateAutomation = async (id, updates) => { saved.push({ def: structuredClone(updates.definition) }); return { id, userId: 'u1', title: 'T' }; };
    documentStore.getDocument = async (id, userId) => (id === 'doc_1' && userId === 'u1' ? DOC : null);
    catalogModule.buildDocumentCatalogForUser = async () => [{ id: 'doc_1', name: 'Invoice', docType: 'invoice', versionId: 'v1', placeholders: [] }];
    builderCatalog.buildCatalogForUser = async () => ({ apps: [], toolNames: null });
    datatableCatalog.buildDatatableCatalogForUser = async () => null;
    return { saved, restore() {
        automationStore.getAutomation = orig.getAutomation;
        documentStore.getDocument = orig.getDocument;
        catalogModule.buildDocumentCatalogForUser = orig.build;
        builderCatalog.buildCatalogForUser = orig.cat;
        datatableCatalog.buildDatatableCatalogForUser = orig.tables;
        automationStore.updateAutomation = orig.update;
    } };
}

const call = (name, args, userId = 'u1') => mcpBuilder.callTool(name, args, { userId }).then(r => r.result);

test('a document read in one MCP call lets the next call add the fill_document step', async () => {
    mcpDocumentReads.clear();
    const env = stubAll();
    try {
        const before = await call('builder_add_fill_document', { automationId: 'auto_1', documentId: 'doc_1', values: { 'customer.name': 'x' } });
        assert.match(before.error, /Read builder_read_document/);
        const read = await call('builder_read_document', { automationId: 'auto_1', documentId: 'doc_1' });
        assert.ok(!read.error, read.error);
        const added = await call('builder_add_fill_document', { automationId: 'auto_1', documentId: 'doc_1', values: { 'customer.name': 'x' } });
        assert.ok(!added.error, added.error);
    } finally { env.restore(); }
});

test('the read is scoped to the automation and the caller', async () => {
    mcpDocumentReads.clear();
    const env = stubAll();
    try {
        await call('builder_read_document', { automationId: 'auto_1', documentId: 'doc_1' });
        const other = await call('builder_add_fill_document', { automationId: 'auto_2', documentId: 'doc_1', values: { 'customer.name': 'x' } });
        assert.match(other.error, /Read builder_read_document/, 'another automation did not read it');
        const stranger = await call('builder_add_fill_document', { automationId: 'auto_1', documentId: 'doc_1', values: {} }, 'u2');
        assert.ok(stranger.error, 'another user cannot use it');
    } finally { env.restore(); }
});

test('a read is dropped when the document has a newer version by the next call', async () => {
    mcpDocumentReads.clear();
    const env = stubAll();
    try {
        await call('builder_read_document', { automationId: 'auto_1', documentId: 'doc_1' });
        catalogModule.buildDocumentCatalogForUser = async () => [{ id: 'doc_1', name: 'Invoice', docType: 'invoice', versionId: 'v2', placeholders: [] }];
        const added = await call('builder_add_fill_document', { automationId: 'auto_1', documentId: 'doc_1', values: { 'customer.name': 'x' } });
        assert.match(added.error, /Read builder_read_document/);
    } finally { env.restore(); }
});

test('a read expires after the TTL', async () => {
    mcpDocumentReads.clear();
    const wrap = { userId: 'u1', automationId: 'auto_1', _documentContracts: { doc_1: { versionId: 'v1' } } };
    mcpDocumentReads.remember(wrap, 1000);
    const fresh = { userId: 'u1', automationId: 'auto_1', _documents: [{ id: 'doc_1', versionId: 'v1' }] };
    mcpDocumentReads.restore(fresh, 1000 + mcpDocumentReads.TTL_MS + 1);
    assert.equal(fresh._documentContracts, undefined);
    mcpDocumentReads.restore(fresh, 1000 + 5);
    assert.deepEqual(fresh._documentContracts, { doc_1: { versionId: 'v1' } });
});
