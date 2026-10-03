'use strict';

/**
 * Notebooks in the Documents library, against a REAL Postgres (PGlite behind
 * db.js's pool, testUtils/pglitePool.js), with no module mocking.
 *
 *   - an existing notebook is a library row of type 'notebook' with no copy:
 *     listed, searched, sorted and counted together with the documents;
 *   - only for a reader the route let through the notebook gates
 *     (`includeNotebooks`), only the owner's own, and only where the filters
 *     leave room for a notebook (never a template, team, archived view);
 *   - filed in a folder and under categories by its owner; a deleted folder's
 *     notebooks move up to its parent, as its documents do.
 *
 * Run: cd server && node --test stores/notebookLibrary.pg.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const documents = require('./documentStore');
const notebooks = require('./notebookStore');
const library = require('./notebookLibrary');

let research;
let draft;
let page;

before(async () => {
    await pg.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, "organizationId" TEXT);
        INSERT INTO users VALUES ('alice','org1'), ('bob','org1');
        CREATE TABLE projects (id TEXT PRIMARY KEY, owner_id TEXT, organization_id TEXT NOT NULL DEFAULT '');`);
    await documents.initDB();
    await notebooks.initDB();
    research = await notebooks.createNotebook({ userId: 'alice', name: 'Market research', description: 'Competitors', organizationId: 'org1' });
    await notebooks.addSource({ notebookId: research.id, type: 'text', name: 'Notes', contentText: 'some text', wordCount: 2 });
    await notebooks.addSource({ notebookId: research.id, type: 'url', name: 'Site' });
    draft = await notebooks.createNotebook({ userId: 'bob', name: 'Bob only', organizationId: 'org1' });
    page = await documents.createDocument({ userId: 'alice', name: 'Meeting page', docType: 'page', bodyHtml: '<p>Hi</p>' });
    await documents.createDocument({ userId: 'alice', name: 'Offer template', kind: 'template' });
});

after(close);

const ids = (list) => list.documents.map((d) => d.id);

test('an existing notebook is a document of type notebook in its owner\'s library', async () => {
    const list = await documents.listDocumentsPage('alice', { kind: 'document', includeNotebooks: true });
    assert.deepStrictEqual(new Set(ids(list)), new Set([research.id, page.id]));
    assert.strictEqual(list.total, 2);
    const row = list.documents.find((d) => d.id === research.id);
    assert.strictEqual(row.docType, 'notebook');
    assert.strictEqual(row.kind, 'document');
    assert.strictEqual(row.visibility, 'private');
    assert.strictEqual(row.userId, 'alice');
    assert.strictEqual(row.sourceCount, 2);
    // A document row carries no source count.
    assert.strictEqual(list.documents.find((d) => d.id === page.id).sourceCount, undefined);
});

test('without the notebook gates the library is documents only', async () => {
    const list = await documents.listDocumentsPage('alice', { kind: 'document' });
    assert.deepStrictEqual(ids(list), [page.id]);
    assert.strictEqual(list.total, 1);
});

test('the filters decide whether a notebook can be in the list at all', async () => {
    const only = await documents.listDocumentsPage('alice', { kind: 'document', docType: 'notebook', includeNotebooks: true });
    assert.deepStrictEqual(ids(only), [research.id]);
    const pages = await documents.listDocumentsPage('alice', { kind: 'document', docType: 'page', includeNotebooks: true });
    assert.deepStrictEqual(ids(pages), [page.id]);
    const designed = await documents.listDocumentsPage('alice', { kind: 'document', docType: 'designed', includeNotebooks: true });
    assert.deepStrictEqual(ids(designed), []);
    for (const options of [{ kind: 'template' }, { kind: 'document', visibility: 'team' }, { kind: 'document', archived: true }]) {
        const list = await documents.listDocumentsPage('alice', { ...options, includeNotebooks: true });
        assert.ok(!ids(list).includes(research.id), JSON.stringify(options));
    }
    const search = await documents.listDocumentsPage('alice', { kind: 'document', query: 'competitor', includeNotebooks: true });
    assert.deepStrictEqual(ids(search), [research.id]);
});

test('sorting and paging run over documents and notebooks together', async () => {
    const byName = await documents.listDocumentsPage('alice', { kind: 'document', sort: 'name', includeNotebooks: true });
    assert.deepStrictEqual(byName.documents.map((d) => d.name), ['Market research', 'Meeting page']);
    const second = await documents.listDocumentsPage('alice', { kind: 'document', sort: 'name', limit: 1, offset: 1, includeNotebooks: true });
    assert.deepStrictEqual(second.documents.map((d) => d.name), ['Meeting page']);
    assert.strictEqual(second.total, 2);
    // An offset past the end still knows how many there are.
    const past = await documents.listDocumentsPage('alice', { kind: 'document', limit: 1, offset: 5, includeNotebooks: true });
    assert.deepStrictEqual(past.documents, []);
    assert.strictEqual(past.total, 2);
});

test('the owner files a notebook in a folder and under categories; nobody else can', async () => {
    const folder = await documents.createFolder('alice', 'Clients');
    const filed = await library.setNotebookFiling('alice', research.id, { folderId: folder.id, categories: [' Acme ', 'Acme', 'Q3'] }, documents.assertFolder);
    assert.deepStrictEqual(filed, { folderId: folder.id, categories: ['Acme', 'Q3'] });
    assert.strictEqual(await library.setNotebookFiling('bob', research.id, { categories: ['x'] }, documents.assertFolder), null);
    // Somebody else's folder is refused.
    const bobs = await documents.createFolder('bob', 'Mine');
    await assert.rejects(library.setNotebookFiling('alice', research.id, { folderId: bobs.id }, documents.assertFolder), (e) => e.status === 404);

    const inFolder = await documents.listDocumentsPage('alice', { kind: 'document', folderId: folder.id, includeNotebooks: true });
    assert.deepStrictEqual(ids(inFolder), [research.id]);
    const root = await documents.listDocumentsPage('alice', { kind: 'document', folderId: '', includeNotebooks: true });
    assert.deepStrictEqual(ids(root), [page.id]);
    const tagged = await documents.listDocumentsPage('alice', { kind: 'document', category: 'Q3', includeNotebooks: true });
    assert.deepStrictEqual(ids(tagged), [research.id]);
    // Filing is not an edit: the notebook's version is untouched.
    assert.strictEqual((await notebooks.getNotebook(research.id, 'alice')).version, research.version || 0);

    await documents.deleteFolder('alice', folder.id);
    const after = await documents.listDocumentsPage('alice', { kind: 'document', folderId: '', includeNotebooks: true });
    assert.ok(ids(after).includes(research.id));
});

test('somebody else\'s notebook is never in my library', async () => {
    const list = await documents.listDocumentsPage('alice', { kind: 'document', includeNotebooks: true });
    assert.ok(!ids(list).includes(draft.id));
});
