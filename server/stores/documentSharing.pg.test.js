'use strict';

const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { usePglitePool } = require('../testUtils/pglitePool');
const { pg, close } = usePglitePool();
const documents = require('./documentStore');
const notebooks = require('./notebookStore');
const sharing = require('./lib/documentSharing');
const encryption = require('./lib/documentCrypto');
const { makeSwaps } = require('../testUtils/swaps');
const { swap, restore } = makeSwaps();
const userKey = crypto.randomBytes(32);
const orgKey = crypto.randomBytes(32);
let tier = 'none';
const unlocked = (id, fn) => encryption.sessions.run({ session: { user: { id }, encryptionKey: userKey.toString('base64') } }, fn);
const make = (extra = {}) => documents.createDocument({ userId: 'alice', name: 'Shared plan', bodyHtml: '<p>Confidential content</p>', settings: { houseStyle: false }, ...extra });

before(async () => {
    await pg.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, "organizationId" TEXT, groups TEXT DEFAULT '[]', username TEXT, "displayName" TEXT);
        INSERT INTO users VALUES ('alice','org1','[]','Alice',NULL),('bob','org1','["finance"]','Bob',NULL),('carol','org1','[]','Carol',NULL),('eve','org2','["finance"]','Eve',NULL);
        CREATE TABLE groups (id TEXT PRIMARY KEY, "organizationId" TEXT, name TEXT);
        INSERT INTO groups VALUES ('finance','org1','Finance'),('foreign','org2','Foreign');
        CREATE TABLE projects (id TEXT PRIMARY KEY, owner_id TEXT, organization_id TEXT NOT NULL DEFAULT '');`);
    swap(encryption.keySources, 'policy', async () => ({ enabled: tier !== 'none', tier }));
    swap(encryption.keySources, 'userKey', async () => userKey);
    swap(encryption.keySources, 'orgKey', async () => orgKey);
    await documents.initDB();
    await notebooks.initDB();
});
after(async () => { restore(); await close(); });

test('every document type can be shared to one user, groups, or the organisation', async () => {
    for (const docType of documents.DOC_TYPES.filter((type) => type !== 'spreadsheet')) {
        const doc = await make({ docType });
        assert.equal(await documents.getDocument(doc.id, 'bob'), null);
        await sharing.setSharing('document', doc.id, 'alice', { audience: 'restricted', sharedUserIds: ['bob'] });
        assert.equal((await documents.getDocument(doc.id, 'bob')).sharingRole, 'viewer');
        assert.equal(await documents.getDocument(doc.id, 'carol'), null);
        assert.equal(await documents.getDocument(doc.id, 'eve'), null);
        assert.equal(await documents.updateDocument(doc.id, 'bob', { bodyHtml: '<p>Overwritten</p>' }), null);
        assert.equal((await documents.listDocumentsPage('bob', { visibility: 'team' })).documents.some((row) => row.id === doc.id), true);
        await sharing.setSharing('document', doc.id, 'alice', { audience: 'restricted', sharedGroups: ['finance'] });
        assert.ok(await documents.getDocument(doc.id, 'bob'));
        await pg.query("UPDATE users SET groups = '[]' WHERE id = 'bob'");
        assert.equal(await documents.getDocument(doc.id, 'bob'), null);
        await pg.query(`UPDATE users SET groups = '["finance"]' WHERE id = 'bob'`);
        await sharing.setSharing('document', doc.id, 'alice', { audience: 'organisation' });
        assert.ok(await documents.getDocument(doc.id, 'carol'));
        assert.equal(await documents.getDocument(doc.id, 'eve'), null);
        await sharing.setSharing('document', doc.id, 'alice', { audience: 'private' });
        assert.equal(await documents.getDocument(doc.id, 'bob'), null);
    }
});

test('only the owner changes access and recipients must belong to the organisation', async () => {
    const doc = await make();
    await assert.rejects(sharing.setSharing('document', doc.id, 'bob', { audience: 'organisation' }), (e) => e.status === 404);
    for (const input of [{ sharedUserIds: ['eve'] }, { sharedGroups: ['foreign'] }, {}]) {
        await assert.rejects(sharing.setSharing('document', doc.id, 'alice', { audience: 'restricted', ...input }), (e) => e.status === 400);
    }
    assert.equal((await sharing.getSharing('document', doc.id, 'alice')).audience, 'private');
    const directory = await sharing.sharingDirectory('document', doc.id, 'alice');
    assert.deepEqual(directory.users.map((u) => u.id).sort(), ['bob', 'carol']);
    assert.deepEqual(directory.groups.map((g) => g.id), ['finance']);
});

test('deleting group shares prevents a reused group id from granting access again', async () => {
    const doc = await make();
    const notebook = await notebooks.createNotebook({ userId: 'alice', organizationId: 'org1' });
    await sharing.setSharing('document', doc.id, 'alice', { audience: 'restricted', sharedGroups: ['finance'] });
    await sharing.setSharing('notebook', notebook.id, 'alice', { audience: 'restricted', sharedGroups: ['finance'] });
    assert.ok(await documents.getDocument(doc.id, 'bob'));
    assert.equal(await notebooks.resolveNotebookRole(notebook.id, 'bob'), 'viewer');
    await sharing.revokeGroupShares('finance');
    assert.equal(await documents.getDocument(doc.id, 'bob'), null);
    assert.equal(await notebooks.resolveNotebookRole(notebook.id, 'bob'), null);
});

test('private user encryption changes to organisation encryption, including revision history', async () => {
    tier = 'zk';
    const doc = await unlocked('alice', () => make());
    const original = (await pg.query('SELECT body_html, settings FROM studio_documents WHERE id = $1', [doc.id])).rows[0];
    assert.equal(JSON.parse(original.body_html).documentContext.scope, 'user');
    assert.equal(original.body_html.includes('Confidential content'), false);
    await assert.rejects(documents.getDocument(doc.id, 'alice'), (e) => e.status === 423);
    await unlocked('alice', () => sharing.setSharing('document', doc.id, 'alice', { audience: 'restricted', sharedUserIds: ['bob'] }));
    const read = await unlocked('bob', () => documents.getDocument(doc.id, 'bob'));
    assert.equal(read.bodyHtml, '<p>Confidential content</p>');
    const saved = (await pg.query('SELECT body_html FROM studio_documents WHERE id = $1', [doc.id])).rows[0];
    assert.equal(JSON.parse(saved.body_html).documentContext.scope, 'organisation');
    const revisions = (await pg.query('SELECT body_html, snapshot FROM studio_document_versions WHERE document_id = $1', [doc.id])).rows;
    assert.ok(revisions.length);
    assert.equal(revisions.every((r) => JSON.parse(r.body_html).documentContext.scope === 'organisation' && r.snapshot.documentContext.scope === 'organisation'), true);
    assert.equal((await documents.getDocumentVersion(doc.id, 'bob', doc.versionId)).bodyHtml, doc.bodyHtml);
    await unlocked('alice', () => sharing.setSharing('document', doc.id, 'alice', { audience: 'private' }));
    assert.equal(await documents.getDocument(doc.id, 'bob'), null);
    assert.equal(JSON.parse((await pg.query('SELECT body_html FROM studio_documents WHERE id = $1', [doc.id])).rows[0].body_html).documentContext.scope, 'user');
    tier = 'none';
});

test('an unavailable organisation key rolls back encryption and access together', async () => {
    tier = 'managed';
    const doc = await make();
    swap(encryption.keySources, 'orgKey', async () => null);
    await assert.rejects(sharing.setSharing('document', doc.id, 'alice', { audience: 'organisation' }), (e) => e.status === 423);
    assert.equal((await sharing.getSharing('document', doc.id, 'alice')).audience, 'private');
    assert.equal(await documents.getDocument(doc.id, 'bob'), null);
    assert.equal((await documents.getDocument(doc.id, 'alice')).bodyHtml, doc.bodyHtml);
    swap(encryption.keySources, 'orgKey', async () => orgKey);
    tier = 'none';
});

test('the existing team-template control also converts encrypted historical versions', async () => {
    tier = 'zk';
    const doc = await unlocked('alice', () => make({ kind: 'template' }));
    await unlocked('alice', () => documents.updateDocument(doc.id, 'alice', { visibility: 'team' }));
    assert.equal((await documents.getDocumentVersion(doc.id, 'bob', doc.versionId)).bodyHtml, doc.bodyHtml);
    const revisions = (await pg.query('SELECT body_html FROM studio_document_versions WHERE document_id = $1', [doc.id])).rows;
    assert.equal(revisions.every((r) => JSON.parse(r.body_html).documentContext.scope === 'organisation'), true);
    tier = 'none';
});

test('revoking direct shares remains possible when the organisation key is unavailable', async () => {
    tier = 'managed';
    const doc = await make();
    await sharing.setSharing('document', doc.id, 'alice', { audience: 'organisation' });
    swap(encryption.keySources, 'orgKey', async () => null);
    await sharing.setSharing('document', doc.id, 'alice', { audience: 'private' });
    assert.equal((await sharing.getSharing('document', doc.id, 'alice')).audience, 'private');
    assert.equal(await documents.getDocument(doc.id, 'bob'), null);
    swap(encryption.keySources, 'orgKey', async () => orgKey);
    assert.equal((await documents.getDocument(doc.id, 'alice')).bodyHtml, doc.bodyHtml);
    tier = 'none';
});

test('notebooks share their encrypted content, sources and versions with viewer permissions', async () => {
    tier = 'zk';
    const notebook = await unlocked('alice', () => notebooks.createNotebook({ userId: 'alice', organizationId: 'org1', name: 'Research', instructions: 'Sensitive instructions' }));
    await unlocked('alice', () => notebooks.updateNotebook(notebook.id, 'alice', { documentContent: '<p>Notebook content</p>' }));
    const source = await unlocked('alice', () => notebooks.addSource({ notebookId: notebook.id, type: 'text', name: 'Notes', contentText: 'Sensitive source', metadata: { text: 'Private extract' } }));
    await unlocked('alice', () => notebooks.createVersion(notebook.id, '<p>Notebook history</p>', 'Checkpoint'));
    await unlocked('alice', () => sharing.setSharing('notebook', notebook.id, 'alice', { audience: 'restricted', sharedGroups: ['finance'] }));
    const read = await unlocked('bob', () => notebooks.getNotebook(notebook.id, 'bob'));
    assert.equal(read.role, 'viewer');
    assert.equal(read.documentContent, '<p>Notebook content</p>');
    assert.equal(read.instructions, 'Sensitive instructions');
    assert.equal(await notebooks.getSourceContent(source.id), 'Sensitive source');
    assert.equal((await notebooks.getSources(notebook.id))[0].metadata.text, 'Private extract');
    assert.equal((await notebooks.getVersion((await notebooks.getVersions(notebook.id))[0].id)).content, '<p>Notebook history</p>');
    assert.equal(await notebooks.updateNotebook(notebook.id, 'bob', { name: 'Stolen' }), false);
    assert.equal((await documents.listDocumentsPage('bob', { includeNotebooks: true, docType: 'notebook', visibility: 'team' })).documents.some((row) => row.id === notebook.id), true);
    const raw = (await pg.query('SELECT content_text, metadata FROM notebook_sources WHERE id = $1', [source.id])).rows[0];
    assert.equal(JSON.parse(raw.content_text).documentContext.scope, 'organisation');
    assert.equal(raw.metadata.documentContext.scope, 'organisation');
    assert.equal(await notebooks.getNotebook(notebook.id, 'eve'), null);
    tier = 'none';
});

test('spreadsheet cells and formulas use the organisation key after sharing', async () => {
    tier = 'zk';
    const sheetCrypto = require('./lib/sheetCrypto');
    const tableStore = require('./datatableDbStore');
    const scopeKey = tableStore.scopeKey({ kind: 'user', id: 'alice' });
    const schema = tableStore._schemaFor(scopeKey);
    await pg.exec(`CREATE TABLE datatables (id TEXT PRIMARY KEY, key TEXT, scope_kind TEXT, scope_id TEXT, managed_kind TEXT);
        INSERT INTO datatables VALUES ('dt1','sheet_test','user','alice','document_sheet');
        CREATE SCHEMA "${schema}";
        CREATE TABLE "${schema}".sheet_test (id TEXT PRIMARY KEY, row_no INTEGER, ${'abcdefghijklmnopqrstuvwxyz'.split('').map((c) => `"${c}" TEXT`).join(', ')});`);
    const doc = await unlocked('alice', () => make({ docType: 'spreadsheet', sheetTableId: 'dt1' }));
    const resolved = { table: { id: 'dt1', managedKind: 'document_sheet', ownerUserId: 'alice' }, scopeKey, meta: { key: 'sheet_test' } };
    const values = await unlocked('alice', () => sheetCrypto.sealValues(resolved, { row_no: 1, a: '42', b: '=SUM(A1:A2)' }));
    assert.equal(JSON.parse(values.a).documentContext.scope, 'user');
    await pg.query(`INSERT INTO "${schema}".sheet_test(id,row_no,a,b) VALUES ('r1',1,$1,$2)`, [values.a, values.b]);
    await unlocked('alice', () => sharing.setSharing('document', doc.id, 'alice', { audience: 'restricted', sharedUserIds: ['bob'] }));
    const row = (await pg.query(`SELECT * FROM "${schema}".sheet_test`)).rows[0];
    assert.equal(JSON.parse(row.a).documentContext.scope, 'organisation');
    const read = await unlocked('bob', () => sheetCrypto.openRow('dt1', row));
    assert.equal(read.a, '42');
    assert.equal(read.b, '=SUM(A1:A2)');
    const edited = await sheetCrypto.sealValues(resolved, { row_no: 1, a: '43' });
    assert.equal(JSON.parse(edited.a).documentContext.scope, 'organisation');
    await assert.rejects(sheetCrypto.assertQuery(resolved, ['a']), (e) => e.status === 400 && e.code === 'encrypted_sheet_query');
    await sheetCrypto.assertQuery(resolved, ['row_no']);
    tier = 'none';
});

test('original notebook source files are re-encrypted and replaced only after the sharing transaction commits', async () => {
    tier = 'zk';
    const files = new Map();
    const storage = require('./storageStore');
    swap(storage, 'streamFile', async (key) => ({ stream: Readable.from([files.get(key)]) }));
    swap(storage, 'uploadFile', async (key, bytes) => { files.set(key, bytes); });
    swap(storage, 'deleteFile', async (key) => { files.delete(key); });
    const fileCrypto = require('./lib/notebookFileCrypto');
    const notebook = await unlocked('alice', () => notebooks.createNotebook({ userId: 'alice', organizationId: 'org1', name: 'Files' }));
    const key = 'users/alice/notebooks/confidential.pdf';
    const resource = { type: 'notebook', id: notebook.id, userId: 'alice', organizationId: 'org1' };
    files.set(key, await unlocked('alice', () => fileCrypto.sealBuffer(resource, key, Buffer.from('confidential PDF bytes'))));
    const source = await unlocked('alice', () => notebooks.addSource({ notebookId: notebook.id, type: 'pdf', name: 'PDF', storageKey: key }));
    await unlocked('alice', () => sharing.setSharing('notebook', notebook.id, 'alice', { audience: 'organisation' }));
    const read = await notebooks.getSource(source.id);
    assert.notEqual(read.storageKey, key);
    assert.equal(files.has(key), false);
    assert.equal(JSON.parse(files.get(read.storageKey).toString()).documentContext.scope, 'organisation');
    assert.equal((await fileCrypto.readBuffer(read.storageKey)).toString(), 'confidential PDF bytes');
    tier = 'none';
});

test('a failed source-file replacement rolls back all ciphertext and sharing without deleting originals', async () => {
    tier = 'zk';
    const files = new Map();
    const storage = require('./storageStore');
    const fileCrypto = require('./lib/notebookFileCrypto');
    let uploaded = 0;
    swap(storage, 'streamFile', async (key) => ({ stream: Readable.from([files.get(key)]) }));
    swap(storage, 'uploadFile', async (key, bytes) => {
        if (++uploaded === 2) throw new Error('Storage unavailable');
        files.set(key, bytes);
    });
    swap(storage, 'deleteFile', async (key) => { files.delete(key); });
    const notebook = await unlocked('alice', () => notebooks.createNotebook({ userId: 'alice', organizationId: 'org1', name: 'Rollback' }));
    const resource = { type: 'notebook', id: notebook.id, userId: 'alice', organizationId: 'org1' };
    const originals = ['users/alice/notebooks/first.pdf', 'users/alice/notebooks/second.pdf'];
    const sources = [];
    for (const key of originals) {
        files.set(key, await unlocked('alice', () => fileCrypto.sealBuffer(resource, key, Buffer.from('original bytes'))));
        sources.push(await unlocked('alice', () => notebooks.addSource({ notebookId: notebook.id, type: 'pdf', name: key, storageKey: key })));
    }
    await assert.rejects(unlocked('alice', () => sharing.setSharing('notebook', notebook.id, 'alice', { audience: 'organisation' })), /Storage unavailable/);
    assert.deepEqual([...files.keys()].sort(), originals.sort());
    assert.equal((await sharing.getSharing('notebook', notebook.id, 'alice')).audience, 'private');
    assert.equal(await notebooks.resolveNotebookRole(notebook.id, 'bob'), null);
    for (const source of sources) {
        const read = await unlocked('alice', () => notebooks.getSource(source.id));
        assert.equal(read.storageKey, source.storageKey);
        assert.equal(JSON.parse(files.get(read.storageKey).toString()).documentContext.scope, 'user');
    }
    tier = 'none';
});
