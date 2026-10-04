'use strict';

/**
 * The project workspace routes (routes/projects/workspace.js): files,
 * "my chats" and presence.
 *
 * The factory router is served with injected fakes behind a real express app
 * and the real terminal error handler — no module mocking. The role fake
 * answers like auth/projectAccess.requireProjectRole: 401 without a session,
 * 404 for somebody who is not a member, 403 for a role that is too low.
 *
 * Proven, per route: the happy path, the refusals (no session, not a member,
 * role too low, a closed schema), and that a refused request never reaches
 * the files service, the chat list or the event bus.
 *
 * Run: cd server && node --test routes/projects/workspace.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');
const { assertRefused } = require('../../core/http/routeHarness');
const { makeWorkspaceRouter } = require('./workspace');

const OWNER = { id: 'u_owner', organizationId: 'org1' };
const EDITOR = { id: 'u_editor', organizationId: 'org1' };
const VIEWER = { id: 'u_viewer', organizationId: 'org1' };
const STRANGER = { id: 'u_stranger', organizationId: 'org1' };

const FILE_ID = '33333333-3333-4333-8333-333333333333';
const ROLES = {
    p1: { u_owner: 'owner', u_editor: 'editor', u_viewer: 'viewer' },
    sol: { u_owner: 'owner', u_editor: 'editor' },
};
const PROJECTS = {
    p1: { id: 'p1', name: 'Launch', kind: 'workspace', ownerId: 'u_owner', organizationId: 'org1' },
    sol: { id: 'sol', name: 'Invoices', kind: 'solution', ownerId: 'u_owner', organizationId: 'org1' },
};
const ORDER = { viewer: 0, editor: 1, owner: 2 };

// ── Recording fakes ───────────────────────────────────────────────────
const rec = { files: [], chats: [], activity: [], events: [], transients: [], signals: [] };
let publishFails = false;
let doneWith = null;
const reset = () => {
    for (const k of Object.keys(rec)) rec[k].length = 0;
    publishFails = false; doneWith = null;
};

const projectFiles = {
    async fileContent(project, fileId) {
        rec.files.push(['content', project.id, fileId]);
        return fileId === FILE_ID ? { file: { id: fileId, name: 'plan.pdf', status: 'ready' }, content: 'Processed text', available: true } : null;
    },
    async listFiles(project) {
        rec.files.push(['list', project.id]);
        return { files: [{ id: FILE_ID, name: 'plan.pdf', status: 'ready' }], kbId: 'kb_files' };
    },
    async addFile(project, upload, { userId }) {
        rec.files.push(['add', project.id, upload.originalname, upload.size, userId]);
        const file = { id: FILE_ID, name: upload.originalname, status: 'processing', uploadedBy: userId };
        return {
            file,
            start: ({ onDone } = {}) => {
                rec.files.push(['start', file.id]);
                doneWith = () => onDone && onDone('ready');
                return Promise.resolve();
            },
        };
    },
    async removeFile(project, fileId, { userId }) {
        rec.files.push(['remove', project.id, fileId, userId]);
        return fileId === FILE_ID ? { id: fileId, name: 'plan.pdf' } : null;
    },
};

const router = makeWorkspaceRouter({
    requireProjectRole: (minRole) => function requireProjectRoleMw(req, res, next) {
        const userId = req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });
        const role = ROLES[req.params.id]?.[userId];
        if (!role) return res.status(404).json({ error: 'Not found' });
        if (ORDER[role] < ORDER[minRole]) return res.status(403).json({ error: 'Insufficient permissions' });
        req.projectRole = role;
        return next();
    },
    getProject: async (id) => PROJECTS[id] || null,
    projectFiles,
    myChats: {
        async list(userId, projectId, opts) {
            rec.chats.push([userId, projectId, opts]);
            return [{ id: 'c1', type: 'direct', agentId: null, title: 'Mine', updatedAt: '2026-09-01', shared: false }];
        },
    },
    logActivity: async (...a) => { rec.activity.push(a); },
    emitProjectEvent: async (projectId, ev) => { rec.events.push([projectId, ev]); },
    publishTransient: async (projectId, ev) => {
        if (publishFails) throw new Error('bus down');
        rec.transients.push([projectId, ev]);
    },
    uploadLimiter: function rateLimitMiddleware(req, res, next) { next(); },
    presenceLimiter: function rateLimitMiddleware(req, res, next) { next(); },
    signalProjectChanged: (project, reason) => { rec.signals.push([project.id, reason]); },
    maxFileBytes: 64,
    log: { info() {}, warn() {}, error() {} },
});

// ── A real app around it: session from a header, the terminal handler ──
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
    const who = req.headers['x-test-user'];
    req.session = who && who !== 'none' ? { isAuthenticated: true, user: JSON.parse(who) } : {};
    next();
});
app.use('/api/projects', router);
app.use(terminalErrorHandler);
const server = http.createServer(app);
const ready = new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
test.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
test.beforeEach(reset);

async function call(method, url, { user = VIEWER, body, form } = {}) {
    await ready;
    const headers = { 'x-test-user': user === null ? 'none' : JSON.stringify(user) };
    let payload;
    if (form) payload = form;
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method, headers, body: payload });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text };
}

const formWith = (...files) => {
    const form = new FormData();
    for (const [field, content, name, type = 'text/plain'] of files) form.append(field, new Blob([content], { type }), name);
    return form;
};

// ── GET /:id/files ────────────────────────────────────────────────────

test('a viewer lists the project files', async () => {
    const res = await call('GET', '/api/projects/p1/files');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { files: [{ id: FILE_ID, name: 'plan.pdf', status: 'ready' }], kbId: 'kb_files' });
});

test('listing files: no session 401, not a member 404, an unknown query key 400 — none reach the service', async () => {
    assert.strictEqual((await call('GET', '/api/projects/p1/files', { user: null })).status, 401);
    assert.strictEqual((await call('GET', '/api/projects/p1/files', { user: STRANGER })).status, 404);
    assert.strictEqual((await call('GET', '/api/projects/nope/files', { user: OWNER })).status, 404);
    assertRefused(assert, await call('GET', '/api/projects/p1/files?kind=pdf'), 'query', /does not take "kind"/);
    assert.deepStrictEqual(rec.files, []);
});

// ── POST /:id/files ───────────────────────────────────────────────────

test('an editor uploads a file: 201 processing, announced, then processed', async () => {
    const res = await call('POST', '/api/projects/p1/files', { user: EDITOR, form: formWith(['file', 'The launch is in May.', 'plan.txt']) });
    assert.strictEqual(res.status, 201, res.text);
    assert.deepStrictEqual(res.body.file, { id: FILE_ID, name: 'plan.txt', status: 'processing', uploadedBy: 'u_editor' });
    assert.deepStrictEqual(rec.files, [['add', 'p1', 'plan.txt', 21, 'u_editor'], ['start', FILE_ID]]);

    // The id only: a file name can be personal data, and the activity row
    // outlives the file. The feed names it when it is read.
    assert.deepStrictEqual(rec.activity, [['p1', 'u_editor', 'file.added', { targetType: 'file', targetId: FILE_ID }]]);
    const [, ev] = rec.events[0];
    assert.strictEqual(ev.kind, 'file.added');
    assert.strictEqual(ev.targetId, FILE_ID);
    assert.ok(!JSON.stringify(rec.events).includes('plan.txt'), 'the name is in no event either');

    assert.deepStrictEqual(rec.signals, [], 'nothing for the compliance checks to read until it is processed');
    await doneWith();
    assert.deepStrictEqual(rec.transients, [['p1', {
        kind: 'file.processed', actorId: 'u_editor', targetType: 'file', targetId: FILE_ID,
        payload: { fileId: FILE_ID, status: 'ready' },
    }]]);
    assert.deepStrictEqual(rec.signals, [['p1', 'files']], 'a processed upload is re-checked (ids only)');
});

test('a file name keeps its accents', async () => {
    const res = await call('POST', '/api/projects/p1/files', { user: OWNER, form: formWith(['file', 'Inhalt', 'Überblick.txt']) });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.file.name, 'Überblick.txt');
});

test('uploading: a viewer 403, a stranger 404, no session 401 — nothing reaches the service', async () => {
    const form = () => formWith(['file', 'text', 'a.txt']);
    assert.strictEqual((await call('POST', '/api/projects/p1/files', { user: VIEWER, form: form() })).status, 403);
    assert.strictEqual((await call('POST', '/api/projects/p1/files', { user: STRANGER, form: form() })).status, 404);
    assert.strictEqual((await call('POST', '/api/projects/p1/files', { user: null, form: form() })).status, 401);
    assert.deepStrictEqual(rec.files, []);
    assert.deepStrictEqual(rec.events, []);
});

test('uploading: no file, an empty file, too large, two files, an extra field — refused in words', async () => {
    const none = await call('POST', '/api/projects/p1/files', { user: EDITOR, body: {} });
    assert.strictEqual(none.status, 400);
    assert.strictEqual(none.body.code, 'no_file');

    const empty = await call('POST', '/api/projects/p1/files', { user: EDITOR, form: formWith(['file', '', 'empty.txt']) });
    assert.strictEqual(empty.status, 400);
    assert.strictEqual(empty.body.code, 'empty_file');

    const big = await call('POST', '/api/projects/p1/files', { user: EDITOR, form: formWith(['file', 'x'.repeat(65), 'big.txt']) });
    assert.strictEqual(big.status, 413);
    assert.match(big.body.error, /at most 20 MB/);

    const two = await call('POST', '/api/projects/p1/files', { user: EDITOR, form: formWith(['file', 'a', 'a.txt'], ['file', 'b', 'b.txt']) });
    assert.strictEqual(two.status, 400);
    assert.strictEqual(two.body.code, 'one_file');

    const wrongField = await call('POST', '/api/projects/p1/files', { user: EDITOR, form: formWith(['upload', 'a', 'a.txt']) });
    assert.strictEqual(wrongField.status, 400);
    assert.strictEqual(wrongField.body.code, 'one_file');

    const withField = formWith(['file', 'a', 'a.txt']);
    withField.append('name', 'renamed');
    const extra = await call('POST', '/api/projects/p1/files', { user: EDITOR, form: withField });
    assert.strictEqual(extra.status, 400);
    assert.strictEqual(extra.body.code, 'unexpected_field');

    assert.deepStrictEqual(rec.files, []);
});

test('a Studio Solution takes no project files', async () => {
    const res = await call('POST', '/api/projects/sol/files', { user: EDITOR, form: formWith(['file', 'text', 'a.txt']) });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, 'SOLUTION_HOLDS_NO_FILES');
    assert.deepStrictEqual(rec.files, []);
});

// ── DELETE /:id/files/:fileId ─────────────────────────────────────────

test('an editor removes a file; it is logged and announced', async () => {
    const res = await call('DELETE', `/api/projects/p1/files/${FILE_ID}`, { user: EDITOR });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { success: true });
    assert.deepStrictEqual(rec.files, [['remove', 'p1', FILE_ID, 'u_editor']]);
    assert.deepStrictEqual(rec.activity, [['p1', 'u_editor', 'file.removed', { targetType: 'file', targetId: FILE_ID }]]);
    assert.strictEqual(rec.events[0][1].kind, 'file.removed');
    assert.ok(!JSON.stringify(rec.events).includes('plan.pdf'), 'the removed file\'s name is kept nowhere');
    assert.deepStrictEqual(rec.signals, [['p1', 'files']]);
});

test('removing a file that is not in the project is a 404 and announces nothing', async () => {
    const res = await call('DELETE', '/api/projects/p1/files/44444444-4444-4444-8444-444444444444', { user: EDITOR });
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.code, 'file_not_found');
    assert.deepStrictEqual(rec.events, []);
});

test('removing: a viewer 403, a stranger 404, a malformed id 400 — none reach the service', async () => {
    assert.strictEqual((await call('DELETE', `/api/projects/p1/files/${FILE_ID}`, { user: VIEWER })).status, 403);
    assert.strictEqual((await call('DELETE', `/api/projects/p1/files/${FILE_ID}`, { user: STRANGER })).status, 404);
    assertRefused(assert, await call('DELETE', '/api/projects/p1/files/not-a-file', { user: EDITOR }), 'params.fileId', /one of this project's files/);
    assert.deepStrictEqual(rec.files, []);
});

// ── GET /:id/my-chats ─────────────────────────────────────────────────

test('my chats: the caller\'s own list, for the caller', async () => {
    const res = await call('GET', '/api/projects/p1/my-chats?limit=20', { user: VIEWER });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.chats[0].id, 'c1');
    assert.deepStrictEqual(rec.chats, [['u_viewer', 'p1', { limit: 20 }]]);
});

test('my chats: a stranger 404, a bad limit 400 — the list is never read', async () => {
    assert.strictEqual((await call('GET', '/api/projects/p1/my-chats', { user: STRANGER })).status, 404);
    assertRefused(assert, await call('GET', '/api/projects/p1/my-chats?limit=0'), 'query.limit', /whole number from 1 to 200/);
    assertRefused(assert, await call('GET', '/api/projects/p1/my-chats?type=agent'), 'query', /does not take "type"/);
    assert.deepStrictEqual(rec.chats, []);
});

// ── POST /:id/presence ────────────────────────────────────────────────

test('presence: a transient presence.online for the caller', async () => {
    const res = await call('POST', '/api/projects/p1/presence', { user: VIEWER, body: {} });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { ok: true });
    assert.deepStrictEqual(rec.transients, [['p1', { kind: 'presence.online', actorId: 'u_viewer' }]]);
    assert.deepStrictEqual(rec.events, [], 'presence is never a durable event');
});

test('presence: a stranger 404, a body with fields 400 — nothing is published', async () => {
    assert.strictEqual((await call('POST', '/api/projects/p1/presence', { user: STRANGER, body: {} })).status, 404);
    assertRefused(assert, await call('POST', '/api/projects/p1/presence', { body: { actorId: 'u_owner' } }), 'body', /does not take "actorId"/);
    assert.deepStrictEqual(rec.transients, []);
});

test('presence never fails a request over the bus', async () => {
    publishFails = true;
    const res = await call('POST', '/api/projects/p1/presence', { user: VIEWER });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { ok: false });
});

test('every /:id route carries the role gate first', () => {
    for (const layer of router.stack.filter(l => l.route)) {
        const names = layer.route.stack.map(s => s.name);
        assert.strictEqual(names[0], 'requireProjectRoleMw', `${Object.keys(layer.route.methods)} ${layer.route.path}: ${names}`);
    }
});


test('source content is viewer-readable only inside the current project', async () => {
    const path = `/api/projects/p1/files/${FILE_ID}/content`;
    const result = await call('GET', path);
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.body.content, 'Processed text');
    reset();
    assert.strictEqual((await call('GET', path, { user: STRANGER })).status, 404);
    assert.strictEqual(rec.files.length, 0);
    assert.strictEqual((await call('GET', '/api/projects/p1/files/44444444-4444-4444-8444-444444444444/content')).status, 404);
});
