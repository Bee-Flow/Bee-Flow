/**
 * The chat's template-fill tools (templateFillTools.mts), DB-free: the store is
 * a fake handed in through makeTemplateFillHandlers, the contract code is the
 * real one (pure), so typing and coercion are exactly what the documents use.
 */

const test = require('node:test');
const assert = require('node:assert');

const { makeTemplateFillHandlers, TEMPLATE_FILL_HANDLERS } = require('./templateFillTools.mts');
const { TEMPLATE_FILL_TOOLS } = require('./templateFillToolDefs.mts');
const { DOCUMENT_TOOL_NAMES } = require('./documentBuilderToolDefs');
const { NOT_SHARED } = require('../core/documents/aiDocumentScope');

const USERS = { alice: 'org-a', bob: 'org-a', eve: 'org-b' };
const BODY = '<h1>Offer</h1><p>{{client_name}}</p><p>{{amount}}</p><p>{{date}}</p><p>{{plan}}</p><p>{{notes}}</p>';
const CONTRACT = {
    parameters: [
        { key: 'client_name', type: 'text', label: 'Client name', required: true, instructions: 'The legal name' },
        { key: 'amount', type: 'number', label: 'Amount', required: true, example: 1250 },
        { key: 'date', type: 'date', label: 'Offer date', required: true },
        { key: 'plan', type: 'choice', label: 'Plan', options: ['Basic', 'Plus'] },
        { key: 'notes', type: 'text', label: 'Notes' },
    ],
};

function fakeStore() {
    const docs = new Map();
    const calls = [];
    let n = 0;
    const visible = (d, userId) => d.userId === userId
        || (d.visibility === 'team' && d.organizationId === USERS[userId] && d.kind !== 'document');
    const store = {
        docs, calls,
        add(doc) { docs.set(doc.id, { versionId: `v-${doc.id}`, css: '', description: '', categories: [], settings: {}, visibility: 'private', ...doc }); },
        async getDocument(id, userId) {
            const d = docs.get(id);
            return d && visible(d, userId) ? structuredClone(d) : null;
        },
        async listDocuments(userId, options) {
            calls.push({ op: 'list', userId, options });
            return [...docs.values()].filter((d) => visible(d, userId) && (!options.kind || d.kind === options.kind))
                .map((d) => ({ id: d.id, name: d.name, docType: d.docType, kind: d.kind, description: d.description }));
        },
        async createDocument(input) {
            calls.push({ op: 'create', input });
            n += 1;
            const doc = { ...structuredClone(input), id: `00000000-0000-4000-8000-00000000000${n}`, organizationId: USERS[input.userId], versionId: `nv-${n}` };
            docs.set(doc.id, doc);
            return structuredClone(doc);
        },
        async updateDocument(id, userId, updates) {
            calls.push({ op: 'update', id, userId, updates });
            const d = docs.get(id);
            if (!d || d.userId !== userId) return null;
            Object.assign(d, { settings: updates.settings, versionId: `${d.versionId}+` });
            return structuredClone(d);
        },
    };
    store.add({ id: 'tpl-own', userId: 'alice', organizationId: 'org-a', kind: 'template', name: 'Offer', docType: 'quote', bodyHtml: BODY, css: 'h1{color:red}', description: 'Our standard offer', settings: { contract: CONTRACT, sampleValues: { client_name: 'Sample BV' }, sectionOverrides: {} } });
    store.add({ id: 'tpl-team', userId: 'bob', organizationId: 'org-a', kind: 'template', visibility: 'team', name: 'Deck', docType: 'presentation', bodyHtml: '# {{title}}\n## Slide', settings: { contract: { parameters: [{ key: 'title', type: 'text', label: 'Title', required: true }] } } });
    store.add({ id: 'tpl-other-org', userId: 'eve', organizationId: 'org-b', kind: 'template', visibility: 'team', name: 'Their offer', docType: 'quote', bodyHtml: BODY, settings: { contract: CONTRACT } });
    store.add({ id: 'doc-plain', userId: 'alice', organizationId: 'org-a', kind: 'document', name: 'A letter', docType: 'letter', bodyHtml: '<p>hi</p>' });
    return store;
}

function scope() {
    const ids = new Set();
    return { ids, has: (id) => ids.has(id), add: (id) => ids.add(id), markCreated: (id) => ids.add(id) };
}

function setup() {
    const store = fakeStore();
    return { store, handlers: makeTemplateFillHandlers({ store }), ctx: { documentScope: scope() } };
}

test('the four tools are offered wherever the document tools are, with a handler each', () => {
    for (const t of TEMPLATE_FILL_TOOLS) {
        assert.ok(DOCUMENT_TOOL_NAMES.has(t.function.name), t.function.name);
        assert.equal(typeof TEMPLATE_FILL_HANDLERS[t.function.name], 'function');
    }
});

test('document_templates_list: own and team templates of the organisation, not another organisation\'s', async () => {
    const { handlers, ctx, store } = setup();
    const out = await handlers.document_templates_list({ query: 'offer' }, ctx, 'alice');
    assert.deepStrictEqual(out.templates.map((t) => t.templateId).sort(), ['tpl-own', 'tpl-team']);
    const own = out.templates.find((t) => t.templateId === 'tpl-own');
    assert.deepStrictEqual({ name: own.name, docType: own.docType, fieldCount: own.fieldCount, requiredCount: own.requiredCount, description: own.description },
        { name: 'Offer', docType: 'quote', fieldCount: 5, requiredCount: 3, description: 'Our standard offer' });
    assert.equal(store.calls[0].options.kind, 'template');
    assert.equal(store.calls[0].options.query, 'offer');
});

test('template_fill_start copies the template into a new private document, like the duplicate route', async () => {
    const { handlers, ctx, store } = setup();
    const out = await handlers.template_fill_start({ templateId: 'tpl-own', name: 'Offer Van Dijk' }, ctx, 'alice');
    assert.ifError(out.error);
    const create = store.calls.find((c) => c.op === 'create').input;
    assert.equal(create.userId, 'alice');
    assert.equal(create.kind, 'document');
    assert.equal(create.visibility, 'private');
    assert.equal(create.folderId, null);
    assert.equal(create.bodyHtml, BODY);
    assert.equal(create.css, 'h1{color:red}');
    assert.equal(create.docType, 'quote');
    assert.deepStrictEqual(create.settings.source, { documentId: 'tpl-own', versionId: 'v-tpl-own' });
    assert.equal(create.settings.sampleValues, undefined, 'the template\'s preview values are not carried over');
    assert.equal(out.name, 'Offer Van Dijk');
    assert.match(out.url, /\/app\/studio\/documents\//);
    assert.ok(ctx.documentScope.has(out.documentId), 'the new document is in this chat\'s scope');
    assert.equal(Object.keys(out)[0], 'documentId', 'first, so the scope finds it again in the stored preview');
    assert.deepStrictEqual(out.fields.map((f) => f.label), ['Client name', 'Amount', 'Offer date', 'Plan', 'Notes']);
    assert.deepStrictEqual(out.fields.find((f) => f.key === 'plan').options, ['Basic', 'Plus']);
    assert.equal(out.fields[0].help, 'The legal name');
    assert.deepStrictEqual(out.missingRequired.map((m) => m.key), ['client_name', 'amount', 'date']);
    assert.deepStrictEqual(out.values, {});
    assert.deepStrictEqual([out.filled, out.total, out.complete], [0, 5, false]);
});

test('template_fill_start refuses another organisation\'s template and a plain document, with the same answer', async () => {
    const { handlers, ctx, store } = setup();
    const other = await handlers.template_fill_start({ templateId: 'tpl-other-org' }, ctx, 'alice');
    const plain = await handlers.template_fill_start({ templateId: 'doc-plain' }, ctx, 'alice');
    assert.match(other.error, /Template not found/);
    assert.equal(plain.error, other.error);
    assert.equal(store.calls.filter((c) => c.op === 'create').length, 0);
});

test('template_fill_set_values merges, coerces numbers and rejects wrong types and unknown keys', async () => {
    const { handlers, ctx, store } = setup();
    const { documentId } = await handlers.template_fill_start({ templateId: 'tpl-own' }, ctx, 'alice');
    const out = await handlers.template_fill_set_values({ documentId, values: {
        client_name: 'Van Dijk Groep', amount: '12,5', date: '2026-02-30', plan: 'Gold', colour: 'red',
    } }, ctx, 'alice');
    assert.ifError(out.error);
    assert.deepStrictEqual(out.values, { client_name: 'Van Dijk Groep', amount: 12.5 });
    assert.deepStrictEqual(out.rejected.map((r) => r.key).sort(), ['colour', 'date', 'plan']);
    assert.match(out.rejected.find((r) => r.key === 'plan').message, /Basic, Plus/);
    assert.match(out.rejected.find((r) => r.key === 'colour').message, /Unknown field/);
    assert.deepStrictEqual(out.missingRequired.map((m) => m.key), ['date']);
    assert.equal(out.complete, false);
    const update = store.calls.find((c) => c.op === 'update');
    assert.equal(update.updates.source, 'ai');
    assert.equal(update.updates.expectedVersionId, 'nv-1');
    assert.deepStrictEqual(update.updates.settings.sampleValues, { client_name: 'Van Dijk Groep', amount: 12.5 });
    assert.deepStrictEqual(update.updates.settings.source, { documentId: 'tpl-own', versionId: 'v-tpl-own' }, 'other settings are kept');

    const again = await handlers.template_fill_set_values({ documentId, values: { amount: '1.250', date: '2026-03-01', client_name: null } }, ctx, 'alice');
    assert.deepStrictEqual(again.values, { amount: 12.5, date: '2026-03-01' }, 'null clears; "1.250" is ambiguous and refused');
    assert.match(again.rejected[0].message, /thousands separator/);
});

test('template_fill_set_values and finish only reach a document in this chat\'s scope, and only a filled-in document', async () => {
    const { handlers, store } = setup();
    const out = await handlers.template_fill_set_values({ documentId: 'doc-plain', values: { a: 1 } }, { documentScope: scope() }, 'alice');
    assert.equal(out.error, NOT_SHARED);
    const fin = await handlers.template_fill_finish({ documentId: 'doc-plain' }, { documentScope: scope() }, 'alice');
    assert.equal(fin.error, NOT_SHARED);
    const s = scope(); s.add('tpl-own');
    const tpl = await handlers.template_fill_set_values({ documentId: 'tpl-own', values: { notes: 'x' } }, { documentScope: s }, 'alice');
    assert.match(tpl.error, /template_fill_start/);
    assert.equal(store.calls.filter((c) => c.op === 'update').length, 0);
});

test('template_fill_finish refuses while a required field is missing, then hands over the download', async () => {
    const { handlers, ctx } = setup();
    const { documentId } = await handlers.template_fill_start({ templateId: 'tpl-own' }, ctx, 'alice');
    await handlers.template_fill_set_values({ documentId, values: { client_name: 'Van Dijk', amount: 10 } }, ctx, 'alice');
    const early = await handlers.template_fill_finish({ documentId }, ctx, 'alice');
    assert.equal(early.complete, false);
    assert.deepStrictEqual(early.missingRequired, [{ key: 'date', label: 'Offer date' }]);
    assert.equal(early.downloadUrl, undefined);

    await handlers.template_fill_set_values({ documentId, values: { date: '2026-03-01' } }, ctx, 'alice');
    const done = await handlers.template_fill_finish({ documentId }, ctx, 'alice');
    assert.equal(done.complete, true);
    assert.equal(done.finished, true);
    assert.equal(done.format, 'pdf');
    assert.equal(done.downloadUrl, `/api/studio-documents/${documentId}/pdf`);
    assert.match(done.message, /\[Offer\]\(\/app\/studio\/documents\//);
});

test('a presentation from a team template downloads as PowerPoint', async () => {
    const { handlers, ctx } = setup();
    const { documentId, error } = await handlers.template_fill_start({ templateId: 'tpl-team' }, ctx, 'alice');
    assert.ifError(error);
    await handlers.template_fill_set_values({ documentId, values: { title: 'Kick-off' } }, ctx, 'alice');
    const done = await handlers.template_fill_finish({ documentId }, ctx, 'alice');
    assert.equal(done.format, 'pptx');
    assert.equal(done.downloadUrl, `/api/studio-documents/${documentId}/pptx`);
});
