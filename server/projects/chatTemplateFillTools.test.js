'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeProjectTemplateFillTools } = require('./chatTemplateFillTools.mts');
const { makeTemplateFillHandlers } = require('../integrations/templateFillTools.mts');

const CONTRACT = { parameters: [{ key: 'client', type: 'text', label: 'Client', required: true }, { key: 'amount', type: 'number', label: 'Amount', required: true }] };
const PROJECT = { id: 'p1', kind: null };
const ROLES = { ann: 'owner', bob: 'editor', vic: 'viewer' };

function fakeStore() {
    const docs = new Map([['tpl', { id: 'tpl', userId: 'ann', name: 'Offer', kind: 'template', docType: 'quote', bodyHtml: '<p>{{client}} {{amount}}</p>', css: '', versionId: 'v1', settings: { contract: CONTRACT } }]]);
    let n = 0;
    return {
        docs,
        async getDocument(id, userId) {
            const d = docs.get(id);
            if (!d) return null;
            return d.userId === userId || (d.projectId === 'p1' && ROLES[userId]) ? d : null;
        },
        async listDocuments() { return [...docs.values()].filter((d) => d.kind === 'template'); },
        async listProjectDocuments(projectId) { return [...docs.values()].filter((d) => d.projectId === projectId); },
        async createDocument(input) { n += 1; const d = { ...input, id: `doc-${n}`, versionId: 'v1' }; docs.set(d.id, d); return d; },
        async updateDocument(id, _ctx, updates) { const d = { ...docs.get(id), ...updates, versionId: `${docs.get(id).versionId}+` }; docs.set(id, d); return d; },
    };
}

function kit(store = fakeStore()) {
    const tools = makeProjectTemplateFillTools({
        getProjectRole: async (userId) => ROLES[userId] || null,
        membership: () => ({ isAllowedIn: (kind, projectKind) => kind === 'document' && projectKind !== 'solution' }),
        projectOrg: () => ({ projectOrgOf: async () => 'org1', belongsToProjectOrg: async () => true }),
        handlers: () => makeTemplateFillHandlers({ store }),
    });
    return { tools, store };
}

test('a template filled in in a team chat is a project document, and a colleague goes on with the same one', async () => {
    const { tools, store } = kit();
    const ann = tools.forAnswer({ project: PROJECT, userId: 'ann', chatId: 'chat-1' });
    const started = JSON.parse(await ann.execute('template_fill_start', { templateId: 'tpl' }));
    assert.equal(started.documentId, 'doc-1');
    assert.equal(store.docs.get('doc-1').projectId, 'p1', 'filed in the project');
    assert.equal(started.url, '/app/projects/p1/documents/doc-1', 'linked where the members open it');
    assert.deepEqual(ann.touched, [{ kind: 'templateFill', id: 'doc-1', name: 'Offer' }]);

    const bob = tools.forAnswer({ project: PROJECT, userId: 'bob', chatId: 'chat-1' });
    const set = JSON.parse(await bob.execute('template_fill_set_values', { values: { client: 'Van Dijk' } }));
    assert.equal(set.documentId, 'doc-1', 'Bob\'s answer found the fill Ann started in this chat');
    const again = JSON.parse(await bob.execute('template_fill_start', { templateId: 'tpl' }));
    assert.equal(again.documentId, 'doc-1', 'no second copy');
    assert.equal(again.resumed, true);
});

test('a viewer, or a project without documents, gets nothing', async () => {
    const { tools } = kit();
    assert.deepEqual(await tools.offered(PROJECT, 'vic'), []);
    assert.deepEqual(await tools.offered({ ...PROJECT, kind: 'solution' }, 'ann'), []);
    assert.ok((await tools.offered(PROJECT, 'bob')).some((d) => d.function.name === 'template_fill_start'));
    const out = JSON.parse(await tools.forAnswer({ project: PROJECT, userId: 'vic', chatId: 'chat-1' }).execute('template_fill_start', { templateId: 'tpl' }));
    assert.equal(out.ok, false);
});
