/**
 * The folders of a project's Documents tab (documentFolders.mts), through
 * express with a fake store and role gate: who may do what, and the answers.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { makeDocumentFoldersRouter } = require('./documentFolders.mts');

const ROLES = { ann: 'owner', ben: 'editor', cas: 'viewer' };
const LADDER = ['viewer', 'editor', 'owner'];

function fakeStore() {
    const folders = [];
    const placed = {};
    return {
        folders, placed,
        async listFolders(p) { return folders.filter((f) => f.projectId === p).map(({ projectId: _p, ...f }) => f); },
        async placements() { return { ...placed }; },
        async createFolder(projectId, name, userId) {
            if (folders.length >= 3) return null;
            const f = { id: `f${folders.length + 1}`, projectId, name, createdBy: userId, createdAt: 'now' };
            folders.push(f);
            return f;
        },
        async renameFolder(p, id, name) { const f = folders.find((x) => x.id === id && x.projectId === p); if (!f) return null; f.name = name; return f; },
        async deleteFolder(p, id) { const i = folders.findIndex((x) => x.id === id && x.projectId === p); if (i < 0) return false; folders.splice(i, 1); return true; },
        async placeDocument(p, documentId, folderId) {
            if (documentId !== 'd1') return false;
            if (folderId && !folders.some((f) => f.id === folderId && f.projectId === p)) return false;
            if (folderId) placed[documentId] = folderId; else delete placed[documentId];
            return true;
        },
    };
}

async function withServer(store, fn) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.session = { user: { id: String(req.headers['x-user']) } }; next(); });
    const requireProjectRole = (min) => (req, res, next) => {
        const role = ROLES[req.session.user.id];
        if (!role) return res.status(404).json({ error: 'Not found' });
        if (LADDER.indexOf(role) < LADDER.indexOf(min)) return res.status(403).json({ error: 'Forbidden' });
        req.projectRole = role;
        return next();
    };
    app.use('/api/projects', makeDocumentFoldersRouter({ store: () => store, requireProjectRole }));
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message, code: err.code }));
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api/projects/p1`;
    const call = async (method, path, body, user = 'ben') => {
        const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', 'x-user': user }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, body: await res.json() };
    };
    try { await fn(call); } finally { server.close(); }
}

test('an editor makes, renames and deletes a folder; a viewer only reads them', async () => {
    const store = fakeStore();
    await withServer(store, async (call) => {
        const made = await call('POST', '/document-folders', { name: '  Contracts ' });
        assert.equal(made.status, 201);
        assert.equal(made.body.folder.name, 'Contracts');
        assert.equal((await call('POST', '/document-folders', { name: 'Mine' }, 'cas')).status, 403);
        const listed = await call('GET', '/document-folders', null, 'cas');
        assert.deepEqual(listed.body.folders.map((f) => f.name), ['Contracts']);
        assert.equal((await call('PATCH', `/document-folders/${made.body.folder.id}`, { name: 'Signed' })).body.folder.name, 'Signed');
        assert.equal((await call('PATCH', '/document-folders/nope', { name: 'X' })).status, 404);
        assert.equal((await call('DELETE', `/document-folders/${made.body.folder.id}`, null, 'cas')).status, 403);
        assert.equal((await call('DELETE', `/document-folders/${made.body.folder.id}`)).status, 200);
        assert.equal((await call('DELETE', `/document-folders/${made.body.folder.id}`)).status, 404);
    });
});

test('a folder needs a name, and the cap answers 409', async () => {
    const store = fakeStore();
    await withServer(store, async (call) => {
        assert.equal((await call('POST', '/document-folders', { name: '   ' })).status, 400);
        assert.equal((await call('POST', '/document-folders', { name: 'x'.repeat(121) })).status, 400);
        for (const n of ['a', 'b', 'c']) assert.equal((await call('POST', '/document-folders', { name: n })).status, 201);
        const full = await call('POST', '/document-folders', { name: 'd' });
        assert.equal(full.status, 409);
        assert.equal(full.body.code, 'folder_limit');
    });
});

test('a document of the project moves into a folder and back; anything else is 404', async () => {
    const store = fakeStore();
    await withServer(store, async (call) => {
        const { body: { folder } } = await call('POST', '/document-folders', { name: 'Contracts' });
        assert.equal((await call('PUT', '/document-folders/placement', { documentId: 'd1', folderId: folder.id })).status, 200);
        assert.deepEqual((await call('GET', '/document-folders')).body.placements, { d1: folder.id });
        assert.equal((await call('PUT', '/document-folders/placement', { documentId: 'd-other', folderId: folder.id })).status, 404);
        assert.equal((await call('PUT', '/document-folders/placement', { documentId: 'd1', folderId: 'f-other' })).status, 404);
        assert.equal((await call('PUT', '/document-folders/placement', { documentId: 'd1', folderId: null }, 'cas')).status, 403);
        assert.equal((await call('PUT', '/document-folders/placement', { documentId: 'd1', folderId: null })).status, 200);
        assert.deepEqual(store.placed, {});
    });
});
