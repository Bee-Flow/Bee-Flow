'use strict';
/**
 * The folders of a project's Documents tab against PGlite (projectDocumentFolders.mts).
 *
 * Run: cd server && node --test stores/projectDocumentFolders.pg.test.js
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgliteDb, createProjectScopedSchema } = require('../testUtils/pgliteDb');
const { makeProjectDocumentFolders, DDL, folderCap } = require('./projectDocumentFolders.mts');

const { pg, db } = pgliteDb();
let cap = 0;
const store = makeProjectDocumentFolders(db, { cap: () => cap });

before(async () => {
    await createProjectScopedSchema(pg, 'CREATE TABLE studio_documents (id TEXT PRIMARY KEY, project_id TEXT);\n' + DDL);
    await pg.exec(`INSERT INTO studio_documents (id, project_id) VALUES ('d1', 'p1'), ('d2', 'p1'), ('d-other', 'p2'), ('d-loose', NULL)`);
});
after(async () => { await pg.close(); });

test('the schema can be created again without changes', async () => {
    await pg.exec(DDL);
});

test('folders are per project, listed by name, renamed and capped', async () => {
    const b = await store.createFolder('p1', 'Contracts', 'ann');
    const a = await store.createFolder('p1', 'archive', 'ben');
    await store.createFolder('p2', 'Theirs', 'eve');
    assert.deepEqual((await store.listFolders('p1')).map((f) => f.name), ['archive', 'Contracts']);
    assert.equal(b.createdBy, 'ann');
    assert.equal((await store.renameFolder('p1', a.id, 'Archive')).name, 'Archive');
    const theirs = (await store.listFolders('p2'))[0];
    assert.equal(await store.renameFolder('p1', theirs.id, 'Mine'), null, 'another project\'s folder is not reached');
    assert.equal(await store.deleteFolder('p1', theirs.id), false);
    cap = 2;
    assert.equal(await store.createFolder('p1', 'Third', 'ann'), null, 'the cap holds');
    cap = 0;
    assert.equal(folderCap({}), 500);
    assert.equal(folderCap({ PROJECT_DOCUMENT_FOLDERS_MAX: '0' }), 0);
});

test('a document of the project goes into one of its folders, and back to the top', async () => {
    const [folder] = await store.listFolders('p1');
    const [theirs] = await store.listFolders('p2');
    assert.equal(await store.placeDocument('p1', 'd1', folder.id), true);
    assert.deepEqual(await store.placements('p1'), { d1: folder.id });
    assert.equal(await store.placeDocument('p1', 'd-other', folder.id), false, 'not a document of this project');
    assert.equal(await store.placeDocument('p1', 'd-loose', folder.id), false);
    assert.equal(await store.placeDocument('p1', 'd2', theirs.id), false, 'not a folder of this project');
    assert.equal(await store.placeDocument('p1', 'd1', null), true);
    assert.deepEqual(await store.placements('p1'), {});
});

test('a document taken out of the project loses its place; deleting a folder frees its documents', async () => {
    const folder = await store.createFolder('p1', 'Temp', 'ann');
    await store.placeDocument('p1', 'd1', folder.id);
    await store.placeDocument('p1', 'd2', folder.id);
    await pg.exec(`UPDATE studio_documents SET project_id = NULL WHERE id = 'd2'`);
    assert.deepEqual(await store.placements('p1'), { d1: folder.id });
    assert.equal(await store.deleteFolder('p1', folder.id), true);
    assert.deepEqual(await store.placements('p1'), {});
});
