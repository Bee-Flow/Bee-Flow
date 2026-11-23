'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDocumentFiling } = require('./documentFiling.mts');

function setup({ role = 'editor', kind = 'workspace', fileOk = true, cap } = {}) {
    const moves = [];
    const folderStore = fakeFolders({ cap });
    const filing = makeDocumentFiling({
        listProjects: async () => [
            { id: 'p-own', name: 'Own', kind: 'workspace', permission: 'owner' },
            { id: 'p-edit', name: 'Edit', kind: null, permission: 'editor' },
            { id: 'p-view', name: 'View', kind: 'workspace', permission: 'viewer' },
            { id: 'p-sol', name: 'Solution', kind: 'solution', permission: 'owner' },
        ],
        getProject: async (id) => (id === 'missing' ? null : { id, name: 'Target', kind }),
        getProjectRole: async () => role,
        isAllowedIn: (_k, projectKind) => projectKind !== 'solution',
        documentEntry: () => ({ setProject: async () => true }),
        fileItem: async (move) => { moves.push(move); return fileOk; },
        folders: () => folderStore,
    });
    return { filing, moves, folderStore };
}

/** A project's folders as the store keeps them: `d1` is in the project, at most `cap` folders. */
function fakeFolders({ cap = 2 } = {}) {
    const folders = [{ id: 'f1', name: 'Customers' }];
    const placed = new Map();
    return {
        folders, placed,
        listFolders: async () => folders.map((f) => ({ ...f, createdBy: 'u1', createdAt: 'now' })),
        createFolder: async (_projectId, name) => {
            if (folders.length >= cap) return null;
            const folder = { id: `f${folders.length + 1}`, name };
            folders.push(folder);
            return folder;
        },
        placeDocument: async (_projectId, documentId, folderId) => {
            if (documentId !== 'd1') return false;
            if (folderId === null) placed.delete(documentId); else placed.set(documentId, folderId);
            return true;
        },
    };
}

test('targets: the projects the person owns or edits that hold documents', async () => {
    const { filing } = setup();
    assert.deepEqual(await filing.targets('u1'), [{ id: 'p-own', name: 'Own' }, { id: 'p-edit', name: 'Edit' }]);
});

test('fileDocument files through the project filing, as the person', async () => {
    const { filing, moves } = setup();
    assert.deepEqual(await filing.fileDocument('u1', 'd1', 'p1'), { ok: true, project: { id: 'p1', name: 'Target' } });
    assert.equal(moves.length, 1);
    assert.deepEqual({ ...moves[0], entry: undefined }, { entry: undefined, kind: 'document', id: 'd1', userId: 'u1', projectId: 'p1', attach: true });
});

test('fileDocument refuses a viewer, a stranger, a Solution and a document that is not the person\'s', async () => {
    assert.match((await setup({ role: 'viewer' }).filing.fileDocument('u1', 'd1', 'p1')).error, /only view/);
    assert.match((await setup({ role: null }).filing.fileDocument('u1', 'd1', 'p1')).error, /Project not found/);
    assert.match((await setup().filing.fileDocument('u1', 'd1', 'missing')).error, /Project not found/);
    assert.match((await setup({ kind: 'solution' }).filing.fileDocument('u1', 'd1', 'p1')).error, /Solution/);
    assert.match((await setup({ fileOk: false }).filing.fileDocument('u1', 'd1', 'p1')).error, /owner of a document/);
    const { filing, moves } = setup({ role: 'viewer' });
    await filing.fileDocument('u1', 'd1', 'p1');
    assert.equal(moves.length, 0);
});

test('placeInFolder puts a project document in the folder by that name, and makes the folder when there is none', async () => {
    const { filing, folderStore } = setup();
    assert.deepEqual(await filing.folders('u1', 'p1'), [{ id: 'f1', name: 'Customers' }]);
    assert.deepEqual(await filing.placeInFolder('u1', 'p1', 'd1', ' customers '), { ok: true, folder: { id: 'f1', name: 'Customers' }, created: false });
    assert.equal(folderStore.placed.get('d1'), 'f1');
    assert.deepEqual(await filing.placeInFolder('u1', 'p1', 'd1', 'Van Dijk BV'), { ok: true, folder: { id: 'f2', name: 'Van Dijk BV' }, created: true });
    assert.equal(folderStore.placed.get('d1'), 'f2', 'moved, not copied');
    assert.deepEqual(await filing.placeInFolder('u1', 'p1', 'd1', 'f1'), { ok: true, folder: { id: 'f1', name: 'Customers' }, created: false }, 'an id works as well as a name');
});

test('placeInFolder refuses a viewer, a document that is not in the project, no name, and one folder too many', async () => {
    const viewer = setup({ role: 'viewer' });
    assert.match((await viewer.filing.placeInFolder('u1', 'p1', 'd1', 'Customers')).error, /may edit the project/);
    assert.deepEqual(await setup({ role: null }).filing.folders('u1', 'p1'), [], 'a stranger is told of no folder');
    const { filing, folderStore } = setup({ cap: 1 });
    assert.match((await filing.placeInFolder('u1', 'p1', 'd-elsewhere', 'New folder')).error, /not in this project/);
    assert.equal(folderStore.folders.length, 1, 'no folder is made for a document that cannot go in it');
    assert.match((await filing.placeInFolder('u1', 'p1', 'd1', '   ')).error, /name of the folder/);
    assert.match((await filing.placeInFolder('u1', 'p1', 'd1', 'One more')).error, /as many folders/);
});
