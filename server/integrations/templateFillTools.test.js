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
    return { has: (id) => ids.has(id), add: (id) => ids.add(id), markCreated: (id) => ids.add(id), ids: () => [...ids] };
}

function setup(conversationId = 'conv-1') {
    const store = fakeStore();
    return { store, handlers: makeTemplateFillHandlers({ store }), ctx: { documentScope: scope(), conversationId } };
}

/** A later turn of the same conversation: a new scope that knows nothing of earlier tool results. */
const laterTurn = (conversationId = 'conv-1') => ({ documentScope: scope(), conversationId });

test('the template tools are offered wherever the document tools are, with a handler each', () => {
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

    const last = await handlers.template_fill_set_values({ documentId, values: { date: '2026-03-01' } }, ctx, 'alice');
    assert.match(last.message, /template_fill_review/, 'complete: the final check is next');
    const unchecked = await handlers.template_fill_finish({ documentId }, ctx, 'alice');
    assert.equal(unchecked.finished, false);
    assert.equal(unchecked.needsCheck, true, 'never finished without the final check');
    await handlers.template_fill_review({ documentId, findings: [] }, ctx, 'alice');
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
    await handlers.template_fill_review({ documentId, findings: [] }, ctx, 'alice');
    const done = await handlers.template_fill_finish({ documentId }, ctx, 'alice');
    assert.equal(done.format, 'pptx');
    assert.equal(done.downloadUrl, `/api/studio-documents/${documentId}/pptx`);
});

// ── The fill keeps its document ─────────────────────────────────────

const keysOf = (list) => list.map((item) => item.key);

test('template_fill_start links the copy to this conversation, and continues it instead of making a second copy', async () => {
    const { handlers, ctx, store } = setup();
    const first = await handlers.template_fill_start({ templateId: 'tpl-own' }, ctx, 'alice');
    const link = store.docs.get(first.documentId).settings.templateFill;
    assert.equal(link.conversationId, 'conv-1');
    assert.equal(link.templateId, 'tpl-own');
    assert.ok(!Number.isNaN(Date.parse(link.startedAt)));
    await handlers.template_fill_set_values({ documentId: first.documentId, values: { client_name: 'Van Dijk' } }, ctx, 'alice');

    const again = await handlers.template_fill_start({ templateId: 'tpl-own' }, laterTurn(), 'alice');
    assert.equal(again.documentId, first.documentId, 'the same document, not a new copy');
    assert.equal(again.resumed, true);
    assert.deepStrictEqual(again.values, { client_name: 'Van Dijk' }, 'with what is already filled in');
    assert.equal(store.calls.filter((c) => c.op === 'create').length, 1);

    const fresh = await handlers.template_fill_start({ templateId: 'tpl-own', fresh: true }, laterTurn(), 'alice');
    assert.notEqual(fresh.documentId, first.documentId, 'fresh: true makes a second document');
    const other = await handlers.template_fill_start({ templateId: 'tpl-own' }, laterTurn('conv-2'), 'alice');
    assert.equal(other.resumed, undefined, 'another conversation never continues this one\'s fill');
});

test('set_values, status and finish without a documentId use this conversation\'s fill, in a later turn too', async () => {
    const { handlers, ctx } = setup();
    const { documentId } = await handlers.template_fill_start({ templateId: 'tpl-own' }, ctx, 'alice');
    const set = await handlers.template_fill_set_values({ values: { client_name: 'Van Dijk', amount: 10 } }, laterTurn(), 'alice');
    assert.ifError(set.error);
    assert.equal(set.documentId, documentId);
    const status = await handlers.template_fill_status({}, laterTurn(), 'alice');
    assert.equal(status.documentId, documentId);
    assert.deepStrictEqual(status.values, { client_name: 'Van Dijk', amount: 10 });
    assert.deepStrictEqual(keysOf(status.missingRequired), ['date']);
    assert.equal(status.fields.length, 5);

    const turn = laterTurn();
    await handlers.template_fill_set_values({ values: { date: '2026-03-01' } }, turn, 'alice');
    assert.ok(turn.documentScope.has(documentId), 'the found fill joins the turn\'s scope as the chat\'s own');
    assert.equal((await handlers.template_fill_review({ findings: [] }, laterTurn(), 'alice')).documentId, documentId);
    const done = await handlers.template_fill_finish({}, laterTurn(), 'alice');
    assert.equal(done.finished, true);
    assert.equal(done.documentId, documentId);
});

test('a finished fill is not continued, and without an active fill the tools say what to do', async () => {
    const { handlers, ctx, store } = setup();
    const { documentId } = await handlers.template_fill_start({ templateId: 'tpl-team' }, ctx, 'alice');
    await handlers.template_fill_set_values({ values: { title: 'Kick-off' } }, ctx, 'alice');
    await handlers.template_fill_review({ findings: [] }, ctx, 'alice');
    await handlers.template_fill_finish({}, ctx, 'alice');
    assert.ok(store.docs.get(documentId).settings.templateFill.finishedAt, 'finishing marks the link');
    const none = await handlers.template_fill_set_values({ values: { title: 'x' } }, laterTurn(), 'alice');
    assert.match(none.error, /No template is being filled in/);
    const next = await handlers.template_fill_start({ templateId: 'tpl-team' }, laterTurn(), 'alice');
    assert.notEqual(next.documentId, documentId);
    assert.equal((await handlers.template_fill_status({}, laterTurn('conv-9'), 'alice')).error, none.error);
});

test('a document id outside the scope: this conversation\'s own fill is reached, anyone else\'s is not', async () => {
    const { handlers, ctx, store } = setup();
    const { documentId } = await handlers.template_fill_start({ templateId: 'tpl-own' }, ctx, 'alice');
    const own = await handlers.template_fill_set_values({ documentId, values: { notes: 'ok' } }, laterTurn(), 'alice');
    assert.ifError(own.error);
    const otherConversation = await handlers.template_fill_set_values({ documentId, values: { notes: 'no' } }, laterTurn('conv-2'), 'alice');
    assert.equal(otherConversation.error, NOT_SHARED);
    const otherUser = await handlers.template_fill_status({ documentId }, laterTurn(), 'bob');
    assert.equal(otherUser.error, NOT_SHARED);
    assert.equal(store.docs.get(documentId).settings.sampleValues.notes, 'ok');
});

test('every answer about a document starts with its documentId, so a cut-off preview keeps it', async () => {
    const { handlers, ctx } = setup();
    const start = await handlers.template_fill_start({ templateId: 'tpl-own' }, ctx, 'alice');
    const answers = [
        start,
        await handlers.template_fill_start({ templateId: 'tpl-own' }, ctx, 'alice'),
        await handlers.template_fill_set_values({ values: { notes: 'x' } }, ctx, 'alice'),
        await handlers.template_fill_set_values({ values: 'nope' }, ctx, 'alice'),
        await handlers.template_fill_status({}, ctx, 'alice'),
        await handlers.template_fill_review({ findings: [{ key: 'notes', kind: 'doubt', reason: 'A single letter.' }] }, ctx, 'alice'),
        await handlers.template_fill_review({ findings: 'nope' }, ctx, 'alice'),
        await handlers.template_fill_finish({}, ctx, 'alice'),
    ];
    for (const a of answers) assert.ok(JSON.stringify(a).startsWith(`{"documentId":"${start.documentId}"`), JSON.stringify(a).slice(0, 60));
});

// ── Privacy Shield ──────────────────────────────────────────────────

test('a Privacy Shield placeholder the conversation could not restore is refused, never stored', async () => {
    const { handlers, ctx, store } = setup();
    await handlers.template_fill_start({ templateId: 'tpl-own' }, ctx, 'alice');
    const out = await handlers.template_fill_set_values({ values: { client_name: '[person_223]', notes: 'Contact: [organization_32] BV', amount: 5 } }, ctx, 'alice');
    assert.deepStrictEqual(out.values, { amount: 5 });
    assert.deepStrictEqual(keysOf(out.rejected).sort(), ['client_name', 'notes']);
    assert.match(out.rejected[0].message, /masked by the Privacy Shield \(\[person_223\]\).*Ask the user/);
    const saved = [...store.docs.values()].find((d) => d.kind === 'document' && d.settings.sampleValues);
    assert.ok(!JSON.stringify(saved.settings.sampleValues).includes('[person_'), 'no placeholder in the document');
    const plain = await handlers.template_fill_set_values({ values: { notes: 'Room [B12] on floor 3' } }, ctx, 'alice');
    assert.deepStrictEqual(plain.rejected, [], 'brackets that are no placeholder are ordinary text');
});

test('a copy of a filled-in document is no fill: the conversation link is not copied', () => {
    const { copySettings } = require('../core/documents/documentCopy.mts');
    const kept = copySettings({ id: 'd', kind: 'document', settings: { templateFill: { conversationId: 'c' }, sampleValues: { a: 1 }, contract: {} } }, 'document');
    assert.deepStrictEqual(kept, { contract: {} });
});

test('document_add_to_project lists the user\'s projects, then files this conversation\'s document into the chosen one', async () => {
    const store = fakeStore();
    const filed = [];
    const filing = {
        targets: async (userId) => (userId === 'alice' ? [{ id: 'p1', name: 'Van Dijk' }] : []),
        fileDocument: async (userId, documentId, projectId) => {
            filed.push({ userId, documentId, projectId });
            if (projectId === 'p1') store.docs.get(documentId).projectId = 'p1';
            return projectId === 'p1' ? { ok: true, project: { id: 'p1', name: 'Van Dijk' } } : { ok: false, error: 'Project not found.' };
        },
        folders: async () => [{ id: 'f1', name: 'Customers' }],
        placeInFolder: async (userId, projectId, documentId, folder) => {
            placed.push({ userId, projectId, documentId, folder });
            return folder === 'full' ? { ok: false, error: 'This project has as many folders as it may have.' } : { ok: true, folder: { id: 'f2', name: folder }, created: folder !== 'Customers' };
        },
    };
    const placed = [];
    const handlers = makeTemplateFillHandlers({ store, filing: () => filing });
    const ctx = { documentScope: scope(), conversationId: 'conv-1' };
    const { documentId } = await handlers.template_fill_start({ templateId: 'tpl-own' }, ctx, 'alice');

    const listed = await handlers.document_add_to_project({ documentId }, ctx, 'alice');
    assert.deepStrictEqual(listed.projects, [{ id: 'p1', name: 'Van Dijk' }]);
    assert.equal(filed.length, 0, 'listing files nothing');

    const out = await handlers.document_add_to_project({ documentId, projectId: 'p1' }, ctx, 'alice');
    assert.equal(out.added, true);
    assert.equal(out.url, `/app/projects/p1/documents/${documentId}`);
    assert.deepStrictEqual(out.project, { id: 'p1', name: 'Van Dijk' });
    assert.deepStrictEqual(out.folders, [{ id: 'f1', name: 'Customers' }], 'the folders it can go in next');
    assert.deepStrictEqual(filed, [{ userId: 'alice', documentId, projectId: 'p1' }]);
    assert.equal(placed.length, 0, 'no folder named: it stays at the top');

    // The customer's folder: the document is in the project already, so it is only put in the folder (made when new).
    const inFolder = await handlers.document_add_to_project({ documentId, projectId: 'p1', folder: 'Van Dijk BV' }, ctx, 'alice');
    assert.deepStrictEqual(inFolder.folder, { id: 'f2', name: 'Van Dijk BV' });
    assert.equal(inFolder.folderCreated, true);
    assert.equal(filed.length, 1, 'not filed a second time');
    assert.deepStrictEqual(placed, [{ userId: 'alice', projectId: 'p1', documentId, folder: 'Van Dijk BV' }]);
    assert.match(inFolder.message, /folder "Van Dijk BV"/);
    const noRoom = await handlers.document_add_to_project({ documentId, projectId: 'p1', folder: 'full' }, ctx, 'alice');
    assert.equal(noRoom.added, true, 'it is in the project all the same');
    assert.match(noRoom.folderError, /as many folders/);

    const refused = await handlers.document_add_to_project({ documentId, projectId: 'p2' }, ctx, 'alice');
    assert.match(refused.error, /Project not found/);
});

test('document_add_to_project reaches no document outside the conversation, and needs an id', async () => {
    const store = fakeStore();
    const filing = { targets: async () => [], fileDocument: async () => assert.fail('nothing is filed') };
    const handlers = makeTemplateFillHandlers({ store, filing: () => filing });
    const ctx = { documentScope: scope(), conversationId: 'conv-1' };
    assert.equal((await handlers.document_add_to_project({ documentId: 'doc-plain', projectId: 'p1' }, ctx, 'alice')).error, NOT_SHARED);
    assert.match((await handlers.document_add_to_project({ projectId: 'p1' }, ctx, 'alice')).error, /documentId is required/);
});

// ── The final check ─────────────────────────────────────────────────

test('template_fill_review keeps the assistant\'s remarks at their fields, and only the ones that say something', async () => {
    const { handlers, ctx, store } = setup();
    const { documentId } = await handlers.template_fill_start({ templateId: 'tpl-own' }, ctx, 'alice');
    await handlers.template_fill_set_values({ values: { client_name: 'van dijk groep', amount: 10, date: '2026-03-01', notes: 'deliver asap pls, call b4' } }, ctx, 'alice');
    const out = await handlers.template_fill_review({ findings: [
        { key: 'notes', kind: 'rewrite', suggestion: 'Please deliver as soon as possible, and call beforehand.', reason: 'Written out in full.' },
        { key: 'client_name', kind: 'doubt', reason: 'This looks like a trade name, not the legal name.' },
        { key: 'amount', kind: 'rewrite', suggestion: '11', reason: 'A number is never rewritten.' },
        { key: 'plan', kind: 'doubt', reason: 'Empty fields are not remarked on.' },
        { key: 'nope', kind: 'doubt', reason: 'Unknown field.' },
        { key: 'date', kind: 'doubt', reason: '' },
    ] }, ctx, 'alice');
    assert.equal(out.reviewed, true);
    assert.equal(out.checked, 4);
    assert.deepStrictEqual(out.remarks.map((remark) => `${remark.key}:${remark.kind}`), ['notes:rewrite', 'client_name:doubt']);
    assert.equal(out.dropped, 4);
    const kept = store.docs.get(documentId).settings.fillReview;
    assert.equal(kept.source, 'chat');
    assert.equal(kept.by, 'alice');
    assert.equal(kept.findings.length, 2);
    assert.equal(store.docs.get(documentId).settings.sampleValues.notes, 'deliver asap pls, call b4', 'a rewrite is a suggestion: nothing is changed');

    const status = await handlers.template_fill_status({}, ctx, 'alice');
    assert.equal(status.checked, true);
    assert.deepStrictEqual(keysOf(status.openRemarks), ['notes', 'client_name']);
    // The person changes the doubted value: that remark is gone, the other stays.
    await handlers.template_fill_set_values({ values: { client_name: 'Van Dijk Groep B.V.' } }, ctx, 'alice');
    const after = await handlers.template_fill_status({}, ctx, 'alice');
    assert.deepStrictEqual(keysOf(after.openRemarks), ['notes']);
    const done = await handlers.template_fill_finish({}, ctx, 'alice');
    assert.equal(done.finished, true);
    assert.equal(done.openRemarks, 1, 'finishing with a remark left open says so');
});

// ── Together, in a project ──────────────────────────────────────────

function teamKit() {
    const store = fakeStore();
    const notified = [];
    const people = [{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob de Vries' }, { id: 'bea', name: 'Bea Bos' }];
    const placed = [];
    const filing = {
        targets: async () => [], fileDocument: async () => assert.fail('a project document is not filed again'),
        folders: async () => [{ id: 'f1', name: 'Customers' }],
        placeInFolder: async (userId, projectId, documentId, folder) => { placed.push({ userId, projectId, documentId, folder }); return { ok: true, folder: { id: 'f1', name: 'Customers' }, created: false }; },
    };
    const ask = {
        notify: async (n) => { notified.push(n); },
        name: async (_user, key, vars) => `${key} ${JSON.stringify(vars)}`,
        projectRole: async (userId) => (people.some((person) => person.id === userId) ? 'editor' : null),
    };
    const handlers = makeTemplateFillHandlers({ store, filing: () => filing, ask });
    // The fake store lets a document's owner write, so the asker is the one who started the fill.
    const ctx = { documentScope: scope(), conversationId: 'chat-1', project: { id: 'p1' }, colleagues: async () => people };
    return { store, handlers, ctx, notified, placed };
}

test('in a team chat a colleague is tagged by name for fields, and the value the assistant stores closes the request', async () => {
    const { store, handlers, ctx, notified } = teamKit();
    const { documentId } = await handlers.template_fill_start({ templateId: 'tpl-own' }, ctx, 'alice');
    assert.equal(store.docs.get(documentId).projectId, 'p1');

    const who = await handlers.template_fill_ask_colleague({ fields: ['amount'] }, ctx, 'alice');
    assert.deepStrictEqual(who.colleagues.map((person) => person.name), ['Bob de Vries', 'Bea Bos'], 'without a person: who can be asked, not the asker');
    assert.match((await handlers.template_fill_ask_colleague({ person: 'B', fields: ['amount'] }, ctx, 'alice')).error, /more than one person/);
    assert.match((await handlers.template_fill_ask_colleague({ person: 'Carol', fields: ['amount'] }, ctx, 'alice')).error, /Nobody called "Carol"/);
    assert.match((await handlers.template_fill_ask_colleague({ person: 'bob', fields: ['nope'] }, ctx, 'alice')).error, /at least one field/);

    const asked = await handlers.template_fill_ask_colleague({ person: 'bob', fields: ['amount'], message: 'Incl. the discount' }, ctx, 'alice');
    assert.deepStrictEqual(asked.asked, { person: 'Bob de Vries', fields: ['amount'] });
    assert.equal(notified.length, 1);
    assert.equal(notified[0].userId, 'bob');
    assert.match(notified[0].message, /"person":"Alice"/);
    assert.equal(notified[0].link, `/app/projects/p1/documents/${documentId}`);

    const status = await handlers.template_fill_status({}, ctx, 'alice');
    assert.deepStrictEqual(status.waitingFor, [{ person: 'Bob de Vries', askedBy: 'Alice', fields: ['amount'], message: 'Incl. the discount' }]);

    // The answer comes in through the chat: stored by the assistant, it counts as filled in and answers the request.
    const set = await handlers.template_fill_set_values({ values: { amount: 1250 } }, ctx, 'alice');
    assert.equal(set.requestsAnswered, 1);
    const settings = store.docs.get(documentId).settings;
    assert.deepStrictEqual({ userId: settings.filledBy.amount.userId, via: settings.filledBy.amount.via }, { userId: 'alice', via: 'ai' });
    assert.ok(settings.valueRequests[0].doneAt, 'the request closed');
    assert.equal(notified.length, 2, 'who asked is told');
    assert.equal((await handlers.template_fill_status({}, ctx, 'alice')).waitingFor, undefined);
});

test('in a team chat a note is left for the others, and the document goes into a folder of the project', async () => {
    const { store, handlers, ctx, placed } = teamKit();
    const { documentId } = await handlers.template_fill_start({ templateId: 'tpl-own' }, ctx, 'alice');
    const noted = await handlers.template_fill_add_note({ field: 'amount', text: 'Still being negotiated, leave it.' }, ctx, 'alice');
    assert.equal(noted.noted, true);
    assert.match((await handlers.template_fill_add_note({ field: 'nope', text: 'x' }, ctx, 'alice')).error, /not in this document/);
    assert.match((await handlers.template_fill_add_note({ text: ' ' }, ctx, 'alice')).error, /Write the note/);
    assert.equal(store.docs.get(documentId).settings.fieldNotes.length, 1);
    const status = await handlers.template_fill_status({}, ctx, 'alice');
    assert.deepStrictEqual(status.notes, [{ by: 'Alice', field: 'amount', text: 'Still being negotiated, leave it.' }]);

    const where = await handlers.document_add_to_project({}, ctx, 'alice');
    assert.deepStrictEqual(where.folders, [{ id: 'f1', name: 'Customers' }], 'in the project already: only the folder is left to choose');
    const out = await handlers.document_add_to_project({ folder: 'customers' }, ctx, 'alice');
    assert.deepStrictEqual(out.folder, { id: 'f1', name: 'Customers' });
    assert.deepStrictEqual(placed, [{ userId: 'alice', projectId: 'p1', documentId, folder: 'customers' }]);
});

test('tagging a colleague and leaving a note are a team chat\'s: a person\'s own chat is told so', async () => {
    const { handlers, ctx } = setup();
    await handlers.template_fill_start({ templateId: 'tpl-own' }, ctx, 'alice');
    assert.match((await handlers.template_fill_ask_colleague({ person: 'bob', fields: ['amount'] }, ctx, 'alice')).error, /team chat/);
    assert.match((await handlers.template_fill_add_note({ text: 'x' }, ctx, 'alice')).error, /team chat/);
    assert.ok(!TEMPLATE_FILL_TOOLS.some((t) => ['template_fill_ask_colleague', 'template_fill_add_note'].includes(t.function.name)), 'and it is not offered them');
});
