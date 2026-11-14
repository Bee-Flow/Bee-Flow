/**
 * auth/notebookAccess.mts: the notebook role gate with the store injected.
 * The role itself is the store's (stores/notebook/membership.js, tested next
 * to it); here: the ladder, the gate's answers (404 for no role and for an
 * unknown id alike, 401 without a session, 403 with a code below the role),
 * what it leaves on the request, that the store is read at call time, and
 * the tag the route contract reads.
 *
 * Run: cd server && node --test auth/notebookAccess.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeNotebookAccess, hasNotebookRole, ROLE_RANK } = require('./notebookAccess.mts');
const { readGate } = require('./gateMeta');

/** A store answering `rows[id]` to `forUser` only (as getNotebook answers nothing to a stranger). */
function access(rows, forUser = 'me') {
    const store = { getNotebook: async (id, userId) => (userId === forUser ? rows[id] || null : null), calls: 0 };
    const a = makeNotebookAccess({ getNotebook: (id, userId) => { store.calls++; return store.getNotebook(id, userId); } });
    return { a, store };
}
const req = (user = { id: 'me' }, params = { id: 'n1' }) => ({ session: user ? { user } : {}, params });

/** Dispatch the gate: the answer is `next()` or the HttpError it threw. */
async function run(gate, r) {
    try {
        let passed = false;
        await gate(r, {}, () => { passed = true; });
        return { passed };
    } catch (err) {
        return { passed: false, status: err.status, code: err.code, message: err.message };
    }
}

test('hasNotebookRole orders the ladder', () => {
    assert.deepEqual(ROLE_RANK, { viewer: 1, editor: 2, owner: 3 });
    assert.equal(hasNotebookRole('owner', 'viewer'), true);
    assert.equal(hasNotebookRole('editor', 'owner'), false);
    assert.equal(hasNotebookRole(null, 'viewer'), false);
    assert.equal(hasNotebookRole('king', 'viewer'), false);
});

test('roleOf: the store\'s role; a row without one is its owner\'s; a stranger and an unknown id hold none', async () => {
    const { a } = access({ n1: { id: 'n1', userId: 'me' }, n2: { id: 'n2', userId: 'them', role: 'editor' }, n3: { id: 'n3', userId: 'them' } });
    assert.equal((await a.roleOf(req(), 'n1')).role, 'owner');
    assert.equal((await a.roleOf(req(), 'n2')).role, 'editor');
    assert.equal(await a.roleOf(req(), 'n3'), null, 'no role and not the owner');
    assert.equal(await a.roleOf(req(), 'nope'), null);
    assert.equal(await a.roleOf(req({ id: 'stranger' }), 'n2'), null);
    assert.equal(await a.roleOf(req(null), 'n1'), null);
});

test('requireNotebookRole: an unknown id and a notebook the caller holds no role on answer the same 404; no session is 401', async () => {
    const { a } = access({ n1: { id: 'n1', userId: 'them', role: 'viewer' } });
    const gate = a.requireNotebookRole('viewer');
    const unknown = await run(gate, req({ id: 'me' }, { id: 'nope' }));
    const stranger = await run(gate, req({ id: 'stranger' }));
    assert.deepEqual([unknown.status, unknown.code], [404, 'notebook_not_found']);
    assert.deepEqual([stranger.status, stranger.code, stranger.message], [unknown.status, unknown.code, unknown.message]);
    assert.equal((await run(gate, req(null))).status, 401);
});

test('requireNotebookRole: below the role is a 403 with the code of the step; at the role the handler runs with the notebook and the role on the request', async () => {
    const { a } = access({ n1: { id: 'n1', userId: 'them', role: 'viewer' }, n2: { id: 'n2', userId: 'them', role: 'editor' } });
    const asEditor = await run(a.requireNotebookRole('editor'), req());
    assert.deepEqual([asEditor.status, asEditor.code], [403, 'notebook_read_only']);
    const asOwner = await run(a.requireNotebookRole('owner'), req({ id: 'me' }, { id: 'n2' }));
    assert.deepEqual([asOwner.status, asOwner.code], [403, 'notebook_owner_only']);
    const r = req({ id: 'me' }, { id: 'n2' });
    assert.equal((await run(a.requireNotebookRole('editor'), r)).passed, true);
    assert.equal(r.notebook.id, 'n2');
    assert.equal(r.notebookRole, 'editor');
    assert.throws(() => a.requireNotebookRole('king'), /unknown role/);
});

test('the store is read per request, so a swapped store is the one asked; `param` names the path parameter', async () => {
    const { a, store } = access({ n1: { id: 'n1', userId: 'me' } });
    const gate = a.requireNotebookRole('owner', { param: 'notebookId' });
    assert.equal((await run(gate, req({ id: 'me' }, { notebookId: 'n1' }))).passed, true);
    store.getNotebook = async () => null;
    assert.equal((await run(gate, req({ id: 'me' }, { notebookId: 'n1' }))).status, 404);
    assert.equal(store.calls, 2);
});

test('the gate is tagged scoped, with the role, so the route contract can read it', () => {
    const { a } = access({});
    assert.deepEqual(readGate(a.requireNotebookRole('editor')), { axis: 'scoped', minGrade: 'editor', param: 'id' });
});
