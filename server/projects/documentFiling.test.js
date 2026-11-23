'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDocumentFiling } = require('./documentFiling.mts');

function setup({ role = 'editor', kind = 'workspace', fileOk = true } = {}) {
    const moves = [];
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
    });
    return { filing, moves };
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
